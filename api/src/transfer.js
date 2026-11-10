import { createHash } from "node:crypto";
import { audit } from "./audit.js";
import { fail, isUuid } from "./errors.js";

const UNIQUE_VIOLATION = "23505";
const MAX_KEY_LENGTH = 200;

// Checked before any account lookup, so malformed requests tell a caller nothing about which accounts exist.
export function validateAmountAndKey({ amountPaise, idempotencyKey }) {
  if (typeof idempotencyKey !== "string" || idempotencyKey === "" || idempotencyKey.length > MAX_KEY_LENGTH) {
    throw fail("INVALID_INPUT", `idempotencyKey is required, at most ${MAX_KEY_LENGTH} characters`);
  }
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw fail("INVALID_INPUT", "amountPaise must be a positive integer");
}

function validate({ actor, from, to, amountPaise, idempotencyKey }) {
  if (!isUuid(actor?.id)) throw fail("INVALID_INPUT", "actor is required");
  validateAmountAndKey({ amountPaise, idempotencyKey });
  if (!isUuid(from) || !isUuid(to)) throw fail("INVALID_INPUT", "account ids must be lowercase UUIDs");
  if (from === to) throw fail("INVALID_INPUT", "from and to must differ");
}

// Same user + key + payload must give the same hash; a different payload must not.
// The operation (deposit, withdraw, transfer) is fixed by which side is the vault, so from/to cover it.
function hashRequest({ actor, from, to, amountPaise }) {
  return createHash("sha256").update(JSON.stringify([actor.id, from, to, amountPaise])).digest("hex");
}

async function findExisting(client, { actor, idempotencyKey }, requestHash) {
  const { rows } = await client.query(
    "SELECT request_hash, transaction_id FROM idempotency_keys WHERE user_id = $1 AND key = $2",
    [actor.id, idempotencyKey],
  );
  if (rows.length === 0) return null;
  if (rows[0].request_hash !== requestHash) throw fail("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request");
  return { transactionId: rows[0].transaction_id, replayed: true };
}

// Locks both accounts in one statement, in ascending id order, so A->B and B->A
// running at once queue on the same first row instead of each holding one and
// waiting for the other. FOR NO KEY UPDATE matches the lock the balance UPDATE
// takes and does not block foreign-key checks.
// has_funds is compared in SQL so large bigint balances never pass through a JS Number.
async function lockAccounts(client, from, to, amountPaise) {
  const { rows } = await client.query(
    `SELECT id, account_type, status, balance_paise >= $2 AS has_funds
       FROM accounts WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR NO KEY UPDATE`,
    [[from, to], amountPaise],
  );
  const source = rows.find((row) => row.id === from);
  const destination = rows.find((row) => row.id === to);
  if (!source || !destination) throw fail("ACCOUNT_NOT_FOUND", "account not found");
  return { source, destination };
}

function transactionType(source, destination) {
  if (source.account_type === "system_vault") return "deposit";
  if (destination.account_type === "system_vault") return "withdrawal";
  return "transfer";
}

async function post(client, { actor, ip, from, to, amountPaise, idempotencyKey }, requestHash) {
  const { source, destination } = await lockAccounts(client, from, to, amountPaise);
  // A parallel request with the same key may have committed while we waited for the lock.
  const earlier = await findExisting(client, { actor, idempotencyKey }, requestHash);
  if (earlier) return earlier;
  const sourceStatus = source.status?.toLowerCase();
  const destStatus = destination.status?.toLowerCase();
  if (sourceStatus === "pending_kyc") throw fail("KYC_PENDING", "account is pending KYC approval");
  if (sourceStatus !== "active") throw fail("ACCOUNT_FROZEN", "account is frozen");
  // Funds are checked before the destination's status, so an under-funded request cannot
  // be used to learn whether someone else's account is frozen.
  if (source.account_type !== "system_vault" && !source.has_funds) {
    throw fail("INSUFFICIENT_FUNDS", "insufficient funds");
  }
  if (destStatus === "pending_kyc") throw fail("KYC_PENDING", "recipient account is pending KYC approval");
  if (destStatus !== "active") throw fail("ACCOUNT_FROZEN", "account is frozen");
  const type = transactionType(source, destination);
  const tx = await client.query(
    "INSERT INTO transactions (type, initiated_by) VALUES ($1, $2) RETURNING id",
    [type, actor.id],
  );
  const transactionId = tx.rows[0].id;
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise)
     VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`,
    [transactionId, from, to, amountPaise],
  );
  // The key row is the last write, so a losing concurrent request fails here and rolls back everything.
  await client.query(
    "INSERT INTO idempotency_keys (user_id, key, request_hash, transaction_id) VALUES ($1, $2, $3, $4)",
    [actor.id, idempotencyKey, requestHash, transactionId],
  );
  // Same action and target names the HTTP routes use for denials and failures,
  // so an auditor filtering by "deposit" sees successes and failures alike.
  await audit(client, {
    actor,
    action: { deposit: "deposit", withdrawal: "withdraw", transfer: "transfer" }[type],
    target: `account:${type === "deposit" ? to : from}`,
    ip,
    details: { transactionId, from, to, amountPaise, idempotencyKey },
    outcome: "success",
  });
  return { transactionId, replayed: false };
}

// A failed ROLLBACK means the connection is broken; report it so the caller discards the client.
async function rollback(client) {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

// Moves money between two accounts in one database transaction.
// `pool` is a pg.Pool; `actor` is { id, role } of the verified user. Throws errors carrying a `code`.
// It does not check who owns `from`: callers (the HTTP routes) must authorize first.
export async function transfer(pool, request) {
  validate(request);
  const requestHash = hashRequest(request);
  const client = await pool.connect();
  let broken = false;
  try {
    const earlier = await findExisting(client, request, requestHash);
    if (earlier) return earlier;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const result = await post(client, request, requestHash);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      broken = !(await rollback(client));
      if (err.code !== UNIQUE_VIOLATION) throw err;
      // Another request with this key committed first: return its result.
      const winner = await findExisting(client, request, requestHash);
      if (!winner) throw err;
      return winner;
    }
  } finally {
    client.release(broken);
  }
}
