import { createHash } from "node:crypto";

const UNIQUE_VIOLATION = "23505";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_KEY_LENGTH = 200;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function validate({ actor, from, to, amountPaise, idempotencyKey }) {
  if (typeof actor !== "string" || actor === "") throw fail("INVALID_INPUT", "actor is required");
  if (typeof idempotencyKey !== "string" || idempotencyKey === "" || idempotencyKey.length > MAX_KEY_LENGTH) {
    throw fail("INVALID_INPUT", `idempotencyKey is required, at most ${MAX_KEY_LENGTH} characters`);
  }
  if (!UUID.test(from) || !UUID.test(to)) throw fail("INVALID_INPUT", "account ids must be lowercase UUIDs");
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw fail("INVALID_INPUT", "amountPaise must be a positive integer");
  if (from === to) throw fail("INVALID_INPUT", "from and to must differ");
}

// Same key + same payload must give the same hash; a different payload must not.
function hashRequest({ from, to, amountPaise }) {
  return createHash("sha256").update(JSON.stringify([from, to, amountPaise])).digest("hex");
}

async function findExisting(client, key, requestHash) {
  const { rows } = await client.query(
    "SELECT request_hash, transaction_id FROM idempotency_keys WHERE key = $1",
    [key],
  );
  if (rows.length === 0) return null;
  if (rows[0].request_hash !== requestHash) throw fail("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request");
  return { transactionId: rows[0].transaction_id, replayed: true };
}

// Locks the source account so two spends cannot both read the same balance.
// FOR NO KEY UPDATE (not FOR UPDATE) so it does not clash with the foreign-key
// check on the destination row; otherwise A->B and B->A at once would deadlock.
async function lockSource(client, from) {
  const { rows } = await client.query(
    "SELECT allow_negative FROM accounts WHERE id = $1 FOR NO KEY UPDATE",
    [from],
  );
  if (rows.length === 0) throw fail("ACCOUNT_NOT_FOUND", "source account not found");
  return rows[0];
}

async function requireAccount(client, id) {
  const { rows } = await client.query("SELECT 1 FROM accounts WHERE id = $1", [id]);
  if (rows.length === 0) throw fail("ACCOUNT_NOT_FOUND", "destination account not found");
}

// Compared in SQL so large bigint balances never pass through a JS Number.
async function hasFunds(client, accountId, amountPaise) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_paise ELSE -amount_paise END), 0) >= $2 AS ok
       FROM ledger_entries WHERE account_id = $1`,
    [accountId, amountPaise],
  );
  return rows[0].ok;
}

async function post(client, { actor, from, to, amountPaise, idempotencyKey }, requestHash) {
  const { allow_negative } = await lockSource(client, from);
  // A parallel request with the same key may have committed while we waited for the lock.
  const earlier = await findExisting(client, idempotencyKey, requestHash);
  if (earlier) return earlier;
  await requireAccount(client, to);
  if (!allow_negative && !(await hasFunds(client, from, amountPaise))) {
    throw fail("INSUFFICIENT_FUNDS", "insufficient funds");
  }
  const tx = await client.query("INSERT INTO transactions DEFAULT VALUES RETURNING id");
  const transactionId = tx.rows[0].id;
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise)
     VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`,
    [transactionId, from, to, amountPaise],
  );
  // The key row is the last write, so a losing concurrent request fails here and rolls back everything.
  await client.query(
    "INSERT INTO idempotency_keys (key, request_hash, transaction_id) VALUES ($1, $2, $3)",
    [idempotencyKey, requestHash, transactionId],
  );
  await client.query(
    "INSERT INTO audit_log (actor, action, details) VALUES ($1, 'transfer', $2)",
    [actor, JSON.stringify({ transactionId, from, to, amountPaise, idempotencyKey })],
  );
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
// `pool` is a pg.Pool. Throws errors carrying a `code`.
export async function transfer(pool, request) {
  validate(request);
  const requestHash = hashRequest(request);
  const client = await pool.connect();
  let broken = false;
  try {
    const earlier = await findExisting(client, request.idempotencyKey, requestHash);
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
      const winner = await findExisting(client, request.idempotencyKey, requestHash);
      if (!winner) throw err;
      return winner;
    }
  } finally {
    client.release(broken);
  }
}
