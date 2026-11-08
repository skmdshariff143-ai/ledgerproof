// Live attack checks against a running LedgerProof API.
//   API_URL=https://your-own-deployment.example npm run attack
// Only ever point this at YOUR OWN deployment (or localhost). It signs in as the demo users, tries the
// attacks THREATS.md claims are blocked, and exits 1 if any of them works. It moves a little demo
// money and puts it back, so it leaves extra rows in the append-only ledger and audit log.
import jwt from "jsonwebtoken";

const API_URL = process.env.API_URL?.replace(/\/$/, "");
if (!API_URL) {
  console.error("Set API_URL to your own deployment, for example: API_URL=http://localhost:3000 npm run attack");
  process.exit(2);
}

const DEMO = {
  admin: ["admin@ledgerline.com", "Admin@123"],
  alice: ["alice@ledgerline.com", "Alice@123"],
  bob: ["bob@ledgerline.com", "Bob@123"],
  auditor: ["auditor@ledgerline.com", "Auditor@123"],
};
const run = Date.now();
const results = [];

async function call(method, path, { token, body, key } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(key && { "Idempotency-Key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function login(who) {
  const res = await call("POST", "/api/auth/login", { body: { email: DEMO[who][0], password: DEMO[who][1] } });
  if (res.status !== 200) throw new Error(`cannot sign in as ${who}: ${res.status}. Is the demo data seeded?`);
  return res.body.token;
}

const accountOf = async (token) => (await call("GET", "/api/accounts", { token })).body.accounts[0];
const balanceOf = async (token) => BigInt((await accountOf(token)).balance_paise);
const move = (token, path, body, key) => call("POST", `/api/transactions/${path}`, { token, body, key });

const tokens = Object.fromEntries(await Promise.all(Object.keys(DEMO).map(async (who) => [who, await login(who)])));
const [alice, bob] = [await accountOf(tokens.alice), await accountOf(tokens.bob)];

// 1. No identity, forged identity.
check("no token is refused (401)", (await call("GET", "/api/accounts")).status === 401);
const forged = jwt.sign({}, "not-the-server-secret", { algorithm: "HS256", subject: alice.owner_id });
check("token signed with another secret is refused (401)", (await call("GET", "/api/accounts", { token: forged })).status === 401);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: alice.owner_id })}.`;
check("unsigned alg:none token is refused (401)", (await call("GET", "/api/accounts", { token: unsigned })).status === 401);

// 2. Reaching someone else's data or powers.
check("Alice cannot read Bob's statement (403)", (await call("GET", `/api/accounts/${bob.id}/statement`, { token: tokens.alice })).status === 403);
const steal = await move(tokens.alice, "transfer", { fromAccountId: bob.id, toAccountNumber: alice.account_number, amountPaise: 100 }, `steal-${run}`);
check("Alice cannot move money out of Bob's account (403)", steal.status === 403);
check("Alice cannot list users (403)", (await call("GET", "/api/users", { token: tokens.alice })).status === 403);
check("Alice cannot create money with a deposit (403)", (await move(tokens.alice, "deposit", { toAccountId: alice.id, amountPaise: 100 }, `mint-${run}`)).status === 403);
const auditorTry = await move(tokens.auditor, "transfer", { fromAccountId: alice.id, toAccountNumber: bob.account_number, amountPaise: 100 }, `aud-${run}`);
check("auditor cannot transfer (403)", auditorTry.status === 403);

// 3. The same request five times at once pays once.
const aliceBefore = await balanceOf(tokens.alice);
const replay = await Promise.all(
  Array.from({ length: 5 }, () => move(tokens.alice, "transfer", { fromAccountId: alice.id, toAccountNumber: bob.account_number, amountPaise: 100 }, `replay-${run}`)),
);
const ids = new Set(replay.map((r) => r.body?.transactionId));
check("5 simultaneous identical requests all answer 201 with one transaction", replay.every((r) => r.status === 201) && ids.size === 1);
check("...and Alice was charged exactly once", aliceBefore - (await balanceOf(tokens.alice)) === 100n);
check("same key with a different amount is refused (409)", (await move(tokens.alice, "transfer", { fromAccountId: alice.id, toAccountNumber: bob.account_number, amountPaise: 999 }, `replay-${run}`)).status === 409);
await move(tokens.bob, "transfer", { fromAccountId: bob.id, toAccountNumber: alice.account_number, amountPaise: 100 }, `undo-${run}`);

// 4. Twenty simultaneous withdrawals of Rs 1,000 can never overdraw the account.
const unit = 100_000n;
const bobBefore = await balanceOf(tokens.bob);
const expected = bobBefore / unit < 20n ? bobBefore / unit : 20n;
const withdrawals = await Promise.all(
  Array.from({ length: 20 }, (_, i) => move(tokens.bob, "withdraw", { fromAccountId: bob.id, amountPaise: Number(unit) }, `wd-${run}-${i}`)),
);
const succeeded = withdrawals.filter((r) => r.status === 201).length;
check(`exactly ${expected} of 20 withdrawals succeed`, BigInt(succeeded) === expected, `${succeeded} did`);
check("every other withdrawal is a clean 422", withdrawals.filter((r) => r.status !== 201).every((r) => r.status === 422));
const bobAfter = await balanceOf(tokens.bob);
check("Bob's balance is never negative and matches", bobAfter >= 0n && bobAfter === bobBefore - BigInt(succeeded) * unit);
if (succeeded > 0) {
  const refund = await move(tokens.admin, "deposit", { toAccountId: bob.id, amountPaise: succeeded * Number(unit) }, `refund-${run}`);
  check("admin deposit puts the money back", refund.status === 201 && (await balanceOf(tokens.bob)) === bobBefore);
}

// 5. The books still balance, as recomputed from the ledger.
const reconcile = await call("GET", "/api/ledger/reconcile", { token: tokens.auditor });
check("reconcile reports the books balanced, no problems", reconcile.body?.balanced === true && reconcile.body.problems.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${API_URL}`);
process.exit(failed.length === 0 ? 0 : 1);
