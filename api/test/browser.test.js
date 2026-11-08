import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_ORIGIN, accountOf, auditRows, call, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

const EVIL_ORIGIN = "https://evil.example";

const accountNumberOf = async (email) =>
  (await pool.query("SELECT account_number FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.email = $1", [email])).rows[0].account_number;

const payByNumber = (token, from, toAccountNumber, amountPaise, key) =>
  call("POST", "/api/transactions/transfer", {
    token, body: { fromAccountId: from, toAccountNumber, amountPaise }, headers: { "Idempotency-Key": key },
  });

const preflight = (origin) =>
  call("OPTIONS", "/api/transactions/transfer", {
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
    },
  });

test("THREAT cross-origin read: only listed origins may read answers, and the replay header is readable", async () => {
  const token = await tokenFor("alice");
  const allowed = await call("GET", "/api/me", { token, headers: { Origin: ALLOWED_ORIGIN } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  assert.match(allowed.headers.get("access-control-expose-headers"), /Idempotent-Replayed/);
  const evil = await call("GET", "/api/me", { token, headers: { Origin: EVIL_ORIGIN } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("THREAT cross-origin preflight: an allowed origin may send Authorization and Idempotency-Key; another origin gets nothing", async () => {
  const allowed = await preflight(ALLOWED_ORIGIN);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  assert.match(allowed.headers.get("access-control-allow-headers").toLowerCase(), /idempotency-key/);
  assert.match(allowed.headers.get("access-control-allow-headers").toLowerCase(), /authorization/);
  assert.equal((await preflight(EVIL_ORIGIN)).headers.get("access-control-allow-origin"), null);
});

test("THREAT user list: only admins can list users, and no password hash is ever sent", async () => {
  const res = await call("GET", "/api/users", { token: await tokenFor("admin") });
  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 4);
  assert.deepEqual(Object.keys(res.body.users[0]).sort(), ["created_at", "email", "id", "role"]);
  assert.ok(!JSON.stringify(res.body).includes("scrypt"));
  for (const who of ["alice", "auditor"]) assert.equal((await call("GET", "/api/users", { token: await tokenFor(who) })).status, 403);
  assert.equal((await call("GET", "/api/users")).status, 401);
  assert.equal((await auditRows("denied", "GET /api/users")).length, 2);
});

test("THREAT ledger explorer: auditors and admins read the double-entry ledger; account holders cannot", async () => {
  for (const who of ["auditor", "admin"]) {
    const res = await call("GET", "/api/ledger/entries", { token: await tokenFor(who) });
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 4, "two seed deposits, each a debit and a credit");
    assert.deepEqual(res.body.entries.map((e) => e.direction).sort(), ["credit", "credit", "debit", "debit"]);
    assert.equal(typeof res.body.entries[0].amount_paise, "string");
  }
  assert.equal((await call("GET", "/api/ledger/entries", { token: await tokenFor("alice") })).status, 403);
  assert.equal((await auditRows("denied", "GET /api/ledger/entries")).length, 1);
});

test("transfer by account number: Alice pays Bob without knowing his id", async () => {
  const alice = await accountOf("alice@ledgerline.com");
  const res = await payByNumber(await tokenFor("alice"), alice.id, await accountNumberOf("bob@ledgerline.com"), 25_000, "by-number");
  assert.equal(res.status, 201);
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 525_000);
});

test("THREAT transfer by account number: ownership still applies, the vault is refused, bad numbers are rejected", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const bob = await accountOf("bob@ledgerline.com");
  const aliceNumber = await accountNumberOf("alice@ledgerline.com");
  const stolen = await payByNumber(token, bob.id, aliceNumber, 1_000, "k1");
  assert.equal(stolen.status, 403, "a destination given by number must not bypass the source ownership check");
  assert.equal((await accountOf("bob@ledgerline.com")).balance, 500_000);
  assert.equal((await payByNumber(token, alice.id, "VAULT-0001", 1_000, "k2")).status, 400);
  assert.equal((await payByNumber(token, alice.id, "LP9999999999", 1_000, "k3")).status, 404);
  assert.equal((await payByNumber(token, alice.id, "lp-lowercase'; DROP TABLE accounts;--", 1_000, "k4")).status, 400);
  const both = await call("POST", "/api/transactions/transfer", {
    token,
    body: { fromAccountId: alice.id, toAccountId: bob.id, toAccountNumber: await accountNumberOf("bob@ledgerline.com"), amountPaise: 1_000 },
    headers: { "Idempotency-Key": "k5" },
  });
  assert.equal(both.status, 400);
  assert.equal((await accountOf("alice@ledgerline.com")).balance, 1_000_000);
});

test("THREAT account number probe: malformed requests get the same answer whether or not the number exists", async () => {
  const token = await tokenFor("alice");
  const alice = await accountOf("alice@ledgerline.com");
  const known = await accountNumberOf("bob@ledgerline.com");
  for (const [amountPaise, key] of [["x", "p1"], [-5, "p2"], [10, ""]]) {
    const real = await payByNumber(token, alice.id, known, amountPaise, key);
    const unknown = await payByNumber(token, alice.id, "LP9999999999", amountPaise, key);
    assert.equal(real.status, 400);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.message, real.body.error.message);
  }
});
