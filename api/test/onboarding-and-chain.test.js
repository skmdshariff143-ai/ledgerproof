import { test } from "node:test";
import assert from "node:assert/strict";
import { accountOf, call, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

test("health and readiness endpoints return 200 when database is connected", async () => {
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");

  const ready = await call("GET", "/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "healthy");
  assert.equal(ready.body.database, "connected");
});

test("THREAT admin route protection: unauthenticated or ACCOUNT_HOLDER user calling /api/admin/* receives 401/403", async () => {
  const unauth = await call("GET", "/api/admin/audit-logs");
  assert.equal(unauth.status, 401);

  const aliceToken = await tokenFor("alice");
  const holderAudit = await call("GET", "/api/admin/audit-logs", { token: aliceToken });
  assert.equal(holderAudit.status, 403);

  const holderVerify = await call("GET", "/api/admin/audit-logs/verify", { token: aliceToken });
  assert.equal(holderVerify.status, 403);

  const bobUser = (await pool.query("SELECT id FROM users WHERE email = 'bob@ledgerline.com'")).rows[0];
  const holderApprove = await call("POST", `/api/admin/users/${bobUser.id}/approve`, { token: aliceToken });
  assert.equal(holderApprove.status, 403);
});

test("THREAT KYC onboarding gate: PENDING_KYC user attempting to send or receive money receives 403 Forbidden", async () => {
  // Register a new user; role/status in body must be ignored and default to account_holder / PENDING_KYC
  const reg = await call("POST", "/api/auth/register", {
    body: { email: "newuser@ledgerline.com", password: "NewUser@123", role: "ADMIN", status: "ACTIVE" },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.role, "account_holder");
  assert.equal(reg.body.user.status.toUpperCase(), "PENDING_KYC");
  assert.equal(reg.body.account.status.toUpperCase(), "PENDING_KYC");
  assert.equal(reg.body.account.balance_paise, "0");

  const newToken = reg.body.token;
  const newAccId = reg.body.account.id;
  const alice = await accountOf("alice@ledgerline.com");
  const aliceToken = await tokenFor("alice");

  // Pending KYC user attempting to send funds -> 403 Forbidden
  const sendAttempt = await call("POST", "/api/transactions/transfer", {
    token: newToken,
    body: { fromAccountId: newAccId, toAccountId: alice.id, amountPaise: 100 },
    headers: { "Idempotency-Key": "kyc-send-1" },
  });
  assert.equal(sendAttempt.status, 403);
  assert.equal(sendAttempt.body.error.code, "KYC_PENDING");

  // Active user attempting to send funds to a PENDING_KYC user -> 403 Forbidden
  const receiveAttempt = await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: alice.id, toAccountId: newAccId, amountPaise: 100 },
    headers: { "Idempotency-Key": "kyc-recv-1" },
  });
  assert.equal(receiveAttempt.status, 403);
  assert.equal(receiveAttempt.body.error.code, "KYC_PENDING");

  // Admin approves the user -> transitions to ACTIVE
  const adminToken = await tokenFor("admin");
  const approve = await call("POST", `/api/admin/users/${reg.body.user.id}/approve`, { token: adminToken });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.account.status.toLowerCase(), "active");

  // Now Alice can send money to the newly approved account
  const afterApprove = await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: alice.id, toAccountId: newAccId, amountPaise: 25_000 },
    headers: { "Idempotency-Key": "kyc-recv-approved" },
  });
  assert.equal(afterApprove.status, 201);
  assert.equal((await accountOf("newuser@ledgerline.com")).balance, 25_000);
});

test("THREAT atomic overdraft rollback: transfer exceeding available balance fails with 422 and creates zero orphan rows in ledger_entries", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const beforeEntries = (await pool.query("SELECT count(*)::int AS c FROM ledger_entries")).rows[0].c;
  const beforeTx = (await pool.query("SELECT count(*)::int AS c FROM transactions")).rows[0].c;

  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"),
    body: { fromAccountId: alice.id, toAccountId: bob.id, amountPaise: 99_999_999 },
    headers: { "Idempotency-Key": "atomic-overdraft-1" },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "INSUFFICIENT_FUNDS");

  const afterEntries = (await pool.query("SELECT count(*)::int AS c FROM ledger_entries")).rows[0].c;
  const afterTx = (await pool.query("SELECT count(*)::int AS c FROM transactions")).rows[0].c;
  assert.equal(afterEntries, beforeEntries, "zero orphan rows in ledger_entries");
  assert.equal(afterTx, beforeTx, "zero orphan rows in transactions");
});

test("THREAT audit hash chain verification: /api/admin/audit-logs/verify confirms a valid SHA-256 chain and detects tampering", async () => {
  const adminToken = await tokenFor("admin");
  const aliceToken = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");

  // Perform onboarding and transfer events
  const reg = await call("POST", "/api/auth/register", {
    body: { email: "chain@ledgerline.com", password: "ChainUser@123" },
  });
  assert.equal(reg.status, 201);
  await call("POST", `/api/admin/users/${reg.body.user.id}/approve`, { token: adminToken });
  await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: alice.id, toAccountId: bob.id, amountPaise: 5_000 },
    headers: { "Idempotency-Key": "chain-transfer-1" },
  });

  // Verify the entire hash chain from Genesis to tip
  const verifyOk = await call("GET", "/api/admin/audit-logs/verify", { token: adminToken });
  assert.equal(verifyOk.status, 200);
  assert.equal(verifyOk.body.verified, true);
  assert.ok(verifyOk.body.totalEntries >= 5);
  assert.match(verifyOk.body.headHash, /^[0-9a-f]{64}$/);

  // Simulate superuser tampering with an audit log payload past the append-only trigger
  const client = await pool.connect();
  let tamperedId;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const targetRow = await client.query("SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1");
    tamperedId = Number(targetRow.rows[0].id);
    await client.query("UPDATE audit_log SET action = 'FORGED_ACTION' WHERE id = $1", [tamperedId]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  const verifyTampered = await call("GET", "/api/admin/audit-logs/verify", { token: adminToken });
  assert.equal(verifyTampered.status, 200);
  assert.equal(verifyTampered.body.verified, false);
  assert.equal(verifyTampered.body.tamperedSeq, tamperedId);
});

test("THREAT first-admin bootstrap: /api/system/bootstrap requires BOOTSTRAP_SECRET and refuses when an admin already exists", async () => {
  process.env.BOOTSTRAP_SECRET = "test-bootstrap-secret-2026";
  // Admin already exists from seed -> 409 ALREADY_BOOTSTRAPPED
  const conflict = await call("POST", "/api/system/bootstrap", {
    body: { email: "admin2@ledgerline.com", password: "AdminPassword@123", bootstrapSecret: "test-bootstrap-secret-2026" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "ALREADY_BOOTSTRAPPED");

  // Wrong secret -> 403 FORBIDDEN
  const forbidden = await call("POST", "/api/system/bootstrap", {
    body: { email: "admin2@ledgerline.com", password: "AdminPassword@123", bootstrapSecret: "wrong-secret" },
  });
  assert.equal(forbidden.status, 403);
});
