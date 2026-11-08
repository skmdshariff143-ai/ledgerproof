import { createHash } from "node:crypto";
import { audit } from "./audit.js";
import { fail, UUID } from "./errors.js";

const UNIQUE_VIOLATION = "23505";
const MAX_KEY_LENGTH = 200;

function validate({ actor, from, to, amountPaise, idempotencyKey }) {
  if (!UUID.test(actor?.id ?? "")) throw fail("INVALID_INPUT", "actor is required");
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
  const earlier = await findExisting(client, idempotencyKey, requestHash);
  if (earlier) return earlier;
  if (source.status !== "active") throw fail("ACCOUNT_FROZEN", "account is frozen");
  // Funds are checked before the destination's status, so an under-funded request cannot
  // be used to learn whether someone else's account is frozen.
  if (source.account_type !== "system_vault" && !source.has_funds) {
    throw fail("INSUFFICIENT_FUNDS", "insufficient funds");
  }
  if (destination.status !== "active") throw fail("ACCOUNT_FROZEN", "account is frozen");
  const tx = await client.query(
    "INSERT INTO transactions (type, initiated_by) VALUES ($1, $2) RETURNING id",
    [transactionType(source, destination), actor.id],
  );
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
  await audit(client, {
    actor,
    action: "transfer",
    target: `account:${from}`,
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
