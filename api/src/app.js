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

  // owner_id can never change (accounts_guard), so checking it before the money moves is safe.
  // A missing account gets the same 403 as someone else's.
  async function requireOwnAccount(req, accountId, action) {
    requireUuid(accountId, "account id");
    const account = await findAccount(pool, accountId);
    if (account?.owner_id !== req.user.id) await deny(pool, req, action, `account:${accountId}`);
  }

  async function vaultId() {
    const { rows } = await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'");
    return rows[0].id;
  }

  const moveMoney = (req, from, to, amountPaise) =>
    transfer(pool, { actor: req.user, ip: req.ip, from, to, amountPaise, idempotencyKey: req.get("Idempotency-Key") });

  // Every money route is audited and idempotent. A replay answers exactly like the first
  // call (201, same body); only the Idempotent-Replayed header and its own audit row differ.
  function moneyRoute(path, roles, action, targetAccountOf, work) {
    route("post", path, roles, async (req, res) => {
      const body = req.body ?? {};
      const target = `account:${targetAccountOf(body)}`;
      const result = await audited(req, action, target, () => work(req, body));
      if (result.replayed) {
        // The payment already committed; a failing audit write must not turn that into a 500.
        await audit(pool, { actor: req.user, action, target, ip: req.ip, details: { transactionId: result.transactionId, replayed: true }, outcome: "success" })
          .catch((auditErr) => console.error("audit write failed", auditErr));
        res.set("Idempotent-Replayed", "true");
      }
      res.status(201).json({ transactionId: result.transactionId });
    });
  }

  moneyRoute("/api/transactions/transfer", ["account_holder"], "transfer", (b) => b.fromAccountId, async (req, b) => {
    await requireOwnAccount(req, b.fromAccountId, "transfer");
    // Paying the vault is a withdrawal; it must go through the withdrawal route, not this one.
    if (UUID.test(b.toAccountId ?? "") && (await findAccount(pool, b.toAccountId))?.account_type === "system_vault") {
      throw fail("INVALID_INPUT", "transfers must go to a user account");
    }
    return moveMoney(req, b.fromAccountId, b.toAccountId, b.amountPaise);
  });

  // Deposits are money entering the system, so only an admin can create them; the vault pays.
  moneyRoute("/api/transactions/deposit", ["admin"], "deposit", (b) => b.toAccountId, async (req, b) => {
    requireUuid(b.toAccountId, "toAccountId");
    return moveMoney(req, await vaultId(), b.toAccountId, b.amountPaise);
  });

  moneyRoute("/api/transactions/withdraw", ["account_holder"], "withdraw", (b) => b.fromAccountId, async (req, b) => {
    await requireOwnAccount(req, b.fromAccountId, "withdraw");
    return moveMoney(req, b.fromAccountId, await vaultId(), b.amountPaise);
  });

  route("get", "/api/ledger/reconcile", ["admin", "auditor"], async (req, res) => {
    const report = await inTransaction(pool, async (client) => {
      // One snapshot for every check, so transfers committing meanwhile cannot cause false alarms.
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const totals = (await client.query(
        `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0)::text AS debits_paise,
                COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)::text AS credits_paise,
                count(*)::int AS entries
           FROM ledger_entries`,
      )).rows[0];
      // Starts from transactions, so one with no ledger rows at all is reported too.
      const unbalanced = await client.query(
        `SELECT t.id AS transaction_id FROM transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
          GROUP BY t.id
         HAVING count(e.id) = 0
             OR SUM(CASE e.direction WHEN 'debit' THEN e.amount_paise ELSE -e.amount_paise END) <> 0`,
      );
      const accounts = await client.query(
        `SELECT a.id, a.account_number, a.account_type, a.balance_paise::text AS stored_paise,
                COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_paise ELSE -e.amount_paise END), 0)::text AS ledger_paise,
                (SELECT running_balance_paise FROM ledger_entries WHERE account_id = a.id ORDER BY id DESC LIMIT 1)::text AS last_running_paise
           FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          GROUP BY a.id ORDER BY a.account_number`,
      );
      return { totals, unbalanced: unbalanced.rows, accounts: accounts.rows };
    });
    const problems = [
      ...report.unbalanced.map((r) => ({ type: "unbalanced_transaction", transactionId: r.transaction_id })),
      ...report.accounts.flatMap((a) => [
        a.stored_paise !== a.ledger_paise && { type: "balance_mismatch", accountId: a.id, storedPaise: a.stored_paise, ledgerPaise: a.ledger_paise },
        a.last_running_paise !== null && a.last_running_paise !== a.stored_paise &&
          { type: "running_balance_mismatch", accountId: a.id, storedPaise: a.stored_paise, lastRunningPaise: a.last_running_paise },
        a.account_type === "user_checking" && BigInt(a.stored_paise) < 0n &&
          { type: "negative_user_balance", accountId: a.id, storedPaise: a.stored_paise },
      ].filter(Boolean)),
    ];
    const balanced = report.totals.debits_paise === report.totals.credits_paise && problems.length === 0;
    await audit(pool, { actor: req.user, action: "reconcile", ip: req.ip, details: { balanced, problems: problems.length }, outcome: "success" });
    res.json({ balanced, totals: report.totals, accountsChecked: report.accounts.length, problems });
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
