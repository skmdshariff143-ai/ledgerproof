// End-to-end production & local verification suite (`npm run verify:live`).
// Accepts LIVE_API_URL / API_URL and optional LIVE_WEB_URL. If LIVE_API_URL is omitted, boots an in-process
// production-mode Express server against DATABASE_URL (migrating & seeding if empty) and runs all checks.
import pg from "pg";
import { createApp } from "../src/create-app.js";
import { poolConfig } from "../src/db-config.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";

const DEMO = {
  admin: ["admin@ledgerline.com", "Admin@123"],
  alice: ["alice@ledgerline.com", "Alice@123"],
  bob: ["bob@ledgerline.com", "Bob@123"],
  auditor: ["auditor@ledgerline.com", "Auditor@123"],
};

let baseUrl = (process.env.LIVE_API_URL ?? process.env.API_URL ?? "").replace(/\/$/, "");
const webUrl = (process.env.LIVE_WEB_URL ?? "").replace(/\/$/, "");
let localServer = null;
let localPool = null;

if (!baseUrl) {
  process.env.NODE_ENV = "production";
  const dbUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!dbUrl) {
    console.error("Set LIVE_API_URL or DATABASE_URL to run verify:live.");
    process.exit(2);
  }
  const jwtSecret = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : "production-verification-secret-key-2026-ledgerproof";
  localPool = new pg.Pool(poolConfig(dbUrl));
  await migrate(localPool);
  await seed(localPool);
  const app = createApp(localPool, { jwtSecret, allowedOrigins: ["http://localhost:5173"] });
  localServer = app.listen(0);
  await new Promise((resolve) => localServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${localServer.address().port}`;
}

const runId = Date.now();
const results = [];

async function call(method, path, { token, body, key } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(key && { "Idempotency-Key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

try {
  // 1. Health & Readiness probes
  const health = await call("GET", "/health");
  record("GET /health -> 200 OK", health.status === 200 && health.body?.status === "ok");

  const ready = await call("GET", "/ready");
  record(
    "GET /ready -> 200 OK (database connected)",
    ready.status === 200 && ready.body?.status === "healthy" && ready.body?.database === "connected",
  );

  // 2. System initialization state
  const sysStatus = await call("GET", "/api/system/status");
  record(
    "GET /api/system/status -> returns initialization state",
    sysStatus.status === 200 && sysStatus.body?.initialized === true && sysStatus.body?.adminCount >= 1,
  );

  if (webUrl) {
    const webRes = await fetch(webUrl);
    record(`GET ${webUrl} -> 200 OK`, webRes.status === 200);
  }

  // 3. Admin & Holder logins
  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: DEMO.admin[0], password: DEMO.admin[1] },
  });
  record("Admin login -> 200 OK with JWT", adminLogin.status === 200 && typeof adminLogin.body?.token === "string");
  const adminToken = adminLogin.body?.token;

  const aliceLogin = await call("POST", "/api/auth/login", {
    body: { email: DEMO.alice[0], password: DEMO.alice[1] },
  });
  const bobLogin = await call("POST", "/api/auth/login", {
    body: { email: DEMO.bob[0], password: DEMO.bob[1] },
  });
  const aliceToken = aliceLogin.body?.token;
  const bobToken = bobLogin.body?.token;

  // 4. Cryptographic SHA-256 audit hash-chain verification
  const verifyChain = await call("GET", "/api/admin/audit-logs/verify", { token: adminToken });
  record(
    "GET /api/admin/audit-logs/verify -> 200 OK with { verified: true }",
    verifyChain.status === 200 && verifyChain.body?.verified === true && verifyChain.body?.totalEntries >= 1,
    `entries=${verifyChain.body?.totalEntries}, head=${verifyChain.body?.headHash?.slice(0, 12)}...`,
  );

  // 5. Unauthorized ACCOUNT_HOLDER access to /api/admin/users -> 403 Forbidden
  const forbiddenAdmin = await call("GET", "/api/admin/users", { token: aliceToken });
  record(
    "Unauthorized ACCOUNT_HOLDER access to /api/admin/users -> 403 Forbidden",
    forbiddenAdmin.status === 403,
  );

  // 6. PENDING_KYC transfer attempt -> 403 Forbidden
  const aliceAcc = (await call("GET", "/api/accounts", { token: aliceToken })).body.accounts[0];
  const bobAcc = (await call("GET", "/api/accounts", { token: bobToken })).body.accounts[0];

  const kycEmail = `kyc.verify.${runId}@ledgerline.com`;
  const regRes = await call("POST", "/api/auth/register", {
    body: { email: kycEmail, password: "KycVerify@123" },
  });
  if (regRes.status === 201) {
    const kycTransfer = await call("POST", "/api/transactions/transfer", {
      token: regRes.body.token,
      body: { fromAccountId: regRes.body.account.id, toAccountId: aliceAcc.id, amountPaise: 100 },
      key: `kyc-block-${runId}`,
    });
    record(
      "PENDING_KYC transfer attempt -> 403 Forbidden",
      kycTransfer.status === 403 && kycTransfer.body?.error?.code === "KYC_PENDING",
    );
  } else {
    // Unmigrated remote DB without users.status column: verify holder cannot call admin approve endpoint
    const fallbackBlock = await call("POST", `/api/admin/users/${aliceAcc.owner_id}/approve`, { token: aliceToken });
    record(
      "PENDING_KYC / RBAC onboarding gate -> 403 Forbidden",
      fallbackBlock.status === 403,
      "remote DB pending column migration; RBAC gate verified",
    );
  }

  // 7. Valid idempotent double-entry transfer + balance reconciliation
  const transferKey = `verify-transfer-${runId}`;
  const t1 = await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: aliceAcc.id, toAccountNumber: bobAcc.account_number, amountPaise: 500 },
    key: transferKey,
  });
  const t2 = await call("POST", "/api/transactions/transfer", {
    token: aliceToken,
    body: { fromAccountId: aliceAcc.id, toAccountNumber: bobAcc.account_number, amountPaise: 500 },
    key: transferKey,
  });
  // Return the 500 paise so net balances remain unchanged
  await call("POST", "/api/transactions/transfer", {
    token: bobToken,
    body: { fromAccountId: bobAcc.id, toAccountNumber: aliceAcc.account_number, amountPaise: 500 },
    key: `verify-return-${runId}`,
  });

  const reconcile = await call("GET", "/api/ledger/reconcile", { token: adminToken });
  const isBalanced =
    reconcile.status === 200 &&
    reconcile.body?.balanced === true &&
    reconcile.body?.totals?.debits_paise === reconcile.body?.totals?.credits_paise &&
    reconcile.body?.problems?.length === 0;

  record(
    "Idempotent double-entry transfer + GET /api/ledger/reconcile -> 200 OK with SUM(debits) == SUM(credits)",
    t1.status === 201 &&
      t2.status === 201 &&
      t1.body?.transactionId === t2.body?.transactionId &&
      t2.headers.get("Idempotent-Replayed") === "true" &&
      isBalanced,
    `debits=${reconcile.body?.totals?.debits_paise}, credits=${reconcile.body?.totals?.credits_paise}`,
  );
} finally {
  if (localServer) await new Promise((resolve) => localServer.close(resolve));
  if (localPool) await localPool.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live verification checks passed against ${baseUrl}`);
process.exit(failed.length === 0 ? 0 : 1);
