import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { seed } from "../scripts/seed.js";
import { accountOf, auditRows, call, jwtSecret, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

const transferBody = (from, to, amountPaise = 100) => ({ fromAccountId: from, toAccountId: to, amountPaise });

test("seed: Alice has 10,000 rupees and Bob 5,000, paid from the vault through the ledger", async () => {
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 500_000);
  await seed(pool);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000, "running the seed twice must not pay twice");
  const { rows } = await pool.query("SELECT balance_paise::int AS b FROM accounts WHERE account_type = 'system_vault'");
  assert.equal(rows[0].b, -1_500_000);
});

test("THREAT bad login: a wrong password gets 401 and is audited as denied", async () => {
  const res = await call("POST", "/api/auth/login", { body: { email: "alice@ledgerline.com", password: "wrong" } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "UNAUTHENTICATED");
  assert.equal((await auditRows("denied", "login")).length, 1);
});

test("THREAT no or forged token: missing, wrong-secret, alg:none and wrong-algorithm tokens all get 401", async () => {
  const alice = (await pool.query("SELECT id FROM users WHERE email = 'alice@ledgerline.com'")).rows[0].id;
  const forged = jwt.sign({}, "not-the-server-secret", { algorithm: "HS256", subject: alice });
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: alice })}.`;
  assert.equal((await call("GET", "/api/accounts")).status, 401);
  assert.equal((await call("GET", "/api/accounts", { token: forged })).status, 401);
  assert.equal((await call("GET", "/api/accounts", { token: unsigned })).status, 401);
  // Signed with the REAL secret but another algorithm: only the HS256 pin in authenticate() refuses it.
  const otherAlgorithm = jwt.sign({}, jwtSecret, { algorithm: "HS512", subject: alice });
  assert.equal((await call("GET", "/api/accounts", { token: otherAlgorithm })).status, 401);
});

test("THREAT stale role: the role comes from the database on each request, not from the token", async () => {
  const token = await tokenFor("alice");
  await pool.query("UPDATE users SET role = 'auditor' WHERE email = 'alice@ledgerline.com'");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const res = await call("POST", "/api/transactions/transfer", {
    token, body: transferBody(alice.id, bob.id), headers: { "Idempotency-Key": "k1" },
  });
  assert.equal(res.status, 403);
});

test("account holders list only their own accounts", async () => {
  const res = await call("GET", "/api/accounts", { token: await tokenFor("alice") });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accounts.map((a) => a.id), [(await accountOf("alice@ledgerline.com")).id]);
  assert.equal(typeof res.body.accounts[0].balance_paise, "string", "bigint money is sent as a string, never a float");
});

test("THREAT IDOR statement: Alice cannot read Bob's statement, or probe for unknown ids; both are audited", async () => {
  const token = await tokenFor("alice");
  const bob = await accountOf("bob@ledgerline.com");
  const res = await call("GET", `/api/accounts/${bob.id}/statement`, { token });
  assert.equal(res.status, 403);
  const unknown = await call("GET", "/api/accounts/00000000-0000-0000-0000-000000000000/statement", { token });
  assert.equal(unknown.status, 403, "a missing account must look the same as someone else's");
  const denied = await auditRows("denied", "read_statement");
  assert.equal(denied.length, 2);
  assert.equal(denied[0].email, "alice@ledgerline.com");
  assert.equal(denied[0].target, `account:${bob.id}`);
});

test("Alice can read her own statement, with running balances as strings", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const res = await call("GET", `/api/accounts/${alice.id}/statement`, { token: await tokenFor("alice") });
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].running_balance_paise, "1000000");
});

test("THREAT IDOR transfer: Alice cannot send money from Bob's account; balances unchanged and audited", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"), body: transferBody(bob.id, alice.id, 50_000), headers: { "Idempotency-Key": "steal-1" },
  });
  assert.equal(res.status, 403);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 500_000);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
  const denied = await auditRows("denied", "transfer");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].target, `account:${bob.id}`);
});

test("THREAT vault minting: an account holder cannot name the vault as the source", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const vault = (await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'")).rows[0].id;
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"), body: transferBody(vault, alice.id, 100), headers: { "Idempotency-Key": "mint-1" },
  });
  assert.equal(res.status, 403);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
});

test("Alice can transfer from her own account; the transaction records her as the initiator", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"), body: transferBody(alice.id, bob.id, 25_000), headers: { "Idempotency-Key": "pay-bob-1" },
  });
  assert.equal(res.status, 201);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 525_000);
  const { rows } = await pool.query(
    "SELECT u.email FROM transactions t JOIN users u ON u.id = t.initiated_by WHERE t.id = $1",
    [res.body.transactionId],
  );
  assert.equal(rows[0].email, "alice@ledgerline.com");
  assert.equal((await auditRows("success", "transfer")).at(-1).email, "alice@ledgerline.com");
});

test("THREAT auditor writes: an auditor cannot transfer, create or freeze accounts; each attempt is audited", async () => {
  const token = await tokenFor("auditor");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const aliceUser = (await pool.query("SELECT id FROM users WHERE email = 'alice@ledgerline.com'")).rows[0].id;
  const attempts = [
    call("POST", "/api/transactions/transfer", { token, body: transferBody(alice.id, bob.id), headers: { "Idempotency-Key": "a1" } }),
    call("POST", "/api/accounts", { token, body: { ownerId: aliceUser } }),
    call("POST", `/api/accounts/${bob.id}/freeze`, { token }),
  ];
  for (const res of await Promise.all(attempts)) assert.equal(res.status, 403);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE outcome = 'denied' AND actor_role = 'auditor'");
  assert.equal(rows[0].n, 3);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
});

test("auditor can read any statement and the audit log; account holders cannot read the audit log", async () => {
  const auditor = await tokenFor("auditor");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await call("GET", `/api/accounts/${bob.id}/statement`, { token: auditor })).status, 200);
  const logs = await call("GET", "/api/audit-logs", { token: auditor });
  assert.equal(logs.status, 200);
  assert.ok(logs.body.entries.length > 0);
  assert.equal((await call("GET", "/api/audit-logs", { token: await tokenFor("alice") })).status, 403);
});

test("THREAT admin forging: an admin cannot move money out of a user's account", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("admin"), body: transferBody(bob.id, alice.id, 100), headers: { "Idempotency-Key": "adm-1" },
  });
  assert.equal(res.status, 403);
  assert.equal((await auditRows("denied", "POST /api/transactions/transfer"))[0].actor_role, "admin");
});

test("admin freezes Bob: transfers to him fail with 422 and the failure is audited outside the rolled-back transaction", async () => {
  const admin = await tokenFor("admin");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await call("POST", `/api/accounts/${bob.id}/freeze`, { token: admin })).status, 200);
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"), body: transferBody(alice.id, bob.id), headers: { "Idempotency-Key": "to-frozen" },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "ACCOUNT_FROZEN");
  assert.equal((await auditRows("error", "transfer")).length, 1);
  assert.equal((await call("POST", `/api/accounts/${bob.id}/unfreeze`, { token: admin })).status, 200);
  assert.equal((await auditRows("success", "freeze")).length, 1);
});

test("admin creates an account for an account holder, but not for an auditor", async () => {
  const admin = await tokenFor("admin");
  const ids = (await pool.query("SELECT email, id FROM users")).rows;
  const idOf = (email) => ids.find((u) => u.email === email).id;
  const ok = await call("POST", "/api/accounts", { token: admin, body: { ownerId: idOf("bob@ledgerline.com") } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.account.account_number, /^LP\d{10}$/);
  assert.equal(ok.body.account.balance_paise, "0");
  const bad = await call("POST", "/api/accounts", { token: admin, body: { ownerId: idOf("auditor@ledgerline.com") } });
  assert.equal(bad.status, 400);
});

test("THREAT error leaks: bad JSON, missing idempotency key and insufficient funds return clean JSON errors", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const badJson = await call("POST", "/api/transactions/transfer", { token, body: "{not json" });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, "INVALID_INPUT");
  const noKey = await call("POST", "/api/transactions/transfer", { token, body: transferBody(alice.id, bob.id) });
  assert.equal(noKey.status, 400);
  const tooMuch = await call("POST", "/api/transactions/transfer", {
    token, body: transferBody(alice.id, bob.id, 1_000_001), headers: { "Idempotency-Key": "big" },
  });
  assert.equal(tooMuch.status, 422);
  assert.deepEqual(Object.keys(tooMuch.body.error).sort(), ["code", "message"]);
  assert.equal((await call("GET", "/api/nope", { token })).status, 404);
});

test("THREAT withdrawal by transfer: an account holder cannot transfer to the vault", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const vault = (await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'")).rows[0].id;
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"), body: transferBody(alice.id, vault, 100), headers: { "Idempotency-Key": "to-vault" },
  });
  assert.equal(res.status, 400);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
});

test("THREAT frozen-status probe: an under-funded transfer to a frozen account looks like any under-funded transfer", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await call("POST", `/api/accounts/${bob.id}/freeze`, { token: await tokenFor("admin") })).status, 200);
  const res = await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("alice"), body: transferBody(alice.id, bob.id, 2_000_000), headers: { "Idempotency-Key": "probe" },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "INSUFFICIENT_FUNDS");
});

test("a failing audit write does not hide the original error", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  // NOT VALID: existing rows are kept, every new audit row is refused.
  await pool.query("ALTER TABLE audit_log ADD CONSTRAINT refuse_new_rows CHECK (false) NOT VALID");
  const original = console.error;
  console.error = () => {};
  try {
    const res = await call("POST", "/api/transactions/transfer", {
      token, body: transferBody(alice.id, bob.id, 2_000_000), headers: { "Idempotency-Key": "audit-down" },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "INSUFFICIENT_FUNDS");
  } finally {
    console.error = original;
  }
});
