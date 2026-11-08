import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
const schemaSql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
let db;

before(async () => {
  // These tests wipe the database, so refuse anything not named *_test.
  assert.ok(url && new URL(url).pathname.endsWith("_test"), "DATABASE_URL must point to a *_test database");
  db = new pg.Client({ connectionString: url });
  await db.connect();
});

after(() => db.end());

beforeEach(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.query(schemaSql);
});

async function newAccounts() {
  const a = await db.query("INSERT INTO accounts (name) VALUES ('A') RETURNING id");
  const b = await db.query("INSERT INTO accounts (name) VALUES ('B') RETURNING id");
  return [a.rows[0].id, b.rows[0].id];
}

async function postEntries(entries) {
  await db.query("BEGIN");
  try {
    const t = await db.query("INSERT INTO transactions DEFAULT VALUES RETURNING id");
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
  await db.query("INSERT INTO audit_log (actor, action) VALUES ('tester', 'login')");
  await assert.rejects(db.query("UPDATE audit_log SET actor = 'someone else'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM audit_log"), /append-only/);
});

test("THREAT double payment: the same idempotency key cannot be used twice", async () => {
  const [a, b] = await newAccounts();
  const t1 = await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  const t2 = await postEntries([[a, "debit", 500], [b, "credit", 500]]);
  await db.query("INSERT INTO idempotency_keys (key, request_hash, transaction_id) VALUES ('k1', 'h', $1)", [t1]);
  await assert.rejects(
    db.query("INSERT INTO idempotency_keys (key, request_hash, transaction_id) VALUES ('k1', 'h', $1)", [t2]),
    /duplicate key/,
  );
});
