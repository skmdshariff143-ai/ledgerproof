import { test } from "node:test";
import assert from "node:assert/strict";
import { call, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

// Under the 10 kB JSON body limit, so only a field limit can refuse them.
const LONG_EMAIL = `${"a".repeat(9000)}@example.com`;
const LONG_PASSWORD = "p".repeat(9000);

test("THREAT oversized text fields: a 9,000-character email or password is refused, not stored or hashed", async () => {
  const email = await call("POST", "/api/auth/register", { body: { email: LONG_EMAIL, password: "Pending@12345" } });
  assert.equal(email.status, 400);
  assert.equal(email.body.error.code, "INVALID_INPUT");

  const password = await call("POST", "/api/auth/register", { body: { email: "long.password@example.com", password: LONG_PASSWORD } });
  assert.equal(password.status, 400);
  assert.equal(password.body.error.code, "INVALID_INPUT");

  const stored = await pool.query("SELECT count(*)::int AS n FROM users WHERE length(email) > 254 OR email = 'long.password@example.com'");
  assert.equal(stored.rows[0].n, 0);
});

test("THREAT oversized text fields: a failed login with a 9,000-character email writes no large audit row", async () => {
  const res = await call("POST", "/api/auth/login", { body: { email: LONG_EMAIL, password: "whatever" } });
  assert.equal(res.status, 400);
  const big = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE length(details::text) > 1000");
  assert.equal(big.rows[0].n, 0, "the audit log must not hold the oversized value");
});

test("THREAT oversized text fields: limits still allow normal values (254-character email, 128-character password)", async () => {
  const email = `${"b".repeat(240)}@example.com`; // 252 characters
  const res = await call("POST", "/api/auth/register", { body: { email, password: "q".repeat(128) } });
  assert.equal(res.status, 201);
  assert.equal((await call("POST", "/api/auth/login", { body: { email, password: "q".repeat(128) } })).status, 200);
});

test("THREAT absurd paging values: a huge offset is clamped and answered, not a 500", async () => {
  const token = await tokenFor("admin");
  const res = await call("GET", "/api/audit-logs?offset=999999999999999999999999&limit=999999", { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.entries));
});

test("existing limits hold: a 201-character idempotency key, a 33-character account number and a body over 10 kB are refused", async () => {
  const token = await tokenFor("alice");
  const accounts = await call("GET", "/api/accounts", { token });
  const from = accounts.body.accounts[0].id;
  const longKey = await call("POST", "/api/transactions/transfer", { token, headers: { "Idempotency-Key": "k".repeat(201) }, body: { fromAccountId: from, toAccountNumber: "LP0000000002", amountPaise: 100 } });
  assert.equal(longKey.status, 400);
  const longNumber = await call("POST", "/api/transactions/transfer", { token, headers: { "Idempotency-Key": "ok-key-1" }, body: { fromAccountId: from, toAccountNumber: "A".repeat(33), amountPaise: 100 } });
  assert.equal(longNumber.status, 400);
  const huge = await call("POST", "/api/auth/login", { body: { email: "x@example.com", password: "z".repeat(11000) } });
  assert.equal(huge.status, 400);
});

test("THREAT oversized account id in a money request: refused, and the value is not copied into the audit log", async () => {
  const alice = await tokenFor("alice");
  const admin = await tokenFor("admin");
  const headers = { "Idempotency-Key": "oversized-id-check" };
  for (const bad of ["x".repeat(9000), { nested: "object" }]) {
    const withdraw = await call("POST", "/api/transactions/withdraw", { token: alice, headers, body: { fromAccountId: bad, amountPaise: 100 } });
    assert.equal(withdraw.status, 400);
    const deposit = await call("POST", "/api/transactions/deposit", { token: admin, headers, body: { toAccountId: bad, amountPaise: 100 } });
    assert.equal(deposit.status, 400);
  }
  const big = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE length(target) > 200 OR target LIKE '%object Object%'");
  assert.equal(big.rows[0].n, 0, "the audit log must not hold the oversized or malformed id");
  const recorded = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('withdraw','deposit') AND outcome = 'error'");
  assert.ok(recorded.rows[0].n >= 4, "the failed attempts are still audited");
});
