import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../scripts/migrate.js";
import { seed } from "../scripts/seed.js";
import { audit, verifyAuditChain } from "../src/audit.js";
import { accountOf, appPool, call, pool, resetDatabase, tokenFor, useSeededServer } from "./helpers.js";

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

  // Admin rejects a second registered user -> user status becomes 'rejected', account becomes 'frozen'
  const reg2 = await call("POST", "/api/auth/register", {
    body: { email: "rejecteduser@ledgerline.com", password: "Rejected@123" },
  });
  assert.equal(reg2.status, 201);
  const rejectRes = await call("POST", `/api/admin/users/${reg2.body.user.id}/reject`, { token: adminToken });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.user.status.toLowerCase(), "rejected");
  assert.equal(rejectRes.body.account.status.toLowerCase(), "frozen");

  // Rejected user can still read /api/me to see their status, but cannot receive or send money (422 ACCOUNT_FROZEN)
  const rejectedMe = await call("GET", "/api/me", { token: reg2.body.token });
  assert.equal(rejectedMe.status, 200);
  assert.equal(rejectedMe.body.user.status.toLowerCase(), "rejected");
  const transferToRejected = await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: alice.id, toAccountId: reg2.body.account.id, amountPaise: 100 },
    headers: { "Idempotency-Key": "kyc-recv-rejected" },
  });
  assert.equal(transferToRejected.status, 422);
  assert.equal(transferToRejected.body.error.code, "ACCOUNT_FROZEN");
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

test("THREAT serverless token revocation and rate limiting: revoked JWTs are persisted in revoked_tokens and blocked with 401 across instances", async () => {
  const loginRes = await call("POST", "/api/auth/login", {
    body: { email: "alice@ledgerline.com", password: "Alice@123" },
  });
  assert.equal(loginRes.status, 200);
  const token = loginRes.body.token;

  // Before logout, /api/me succeeds
  const meBefore = await call("GET", "/api/me", { token });
  assert.equal(meBefore.status, 200);

  // Logout persists the token JTI into PostgreSQL revoked_tokens
  const logoutRes = await call("POST", "/api/auth/logout", { token });
  assert.equal(logoutRes.status, 200);
  assert.equal(logoutRes.body.status, "logged_out");

  const revokedCount = (await pool.query("SELECT count(*)::int AS c FROM revoked_tokens")).rows[0].c;
  assert.ok(revokedCount >= 1, "revoked token JTI is stored in PostgreSQL revoked_tokens");

  // Reusing the revoked token is immediately rejected with 401
  const meAfter = await call("GET", "/api/me", { token });
  assert.equal(meAfter.status, 401);

  // Rate limit bucket was also persisted in PostgreSQL rate_limit_buckets
  const bucketCount = (await pool.query("SELECT count(*)::int AS c FROM rate_limit_buckets")).rows[0].c;
  assert.ok(bucketCount >= 1, "rate limit state is stored in PostgreSQL rate_limit_buckets");
});

test("THREAT PgBouncer transaction pooler safety: audit chain hashing and transfers use pg_advisory_xact_lock and leave zero dangling session locks", async () => {
  const aliceToken = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");

  const transferRes = await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: alice.id, toAccountId: bob.id, amountPaise: 1_000 },
    headers: { "Idempotency-Key": "pgbouncer-lock-check-1" },
  });
  assert.equal(transferRes.status, 201);

  // Verify function definition uses transaction-level pg_advisory_xact_lock and never session-level pg_advisory_lock
  const fnDef = await pool.query("SELECT prosrc FROM pg_proc WHERE proname = 'chain_audit_log'");
  assert.match(fnDef.rows[0].prosrc, /pg_advisory_xact_lock/);
  assert.doesNotMatch(fnDef.rows[0].prosrc, /pg_advisory_lock\(/);

  // Confirm zero dangling session-level advisory locks exist after transaction completion
  const locks = await pool.query("SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND granted = true");
  assert.equal(locks.rows[0].c, 0, "zero dangling advisory locks after transaction commit");
});

