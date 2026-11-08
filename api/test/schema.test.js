import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
const schemaSql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
let db;

before(async () => {
  // These tests wipe the database, so refuse anything not named *_test.
  assert.ok(url && new URL(url).pathname.endsWith("_test"), "TEST_DATABASE_URL must point to a *_test database");
  db = new pg.Client({ connectionString: url });
  await db.connect();
});

after(() => db.end());

beforeEach(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.query(schemaSql);
});

async function vaultId() {
  const { rows } = await db.query("SELECT id FROM accounts WHERE account_type = 'system_vault'");
  return rows[0].id;
}

async function userAccount(email) {
  const user = await db.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, 'not-a-real-hash', 'account_holder') RETURNING id",
    [email],
  );
  const { rows } = await db.query(
    "INSERT INTO accounts (account_number, account_type, owner_id) VALUES ($1, 'user_checking', $2) RETURNING id",
    [email, user.rows[0].id],
  );
  return rows[0].id;
}

// The vault funds user B, so money in every test comes from somewhere.
async function newAccounts() {
  return [await vaultId(), await userAccount("b@test.local")];
}

async function postEntries(entries) {
  await db.query("BEGIN");
  try {
    const t = await db.query("INSERT INTO transactions (type, initiated_by) VALUES ('transfer', (SELECT id FROM users LIMIT 1)) RETURNING id");
    for (const [accountId, direction, amount] of entries) {
      await db.query(
        "INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise) VALUES ($1,$2,$3,$4)",
        [t.rows[0].id, accountId, direction, amount],
      );
    }
    await db.query("COMMIT");
    return t.rows[0].id;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

test("a balanced transaction commits", async () => {
  const [a, b] = await newAccounts();
  await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM ledger_entries");
  assert.equal(rows[0].n, 2);
});

test("THREAT unbalanced books: debits != credits is rejected at commit", async () => {
  const [a, b] = await newAccounts();
  await assert.rejects(postEntries([[a, "debit", 500], [b, "credit", 499]]), /not balanced/);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM ledger_entries");
  assert.equal(rows[0].n, 0);
});

test("THREAT bad amounts: zero or negative paise is rejected", async () => {
  const [a, b] = await newAccounts();
  await assert.rejects(postEntries([[a, "debit", 0], [b, "credit", 0]]));
  await assert.rejects(postEntries([[a, "debit", -5], [b, "credit", -5]]));
});

test("THREAT tampering: ledger entries cannot be updated or deleted", async () => {
  const [a, b] = await newAccounts();
  await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  await assert.rejects(db.query("UPDATE ledger_entries SET amount_paise = 1"), /append-only/);
  await assert.rejects(db.query("DELETE FROM ledger_entries"), /append-only/);
  await assert.rejects(db.query("TRUNCATE ledger_entries"), /append-only/);
});

test("THREAT tampering: audit log cannot be updated or deleted", async () => {
  await db.query("INSERT INTO audit_log (action, outcome) VALUES ('login', 'success')");
  await assert.rejects(db.query("UPDATE audit_log SET outcome = 'denied'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM audit_log"), /append-only/);
});

test("THREAT double payment: the same idempotency key cannot be used twice", async () => {
  const [a, b] = await newAccounts();
  const t1 = await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  const t2 = await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  await db.query("INSERT INTO idempotency_keys (user_id, key, request_hash, transaction_id) VALUES ((SELECT id FROM users LIMIT 1), 'k1', 'h', $1)", [t1]);
  await assert.rejects(
    db.query("INSERT INTO idempotency_keys (user_id, key, request_hash, transaction_id) VALUES ((SELECT id FROM users LIMIT 1), 'k1', 'h', $1)", [t2]),
    /duplicate key/,
  );
});

test("THREAT tampering: idempotency keys and transactions are append-only", async () => {
  const [a, b] = await newAccounts();
  const t = await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  await db.query("INSERT INTO idempotency_keys (user_id, key, request_hash, transaction_id) VALUES ((SELECT id FROM users LIMIT 1), 'k1', 'h', $1)", [t]);
  await assert.rejects(db.query("DELETE FROM idempotency_keys"), /append-only/);
  await assert.rejects(db.query("UPDATE transactions SET created_at = now()"), /append-only/);
  await assert.rejects(db.query("DELETE FROM transactions"), /append-only/);
});

test("THREAT slow lock: ledger_entries is indexed by account_id and transaction_id", async () => {
  const { rows } = await db.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'ledger_entries'");
  const defs = rows.map((r) => r.indexdef).join("\n");
  assert.match(defs, /\(account_id, id\)/);
  assert.match(defs, /\(transaction_id\)/);
});

test("THREAT overdraft at the database: entries that take a user account below zero are rejected", async () => {
  const [vault, b] = await newAccounts();
  const c = await userAccount("c@test.local");
  await postEntries([[vault, "debit", 500], [b, "credit", 500]]);
  await assert.rejects(postEntries([[b, "debit", 501], [c, "credit", 501]]), /user_balance_not_negative/);
  const { rows } = await db.query("SELECT balance_paise::int AS b FROM accounts WHERE id = $1", [b]);
  assert.equal(rows[0].b, 500);
});

test("THREAT balance forgery: balance_paise cannot be set directly or opened non-zero", async () => {
  const [, b] = await newAccounts();
  await assert.rejects(
    db.query("UPDATE accounts SET balance_paise = 1000000 WHERE id = $1", [b]),
    /only through ledger_entries/,
  );
  const owner = await db.query("SELECT owner_id FROM accounts WHERE id = $1", [b]);
  await assert.rejects(
    db.query(
      "INSERT INTO accounts (account_number, account_type, owner_id, balance_paise) VALUES ('X', 'user_checking', $1, 500)",
      [owner.rows[0].owner_id],
    ),
    /zero balance/,
  );
});

test("running balance is set by the database, even if the client sends a fake one", async () => {
  const [vault, b] = await newAccounts();
  await postEntries([[vault, "debit", 500], [b, "credit", 500]]);
  await db.query("BEGIN");
  const t = await db.query("INSERT INTO transactions (type, initiated_by) VALUES ('deposit', (SELECT id FROM users LIMIT 1)) RETURNING id");
  await db.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise, running_balance_paise)
     VALUES ($1, $2, 'debit', 200, 999999), ($1, $3, 'credit', 200, 999999)`,
    [t.rows[0].id, vault, b],
  );
  await db.query("COMMIT");
  const { rows } = await db.query(
    "SELECT running_balance_paise::int AS r FROM ledger_entries WHERE account_id = $1 ORDER BY id",
    [b],
  );
  assert.deepEqual(rows.map((r) => r.r), [500, 700]);
  const vaultRow = await db.query("SELECT balance_paise::int AS b FROM accounts WHERE id = $1", [vault]);
  assert.equal(vaultRow.rows[0].b, -700);
});

test("THREAT ownership change: account type, owner and number cannot be changed", async () => {
  const [vault, b] = await newAccounts();
  const other = await db.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('m@test.local', 'h', 'account_holder') RETURNING id",
  );
  await assert.rejects(db.query("UPDATE accounts SET owner_id = $1 WHERE id = $2", [other.rows[0].id, b]), /cannot be changed/);
  await assert.rejects(db.query("UPDATE accounts SET account_type = 'system_vault' WHERE id = $1", [b]), /cannot be changed/);
  await assert.rejects(db.query("UPDATE accounts SET account_number = 'Y' WHERE id = $1", [vault]), /cannot be changed/);
  await assert.rejects(db.query("DELETE FROM accounts WHERE id = $1", [vault]), /cannot be deleted/);
});

test("THREAT second vault, ownerless user account or unknown role: rejected by constraints", async () => {
  await assert.rejects(
    db.query("INSERT INTO accounts (account_number, account_type) VALUES ('VAULT-0002', 'system_vault')"),
    /accounts_single_vault/,
  );
  await assert.rejects(
    db.query("INSERT INTO accounts (account_number, account_type) VALUES ('U1', 'user_checking')"),
    /vault_has_no_owner/,
  );
  await assert.rejects(
    db.query("INSERT INTO users (email, password_hash, role) VALUES ('r@test.local', 'h', 'superuser')"),
    /users_role_check/,
  );
});

test("THREAT frozen account at the database: ledger entries on a frozen account are rejected", async () => {
  const [vault, b] = await newAccounts();
  await db.query("UPDATE accounts SET status = 'frozen' WHERE id = $1", [b]);
  await assert.rejects(postEntries([[vault, "debit", 100], [b, "credit", 100]]), /is frozen/);
});
