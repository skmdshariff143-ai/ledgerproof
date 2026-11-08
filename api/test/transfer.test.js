import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { transfer } from "../src/transfer.js";

const url = process.env.DATABASE_URL;
const schemaSql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
let pool;
let treasury, alice, bob;

before(() => {
  // These tests wipe the database, so refuse anything not named *_test.
  assert.ok(url && new URL(url).pathname.endsWith("_test"), "DATABASE_URL must point to a *_test database");
  pool = new pg.Pool({ connectionString: url, max: 20 });
});

after(() => pool.end());

beforeEach(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(schemaSql);
  treasury = (await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'")).rows[0].id;
  alice = await userAccount("alice@test.local");
  bob = await userAccount("bob@test.local");
});

async function userAccount(email) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, 'not-a-real-hash', 'account_holder') RETURNING id",
    [email],
  );
  const { rows } = await pool.query(
    "INSERT INTO accounts (account_number, account_type, owner_id) VALUES ($1, 'user_checking', $2) RETURNING id",
    [email, user.rows[0].id],
  );
  return rows[0].id;
}

async function balance(id) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_paise ELSE -amount_paise END), 0)::int AS b
       FROM ledger_entries WHERE account_id = $1`,
    [id],
  );
  return rows[0].b;
}

async function count(table) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

const fund = (to, amountPaise, key) =>
  transfer(pool, { actor: "test", from: treasury, to, amountPaise, idempotencyKey: key });

test("a transfer moves money and writes balanced entries and an audit row", async () => {
  await fund(alice, 1000, "fund-1");
  const r = await transfer(pool, { actor: "u1", from: alice, to: bob, amountPaise: 400, idempotencyKey: "t-1" });
  assert.equal(r.replayed, false);
  assert.equal(await balance(alice), 600);
  assert.equal(await balance(bob), 400);
  assert.equal(await count("audit_log"), 2);
});

test("THREAT overdraft: spending more than the balance is rejected", async () => {
  await fund(alice, 1000, "fund-1");
  await assert.rejects(
    transfer(pool, { actor: "u1", from: alice, to: bob, amountPaise: 1001, idempotencyKey: "t-1" }),
    { code: "INSUFFICIENT_FUNDS" },
  );
  assert.equal(await balance(alice), 1000);
});

test("THREAT bad input: non-integer, zero, negative, same-account and unknown-account transfers are rejected", async () => {
  await fund(alice, 1000, "fund-1");
  const bad = (over) => transfer(pool, { actor: "u1", from: alice, to: bob, amountPaise: 100, idempotencyKey: "k", ...over });
  await assert.rejects(bad({ amountPaise: 1.5 }), { code: "INVALID_INPUT" });
  await assert.rejects(bad({ amountPaise: 0 }), { code: "INVALID_INPUT" });
  await assert.rejects(bad({ amountPaise: -100 }), { code: "INVALID_INPUT" });
  await assert.rejects(bad({ to: alice }), { code: "INVALID_INPUT" });
  await assert.rejects(bad({ idempotencyKey: "" }), { code: "INVALID_INPUT" });
  await assert.rejects(bad({ to: "00000000-0000-0000-0000-000000000000" }), { code: "ACCOUNT_NOT_FOUND" });
  assert.equal(await balance(alice), 1000);
});

test("THREAT double payment: replaying the same request returns the same transaction and moves money once", async () => {
  await fund(alice, 1000, "fund-1");
  const req = { actor: "u1", from: alice, to: bob, amountPaise: 400, idempotencyKey: "t-1" };
  const first = await transfer(pool, req);
  const second = await transfer(pool, req);
  assert.equal(second.replayed, true);
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(await balance(bob), 400);
});

test("THREAT key reuse: the same key with a different amount is rejected", async () => {
  await fund(alice, 1000, "fund-1");
  const base = { actor: "u1", from: alice, to: bob, idempotencyKey: "t-1" };
  await transfer(pool, { ...base, amountPaise: 400 });
  await assert.rejects(transfer(pool, { ...base, amountPaise: 500 }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(await balance(bob), 400);
});

test("THREAT concurrent double payment: 10 parallel requests with one key create one transaction", async () => {
  await fund(alice, 1000, "fund-1");
  const req = { actor: "u1", from: alice, to: bob, amountPaise: 400, idempotencyKey: "t-1" };
  const results = await Promise.all(Array.from({ length: 10 }, () => transfer(pool, req)));
  assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(await balance(alice), 600);
  assert.equal(await balance(bob), 400);
});

test("THREAT concurrent overdraft: 5 parallel spends of 300 from a 1000 balance let exactly 3 succeed", async () => {
  await fund(alice, 1000, "fund-1");
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      transfer(pool, { actor: "u1", from: alice, to: bob, amountPaise: 300, idempotencyKey: `t-${i}` }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "INSUFFICIENT_FUNDS"));
  assert.equal(await balance(alice), 100);
  assert.equal(await balance(bob), 900);
});

test("opposite-direction parallel transfers do not deadlock", async () => {
  await fund(alice, 1000, "fund-a");
  await fund(bob, 1000, "fund-b");
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(transfer(pool, { actor: "u", from: alice, to: bob, amountPaise: 10, idempotencyKey: `ab-${i}` }));
    jobs.push(transfer(pool, { actor: "u", from: bob, to: alice, amountPaise: 10, idempotencyKey: `ba-${i}` }));
  }
  await Promise.all(jobs);
  assert.equal((await balance(alice)) + (await balance(bob)), 2000);
});

test("THREAT retry race: parallel same-key requests on an exactly-sufficient balance all succeed or replay", async () => {
  await fund(alice, 100, "fund-1");
  const req = { actor: "u1", from: alice, to: bob, amountPaise: 100, idempotencyKey: "t-1" };
  const results = await Promise.all(Array.from({ length: 10 }, () => transfer(pool, req)));
  assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
  assert.equal(await balance(bob), 100);
});

test("THREAT isolation: overdraft is still blocked when the database default is REPEATABLE READ", async () => {
  const rr = new pg.Pool({ connectionString: url, max: 10 });
  rr.on("connect", (c) => c.query("SET default_transaction_isolation = 'repeatable read'"));
  try {
    await fund(alice, 1000, "fund-1");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        transfer(rr, { actor: "u1", from: alice, to: bob, amountPaise: 300, idempotencyKey: `t-${i}` }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal(await balance(alice), 100);
  } finally {
    await rr.end();
  }
});

test("THREAT malformed ids: bad UUIDs and case variants are rejected without leaking database errors", async () => {
  await fund(alice, 1000, "fund-1");
  const base = { actor: "u1", from: alice, to: bob, amountPaise: 100, idempotencyKey: "k" };
  await assert.rejects(transfer(pool, { ...base, to: "not-a-uuid" }), { code: "INVALID_INPUT" });
  await assert.rejects(transfer(pool, { ...base, to: alice.toUpperCase() }), { code: "INVALID_INPUT" });
  await assert.rejects(transfer(pool, { ...base, idempotencyKey: "x".repeat(201) }), { code: "INVALID_INPUT" });
});

test("THREAT frozen account: a frozen account can neither send nor receive", async () => {
  await fund(alice, 1000, "fund-1");
  await pool.query("UPDATE accounts SET status = 'frozen' WHERE id = $1", [bob]);
  const base = { actor: "u1", amountPaise: 100 };
  await assert.rejects(transfer(pool, { ...base, from: alice, to: bob, idempotencyKey: "t-1" }), { code: "ACCOUNT_FROZEN" });
  await assert.rejects(transfer(pool, { ...base, from: bob, to: alice, idempotencyKey: "t-2" }), { code: "ACCOUNT_FROZEN" });
  assert.equal(await balance(alice), 1000);
});

test("transaction type is derived from the locked accounts, and balance_paise matches the ledger", async () => {
  await fund(alice, 1000, "fund-1");
  await transfer(pool, { actor: "u1", from: alice, to: bob, amountPaise: 300, idempotencyKey: "t-1" });
  await transfer(pool, { actor: "u1", from: bob, to: treasury, amountPaise: 100, idempotencyKey: "t-2" });
  const types = await pool.query("SELECT type FROM transactions");
  assert.deepEqual(types.rows.map((r) => r.type).sort(), ["deposit", "transfer", "withdrawal"]);
  const cached = await pool.query("SELECT id, balance_paise::int AS b FROM accounts");
  for (const row of cached.rows) assert.equal(row.b, await balance(row.id));
});
