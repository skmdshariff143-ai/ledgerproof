import express from "express";
import { audit } from "./audit.js";
import { allowRoles, authenticate, deny, login } from "./auth.js";
import { inTransaction } from "./db.js";
import { fail, HTTP_STATUS, UUID } from "./errors.js";
import { transfer } from "./transfer.js";

const ALL_ROLES = ["admin", "account_holder", "auditor"];
const ACCOUNT_COLUMNS = "id, account_number, account_type, owner_id, status, balance_paise::text AS balance_paise, created_at";

function requireUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw fail("INVALID_INPUT", `${name} must be a lowercase UUID`);
}

async function findAccount(db, id) {
  const { rows } = await db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export function createApp(pool, { jwtSecret }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  // Deny by default: every route except login must name the roles allowed to call it.
  const route = (method, path, roles, handler) =>
    app[method](path, authenticate(pool, jwtSecret), allowRoles(pool, roles), handler);

  // Runs a state-changing handler and records any failure other than an already-audited denial.
  async function audited(req, action, target, work) {
    try {
      return await work();
    } catch (err) {
      if (err.code !== "FORBIDDEN") {
        // If the audit write itself fails, log that, but still report the original error.
        await audit(pool, { actor: req.user, action, target, ip: req.ip, details: { code: err.code ?? "INTERNAL" }, outcome: "error" })
          .catch((auditErr) => console.error("audit write failed", auditErr));
      }
      throw err;
    }
  }

  app.post("/api/auth/login", async (req, res) => {
    res.json({ token: await login(pool, jwtSecret, req.body ?? {}, req.ip) });
  });

  route("get", "/api/me", ALL_ROLES, (req, res) => {
    res.json({ user: req.user });
  });

  route("get", "/api/accounts", ALL_ROLES, async (req, res) => {
    const { rows } = req.user.role === "account_holder"
      ? await pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE owner_id = $1 ORDER BY created_at`, [req.user.id])
      : await pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at`);
    res.json({ accounts: rows });
  });

  route("get", "/api/accounts/:id/statement", ALL_ROLES, async (req, res) => {
    const target = `account:${req.params.id}`;
    requireUuid(req.params.id, "account id");
    const account = await findAccount(pool, req.params.id);
    // A missing account and someone else's account look the same, so ids cannot be probed.
    if (req.user.role === "account_holder" && account?.owner_id !== req.user.id) {
      await deny(pool, req, "read_statement", target);
    }
    if (!account) throw fail("ACCOUNT_NOT_FOUND", "account not found");
    const { rows } = await pool.query(
      `SELECT e.id, e.transaction_id, t.type, e.direction, e.amount_paise::text AS amount_paise,
              e.running_balance_paise::text AS running_balance_paise, e.created_at
         FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1 ORDER BY e.id`,
      [account.id],
    );
    await audit(pool, { actor: req.user, action: "read_statement", target, ip: req.ip, outcome: "success" });
    res.json({ account, entries: rows });
  });

  route("post", "/api/transactions/transfer", ["account_holder"], async (req, res) => {
    const { fromAccountId, toAccountId, amountPaise } = req.body ?? {};
    const target = `account:${fromAccountId}`;
    const result = await audited(req, "transfer", target, async () => {
      requireUuid(fromAccountId, "fromAccountId");
      // owner_id can never change (accounts_guard), so checking it before the transfer is safe.
      const source = await findAccount(pool, fromAccountId);
      if (source?.owner_id !== req.user.id) await deny(pool, req, "transfer", target);
      // Paying the vault is a withdrawal; it must go through the withdrawal rules, not this route.
      if (UUID.test(toAccountId ?? "") && (await findAccount(pool, toAccountId))?.account_type === "system_vault") {
        throw fail("INVALID_INPUT", "transfers must go to a user account");
      }
      return transfer(pool, {
        actor: req.user,
        ip: req.ip,
        from: fromAccountId,
        to: toAccountId,
        amountPaise,
        idempotencyKey: req.get("Idempotency-Key"),
      });
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  route("post", "/api/accounts", ["admin"], async (req, res) => {
    const { ownerId } = req.body ?? {};
    const account = await audited(req, "create_account", `user:${ownerId}`, () => {
      requireUuid(ownerId, "ownerId");
      return inTransaction(pool, async (client) => {
        const owner = await client.query("SELECT role FROM users WHERE id = $1", [ownerId]);
        if (owner.rows[0]?.role !== "account_holder") throw fail("INVALID_INPUT", "owner must be an account holder");
        const { rows } = await client.query(
          `INSERT INTO accounts (account_type, owner_id) VALUES ('user_checking', $1) RETURNING ${ACCOUNT_COLUMNS}`,
          [ownerId],
        );
        await audit(client, { actor: req.user, action: "create_account", target: `account:${rows[0].id}`, ip: req.ip, details: { ownerId }, outcome: "success" });
        return rows[0];
      });
    });
    res.status(201).json({ account });
  });

  for (const [action, status] of [["freeze", "frozen"], ["unfreeze", "active"]]) {
    route("post", `/api/accounts/:id/${action}`, ["admin"], async (req, res) => {
      const target = `account:${req.params.id}`;
      const account = await audited(req, action, target, () => {
        requireUuid(req.params.id, "account id");
        return inTransaction(pool, async (client) => {
          // Only user accounts: freezing the vault would stop every deposit.
          const { rows } = await client.query(
            `UPDATE accounts SET status = $2 WHERE id = $1 AND account_type = 'user_checking' RETURNING ${ACCOUNT_COLUMNS}`,
            [req.params.id, status],
          );
          if (rows.length === 0) throw fail("ACCOUNT_NOT_FOUND", "user account not found");
          await audit(client, { actor: req.user, action, target, ip: req.ip, outcome: "success" });
          return rows[0];
        });
      });
      res.json({ account });
    });
  }

  route("get", "/api/audit-logs", ["admin", "auditor"], async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, actor_user_id, actor_role, action, target, ip, details, outcome, created_at
         FROM audit_log ORDER BY id DESC LIMIT 200`,
    );
    await audit(pool, { actor: req.user, action: "read_audit_log", ip: req.ip, outcome: "success" });
    res.json({ entries: rows });
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no such route" } });
  });

  app.use((err, req, res, next) => {
    // Malformed or oversized JSON bodies, reported by express.json().
    if (err.type && err.status >= 400 && err.status < 500) {
      return res.status(400).json({ error: { code: "INVALID_INPUT", message: "request body must be valid JSON under 10kb" } });
    }
    const status = HTTP_STATUS[err.code];
    if (status) return res.status(status).json({ error: { code: err.code, message: err.message } });
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL", message: "internal error" } });
  });

  return app;
}
