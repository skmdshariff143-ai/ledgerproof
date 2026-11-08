import { test } from "node:test";
import assert from "node:assert/strict";
import { accountOf, auditRows, call, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

const send = (token, path, body, key) =>
  call("POST", path, { token, body, headers: key === undefined ? {} : { "Idempotency-Key": key } });
const transfer = (token, from, to, amountPaise, key) =>
  send(token, "/api/transactions/transfer", { fromAccountId: from, toAccountId: to, amountPaise }, key);

async function transactionCount() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM transactions");
  return rows[0].n;
}

test("THREAT sequential replay: the same transfer sent 5 times moves money once and answers identically", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const before = await transactionCount();
  const responses = [];
  for (let i = 0; i < 5; i++) responses.push(await transfer(token, alice.id, bob.id, 10_000, "pay-once"));
  for (const res of responses) {
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, responses[0].body);
  }
  assert.equal(responses[0].headers.get("idempotent-replayed"), null);
  assert.ok(responses.slice(1).every((r) => r.headers.get("idempotent-replayed") === "true"));
  assert.equal(await transactionCount(), before + 1);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 510_000);
  const audited = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'transfer' AND outcome = 'success'");
  assert.equal(audited.rows[0].n, 5, "the first call and each replay are all audited");
});

test("THREAT concurrent replay: the same transfer sent 5 times at once moves money once", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const before = await transactionCount();
  const responses = await Promise.all(Array.from({ length: 5 }, () => transfer(token, alice.id, bob.id, 10_000, "race")));
  assert.ok(responses.every((r) => r.status === 201));
  assert.equal(new Set(responses.map((r) => r.body.transactionId)).size, 1);
  assert.equal(await transactionCount(), before + 1);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 990_000);
});

test("THREAT key reuse with a different request: different amount, recipient or endpoint gets 409", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await transfer(token, alice.id, bob.id, 10_000, "k")).status, 201);
  const otherAmount = await transfer(token, alice.id, bob.id, 99_000, "k");
  assert.equal(otherAmount.status, 409);
  assert.equal(otherAmount.body.error.code, "IDEMPOTENCY_CONFLICT");
  const otherEndpoint = await send(token, "/api/transactions/withdraw", { fromAccountId: alice.id, amountPaise: 10_000 }, "k");
  assert.equal(otherEndpoint.status, 409);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 990_000);
  assert.equal((await auditRows("error", "transfer")).length, 1, "the conflict is audited as a failed attempt");
});

test("THREAT key squatting: Bob using Alice's key neither blocks her nor sees her transaction", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const bobsTry = await transfer(await tokenFor("bob"), bob.id, alice.id, 1, "shared-key");
  const alicesTry = await transfer(await tokenFor("alice"), alice.id, bob.id, 10_000, "shared-key");
  assert.equal(bobsTry.status, 201);
  assert.equal(alicesTry.status, 201);
  assert.notEqual(alicesTry.body.transactionId, bobsTry.body.transactionId);
  assert.equal(alicesTry.headers.get("idempotent-replayed"), null);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 509_999);
});

test("THREAT missing or oversized key: 400 and no money moves", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await transfer(token, alice.id, bob.id, 100)).status, 400);
  assert.equal((await transfer(token, alice.id, bob.id, 100, "")).status, 400);
  assert.equal((await transfer(token, alice.id, bob.id, 100, "x".repeat(201))).status, 400);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
});

test("a failed request is not cached: the same key succeeds once the money is there", async () => {
  const token = await tokenFor("bob");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  assert.equal((await transfer(token, bob.id, alice.id, 600_000, "retry-later")).status, 422);
  const admin = await tokenFor("admin");
  assert.equal((await send(admin, "/api/transactions/deposit", { toAccountId: bob.id, amountPaise: 100_000 }, "top-up")).status, 201);
  assert.equal((await transfer(token, bob.id, alice.id, 600_000, "retry-later")).status, 201);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 0);
});

test("a replay after the source account is frozen reports the payment that already happened", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const first = await transfer(token, alice.id, bob.id, 10_000, "before-freeze");
  assert.equal((await call("POST", `/api/accounts/${alice.id}/freeze`, { token: await tokenFor("admin") })).status, 200);
  const replay = await transfer(token, alice.id, bob.id, 10_000, "before-freeze");
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(replay.body, first.body);
  assert.equal((await transfer(token, alice.id, bob.id, 10_000, "after-freeze")).status, 422, "new payments are still refused");
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 990_000);
});

test("a withdrawal key reused on a transfer to the vault is refused, not replayed", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const vault = (await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'")).rows[0].id;
  assert.equal((await send(token, "/api/transactions/withdraw", { fromAccountId: alice.id, amountPaise: 10_000 }, "wd")).status, 201);
  const res = await transfer(token, alice.id, vault, 10_000, "wd");
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("idempotent-replayed"), null);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 990_000);
});
