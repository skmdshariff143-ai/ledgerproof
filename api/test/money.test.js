import { test } from "node:test";
import assert from "node:assert/strict";
import { accountOf, auditRows, call, pool, tokenFor, useSeededServer, vaultId } from "./helpers.js";

useSeededServer();

const deposit = (token, toAccountId, amountPaise, key) =>
  call("POST", "/api/transactions/deposit", { token, body: { toAccountId, amountPaise }, headers: { "Idempotency-Key": key } });
const withdraw = (token, fromAccountId, amountPaise, key) =>
  call("POST", "/api/transactions/withdraw", { token, body: { fromAccountId, amountPaise }, headers: { "Idempotency-Key": key } });

test("admin deposit: the vault pays, the account is credited, and the admin is recorded as initiator", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const res = await deposit(await tokenFor("admin"), alice.id, 50_000, "dep-1");
  assert.equal(res.status, 201);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_050_000);
  const { rows } = await pool.query(
    "SELECT t.type, u.role FROM transactions t JOIN users u ON u.id = t.initiated_by WHERE t.id = $1",
    [res.body.transactionId],
  );
  assert.deepEqual(rows[0], { type: "deposit", role: "admin" });
});

test("THREAT self-deposit: account holders and auditors cannot create money; attempts are audited", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  assert.equal((await deposit(await tokenFor("alice"), alice.id, 50_000, "dep-a")).status, 403);
  assert.equal((await deposit(await tokenFor("auditor"), alice.id, 50_000, "dep-b")).status, 403);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
  assert.equal((await auditRows("denied", "POST /api/transactions/deposit")).length, 2);
});

test("deposit into the vault itself or a missing account is rejected", async () => {
  const admin = await tokenFor("admin");
  assert.equal((await deposit(admin, await vaultId(), 100, "dep-v")).status, 400);
  assert.equal((await deposit(admin, "00000000-0000-0000-0000-000000000000", 100, "dep-m")).status, 404);
});

test("withdrawal: Alice takes money out of her own account into the vault", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const res = await withdraw(await tokenFor("alice"), alice.id, 30_000, "wd-1");
  assert.equal(res.status, 201);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 970_000);
  const { rows } = await pool.query("SELECT type FROM transactions WHERE id = $1", [res.body.transactionId]);
  assert.equal(rows[0].type, "withdrawal");
});

test("THREAT IDOR withdrawal: Alice cannot withdraw from Bob's account; audited", async () => {
  const bob = await accountOf("bob@ledgerline.com");
  const res = await withdraw(await tokenFor("alice"), bob.id, 30_000, "wd-steal");
  assert.equal(res.status, 403);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 500_000);
  const denied = await auditRows("denied", "withdraw");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].email, "alice@ledgerline.com");
});

test("THREAT overdraft withdrawal and bad amounts: rejected without moving money", async () => {
  const token = await tokenFor("bob");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await withdraw(token, bob.id, 500_001, "wd-big")).status, 422);
  for (const [amount, key] of [[0, "z"], [-100, "n"], [10.5, "f"], ["100", "s"], [null, "x"]]) {
    assert.equal((await withdraw(token, bob.id, amount, key)).status, 400, `amount ${amount} must be rejected`);
  }
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 500_000);
});

test("THREAT replayed deposit and withdrawal: the same key moves money once", async () => {
  const admin = await tokenFor("admin");
  const alice = await accountOf("alice@ledgerline.com");
  const first = await deposit(admin, alice.id, 10_000, "dep-retry");
  const again = await deposit(admin, alice.id, 10_000, "dep-retry");
  assert.equal(again.status, 201);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(again.body.transactionId, first.body.transactionId);
  const token = await tokenFor("alice");
  await withdraw(token, alice.id, 5_000, "wd-retry");
  await withdraw(token, alice.id, 5_000, "wd-retry");
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_005_000);
});

test("reconcile: balanced after deposits, withdrawals and transfers; readable by auditor and admin only", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  await deposit(await tokenFor("admin"), bob.id, 12_345, "r-dep");
  await withdraw(await tokenFor("alice"), alice.id, 678, "r-wd");
  await call("POST", "/api/transactions/transfer", {
    token: await tokenFor("bob"), body: { fromAccountId: bob.id, toAccountId: alice.id, amountPaise: 9_999 }, headers: { "Idempotency-Key": "r-tr" },
  });
  const res = await call("GET", "/api/ledger/reconcile", { token: await tokenFor("auditor") });
  assert.equal(res.status, 200);
  assert.equal(res.body.balanced, true);
  assert.deepEqual(res.body.problems, []);
  assert.equal(res.body.totals.debits_paise, res.body.totals.credits_paise);
  assert.equal(res.body.totals.entries, 10);
  assert.equal((await call("GET", "/api/ledger/reconcile", { token: await tokenFor("admin") })).status, 200);
  assert.equal((await call("GET", "/api/ledger/reconcile", { token: await tokenFor("alice") })).status, 403);
});

test("THREAT tampering past the triggers: reconcile reports a balance edited with triggers switched off", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  // Simulates the known gap: a superuser session that disables triggers for itself.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("UPDATE accounts SET balance_paise = balance_paise + 100000 WHERE id = $1", [alice.id]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const res = await call("GET", "/api/ledger/reconcile", { token: await tokenFor("auditor") });
  assert.equal(res.body.balanced, false);
  const types = res.body.problems.filter((p) => p.accountId === alice.id).map((p) => p.type).sort();
  assert.deepEqual(types, ["balance_mismatch", "running_balance_mismatch"]);
});

test("THREAT hidden deposits: successful deposits and withdrawals are audited under their own action names", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  await deposit(await tokenFor("admin"), alice.id, 1_000, "aud-dep");
  await withdraw(await tokenFor("alice"), alice.id, 500, "aud-wd");
  const deposits = await auditRows("success", "deposit");
  assert.equal(deposits.length, 3, "two seed deposits plus this one");
  assert.equal(deposits.at(-1).target, `account:${alice.id}`);
  assert.equal((await auditRows("success", "withdraw")).length, 1);
});

test("reconcile reports a transaction that has no ledger rows", async () => {
  const admin = (await pool.query("SELECT id FROM users WHERE role = 'admin'")).rows[0].id;
  const { rows } = await pool.query("INSERT INTO transactions (type, initiated_by) VALUES ('transfer', $1) RETURNING id", [admin]);
  const res = await call("GET", "/api/ledger/reconcile", { token: await tokenFor("auditor") });
  assert.equal(res.body.balanced, false);
  assert.deepEqual(res.body.problems, [{ type: "unbalanced_transaction", transactionId: rows[0].id }]);
});
