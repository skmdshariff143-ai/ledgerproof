import { test } from "node:test";
import assert from "node:assert/strict";
import { accountOf, call, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

const move = (token, path, body, key) => call("POST", path, { token, body, headers: { "Idempotency-Key": key } });

async function assertBooksBalance() {
  const res = await call("GET", "/api/ledger/reconcile", { token: await tokenFor("auditor") });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.problems, []);
  assert.equal(res.body.balanced, true);
  assert.equal(res.body.totals.debits_paise, res.body.totals.credits_paise);
}

test("THREAT concurrent overdraft over HTTP: 20 simultaneous withdrawals of Rs 1,000 from Rs 5,000 let exactly 5 succeed", async () => {
  const token = await tokenFor("bob");
  const bob = await accountOf("bob@ledgerline.com");
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      move(token, "/api/transactions/withdraw", { fromAccountId: bob.id, amountPaise: 100_000 }, `wd-${i}`),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 5);
  const failed = responses.filter((r) => r.status !== 201);
  assert.equal(failed.length, 15);
  assert.ok(failed.every((r) => r.status === 422 && r.body.error.code === "INSUFFICIENT_FUNDS"), "failures must be clean 422s, never 500s");
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 0);
  await assertBooksBalance();
});

test("THREAT cross-transfer deadlock over HTTP: 15 Alice->Bob and 15 Bob->Alice transfers at once all succeed and money is conserved", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const aliceToken = await tokenFor("alice");
  const bobToken = await tokenFor("bob");
  const requests = [];
  for (let i = 0; i < 15; i++) {
    requests.push(move(aliceToken, "/api/transactions/transfer", { fromAccountId: alice.id, toAccountId: bob.id, amountPaise: 300 }, `ab-${i}`));
    requests.push(move(bobToken, "/api/transactions/transfer", { fromAccountId: bob.id, toAccountId: alice.id, amountPaise: 100 }, `ba-${i}`));
  }
  const responses = await Promise.all(requests);
  assert.deepEqual([...new Set(responses.map((r) => r.status))], [201], "a deadlock would surface as a 500");
  const after = { alice: (await accountOf("alice@ledgerline.com")).balance, bob: (await accountOf("bob@ledgerline.com")).balance };
  assert.equal(after.alice, 1_000_000 - 15 * 300 + 15 * 100);
  assert.equal(after.bob, 500_000 + 15 * 300 - 15 * 100);
  assert.equal(after.alice + after.bob, 1_500_000);
  await assertBooksBalance();
});