test("THREAT legacy audit migration: upgrading a populated legacy schema backfills hashes, rejects inconsistent or ambiguous state, and keeps audit_log append-only", async () => {
  try {
    // 1. Fresh database migration
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const freshResult = await migrate(pool);
    assert.deepEqual(freshResult, { applied: true, upgraded: false });
    const freshVerify = await verifyAuditChain(pool);
    assert.equal(freshVerify.verified, true);
    assert.equal(freshVerify.totalEntries, 0);

    // 2. Populated legacy v1 schema (without previous_hash / entry_hash columns)
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE CHECK (email = lower(email)),
        password_hash text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'account_holder', 'auditor')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE SEQUENCE account_number_seq;
      CREATE TABLE accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_number text NOT NULL UNIQUE DEFAULT 'LP' || lpad(nextval('account_number_seq')::text, 10, '0'),
        account_type text NOT NULL CHECK (account_type IN ('system_vault', 'user_checking')),
        owner_id uuid REFERENCES users (id),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
        balance_paise bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO accounts (account_number, account_type) VALUES ('VAULT-0001', 'system_vault');
      CREATE TABLE transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type text NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'transfer')),
        initiated_by uuid NOT NULL REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ledger_entries (
        id bigserial PRIMARY KEY,
        transaction_id uuid NOT NULL REFERENCES transactions (id),
        account_id uuid NOT NULL REFERENCES accounts (id),
        direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
        amount_paise bigint NOT NULL CHECK (amount_paise > 0),
        running_balance_paise bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE idempotency_keys (
        user_id uuid NOT NULL REFERENCES users (id),
        key text NOT NULL,
        request_hash text NOT NULL,
        transaction_id uuid NOT NULL REFERENCES transactions (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE audit_log (
        id bigserial PRIMARY KEY,
        actor_user_id uuid REFERENCES users (id),
        actor_role text,
        action text NOT NULL,
        target text,
        ip text,
        details jsonb,
        outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const legacyAdmin = (
      await pool.query("INSERT INTO users (email, password_hash, role) VALUES ('admin@ledgerline.com', 'hash', 'admin') RETURNING id")
    ).rows[0];
    await pool.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target, ip, details, outcome, created_at)
       VALUES ($1, 'admin', 'login', NULL, '127.0.0.1', '{"step": 1}'::jsonb, 'success', '2026-11-09T10:00:00.000Z'),
              (NULL, NULL, 'login', NULL, '127.0.0.1', '{"email": "bad@example.com"}'::jsonb, 'denied', '2026-11-09T10:01:00.000Z'),
              ($1, 'admin', 'reconcile', 'account:vault', '127.0.0.1', NULL, 'success', '2026-11-09T10:02:00.000Z')`,
      [legacyAdmin.id],
    );

    const beforeRows = (await pool.query("SELECT id, actor_user_id, actor_role, action, target, details, outcome, created_at FROM audit_log ORDER BY id ASC")).rows;

    // Before migration, verifyAuditChain reports schemaMigrated: false
    const preMigrateVerify = await verifyAuditChain(pool);
    assert.equal(preMigrateVerify.verified, false);
    assert.equal(preMigrateVerify.schemaMigrated, false);
    assert.equal(preMigrateVerify.reason, "MISSING_HASH_COLUMNS");

    // 3. Upgrade the populated legacy database
    const upgradeResult = await migrate(pool);
    assert.deepEqual(upgradeResult, { applied: false, upgraded: true });

    // Original audit content is preserved byte-for-byte
    const afterRows = (await pool.query("SELECT id, actor_user_id, actor_role, action, target, details, outcome, created_at FROM audit_log ORDER BY id ASC")).rows;
    assert.deepEqual(afterRows, beforeRows);

    // Every legacy row now has a verified SHA-256 chain from GENESIS_LEDGERPROOF_2026
    const postMigrateVerify = await verifyAuditChain(pool);
    assert.equal(postMigrateVerify.verified, true);
    assert.equal(postMigrateVerify.schemaMigrated, true);
    assert.equal(postMigrateVerify.totalEntries, 3);

    // 4. Repeat migration is idempotent and preserves existing hashes
    const hashesBeforeRepeat = (await pool.query("SELECT id, previous_hash, entry_hash FROM audit_log ORDER BY id ASC")).rows;
    const repeatResult = await migrate(pool);
    assert.deepEqual(repeatResult, { applied: false, upgraded: true });
    const hashesAfterRepeat = (await pool.query("SELECT id, previous_hash, entry_hash FROM audit_log ORDER BY id ASC")).rows;
    assert.deepEqual(hashesAfterRepeat, hashesBeforeRepeat);

    // 5. Appending a new audit row links cleanly to the migrated tip, and restricted role cannot mutate audit_log
    await audit(appPool, { actor: { id: legacyAdmin.id, role: "admin" }, action: "read_users", ip: "127.0.0.1", outcome: "success" });
    const afterAppendVerify = await verifyAuditChain(appPool);
    assert.equal(afterAppendVerify.verified, true);
    assert.equal(afterAppendVerify.totalEntries, 4);
    await assert.rejects(appPool.query("UPDATE audit_log SET action = 'tampered'"), /permission denied/);
    await assert.rejects(appPool.query("DELETE FROM audit_log"), /permission denied/);

    // 6. Inconsistent existing hash fails migration visibly and restores append-only trigger
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
      await client.query("UPDATE audit_log SET entry_hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE id = 2");
      await client.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await assert.rejects(migrate(pool), /inconsistent existing audit_log hash at id 2/);
    // Append-only trigger is still active after the failed migration rolled back
    await assert.rejects(pool.query("DELETE FROM audit_log WHERE id = 1"), /append-only/);

    // 7. Ambiguous partial state (NULL entry_hash on an earlier row before a hashed row) fails visibly
    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      await client2.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
      await client2.query("ALTER TABLE audit_log ALTER COLUMN entry_hash DROP NOT NULL");
      await client2.query("UPDATE audit_log SET entry_hash = NULL WHERE id = 1");
      await client2.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
    await assert.rejects(migrate(pool), /ambiguous audit_log migration state: unhashed legacy row precedes hashed row at id 2/);
  } finally {
    await resetDatabase(pool);
    await seed(pool);
  }
});
