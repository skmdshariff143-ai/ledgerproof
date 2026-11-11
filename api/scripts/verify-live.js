// End-to-end production & local verification suite (`npm run verify:live`).
// Separates RBAC, registration, onboarding, audit-chain, and reconciliation checks.
// Never counts a legacy fallback or skipped assertion as a pass: each has its own status
// (PASS, FAIL, PENDING_MIGRATION, SKIPPED) and exits non-zero unless all executed checks PASS.
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

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(18)} ${name}${detail ? `  (${detail})` : ""}`);
}

try {
  // 1. Health & Readiness probes
  const health = await call("GET", "/health");
  record("GET /health -> 200 OK", health.status === 200 && health.body?.status === "ok" ? "PASS" : "FAIL");

  const ready = await call("GET", "/ready");
  const rlBackend = ready.body?.rateLimiterBackend;
  record(
    "GET /ready -> 200 OK (database connected)",
    ready.status === 200 && ready.body?.status === "healthy" && ready.body?.database === "connected" ? "PASS" : "FAIL",
    rlBackend ? `rateLimiterBackend=${rlBackend}` : "",
  );

  // 2. System initialization state
  const sysStatus = await call("GET", "/api/system/status");
  record(
    "GET /api/system/status -> returns initialization state",
    sysStatus.status === 200 && sysStatus.body?.initialized === true && sysStatus.body?.adminCount >= 1 ? "PASS" : "FAIL",
  );

  if (webUrl) {
    const webRes = await fetch(webUrl);
    record(`GET ${webUrl} -> 200 OK`, webRes.status === 200 ? "PASS" : "FAIL");
  }

  // 3. Admin & Holder logins
  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: DEMO.admin[0], password: DEMO.admin[1] },
  });
  record(
    "Admin login -> 200 OK with JWT",
    adminLogin.status === 200 && typeof adminLogin.body?.token === "string" ? "PASS" : "FAIL",
  );
  const adminToken = adminLogin.body?.token;

  const aliceLogin = await call("POST", "/api/auth/login", {
    body: { email: DEMO.alice[0], password: DEMO.alice[1] },
  });
  const bobLogin = await call("POST", "/api/auth/login", {
    body: { email: DEMO.bob[0], password: DEMO.bob[1] },
  });
  const aliceToken = aliceLogin.body?.token;
  const bobToken = bobLogin.body?.token;

  // 4. Cryptographic SHA-256 audit hash-chain verification (reports PENDING_MIGRATION if columns missing)
  const verifyChain = await call("GET", "/api/admin/audit-logs/verify", { token: adminToken });
  if (verifyChain.status === 200 && verifyChain.body?.schemaMigrated === false) {
    record(
      "GET /api/admin/audit-logs/verify -> stored SHA-256 chain",
      "PENDING_MIGRATION",
      `reason=${verifyChain.body?.reason}, entries=${verifyChain.body?.totalEntries}`,
    );
  } else {
    record(
      "GET /api/admin/audit-logs/verify -> 200 OK with { verified: true }",
      verifyChain.status === 200 && verifyChain.body?.verified === true && verifyChain.body?.totalEntries >= 1 ? "PASS" : "FAIL",
      `entries=${verifyChain.body?.totalEntries}, head=${verifyChain.body?.headHash?.slice(0, 12)}...`,
    );
  }

  // 5. RBAC check (strictly separate from registration/onboarding)
  const forbiddenAdmin = await call("GET", "/api/admin/users", { token: aliceToken });
  record(
    "RBAC: ACCOUNT_HOLDER access to /api/admin/users -> 403 Forbidden",
    forbiddenAdmin.status === 403 ? "PASS" : "FAIL",
  );

  // 6. Registration & 7. KYC Onboarding Gate (never substituted with an RBAC check)
  const aliceAcc = (await call("GET", "/api/accounts", { token: aliceToken })).body.accounts[0];
  const bobAcc = (await call("GET", "/api/accounts", { token: bobToken })).body.accounts[0];

  const kycEmail = `kyc.verify.${runId}@ledgerline.com`;
  const regRes = await call("POST", "/api/auth/register", {
    body: { email: kycEmail, password: "KycVerify@123" },
  });
  if (regRes.status === 201) {
    record(
      "Registration: POST /api/auth/register creates PENDING_KYC user & 0-balance account",
      regRes.body?.user?.status?.toUpperCase() === "PENDING_KYC" && regRes.body?.account?.balance_paise === "0" ? "PASS" : "FAIL",
    );
    const kycTransfer = await call("POST", "/api/transactions/transfer", {
      token: regRes.body.token,
      body: { fromAccountId: regRes.body.account.id, toAccountId: aliceAcc.id, amountPaise: 100 },
      key: `kyc-block-${runId}`,
    });
    record(
      "Onboarding Gate: PENDING_KYC transfer attempt -> 403 KYC_PENDING",
      kycTransfer.status === 403 && kycTransfer.body?.error?.code === "KYC_PENDING" ? "PASS" : "FAIL",
    );
    const approveRes = await call("POST", `/api/admin/users/${regRes.body.user.id}/approve`, {
      token: adminToken,
    });
    record(
      "Onboarding Approval: POST /api/admin/users/:id/approve -> 200 OK (ACTIVE)",
      approveRes.status === 200 &&
        approveRes.body?.user?.status?.toUpperCase() === "ACTIVE" &&
        approveRes.body?.account?.status?.toUpperCase() === "ACTIVE"
        ? "PASS"
        : "FAIL",
    );
  } else {
    record(
      "Registration: POST /api/auth/register creates PENDING_KYC user & 0-balance account",
      "PENDING_MIGRATION",
      `status=${regRes.status} (target database requires npm run db:migrate)`,
    );
    record(
      "Onboarding Gate: PENDING_KYC transfer attempt -> 403 KYC_PENDING",
      "SKIPPED",
      "skipped because registration requires database migration",
    );
    record(
      "Onboarding Approval: POST /api/admin/users/:id/approve -> 200 OK (ACTIVE)",
      "SKIPPED",
      "skipped because registration requires database migration",
    );
  }

  // 8. Valid idempotent double-entry transfer + balance reconciliation
  const aliceBefore = BigInt(aliceAcc.balance_paise);
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
  const aliceMid = BigInt((await call("GET", "/api/accounts", { token: aliceToken })).body.accounts[0].balance_paise);
  await call("POST", "/api/transactions/transfer", {
    token: bobToken,
    body: { fromAccountId: bobAcc.id, toAccountNumber: aliceAcc.account_number, amountPaise: 500 },
    key: `verify-return-${runId}`,
  });

  record(
    "Approved Holder Transfer & Idempotent Replay -> single debit & matching transactionId",
    t1.status === 201 &&
      t2.status === 201 &&
      t1.body?.transactionId === t2.body?.transactionId &&
      t2.headers.get("Idempotent-Replayed") === "true" &&
      aliceBefore - aliceMid === 500n
      ? "PASS"
      : "FAIL",
    `txId=${t1.body?.transactionId}`,
  );

  const reconcile = await call("GET", "/api/ledger/reconcile", { token: adminToken });
  const isBalanced =
    reconcile.status === 200 &&
    reconcile.body?.balanced === true &&
    reconcile.body?.totals?.debits_paise === reconcile.body?.totals?.credits_paise &&
    reconcile.body?.problems?.length === 0;

  record(
    "GET /api/ledger/reconcile -> 200 OK with balanced=true and SUM(debits) == SUM(credits)",
    isBalanced ? "PASS" : "FAIL",
    `debits=${reconcile.body?.totals?.debits_paise}, credits=${reconcile.body?.totals?.credits_paise}`,
  );

  // 9. Post-write stored audit hash check (verifies stored entry_hash on both historical and newly appended rows)
  const auditList = await call("GET", "/api/admin/audit-logs?limit=200", { token: adminToken });
  const logs = auditList.body?.entries ?? [];
  const newestRow = logs[0];
  const oldestRow = logs[logs.length - 1];
  const verifyAfter = await call("GET", "/api/admin/audit-logs/verify", { token: adminToken });
  if (verifyAfter.status === 200 && verifyAfter.body?.schemaMigrated === false) {
    record(
      "Stored Audit Hashes (historical + newly appended rows)",
      "PENDING_MIGRATION",
      `reason=${verifyAfter.body?.reason}`,
    );
  } else {
    const hex64 = /^[0-9a-f]{64}$/;
    const hasStoredHashes =
      logs.length >= 2 &&
      hex64.test(oldestRow?.entry_hash ?? "") &&
      hex64.test(newestRow?.entry_hash ?? "") &&
      oldestRow.id !== newestRow.id &&
      verifyAfter.body?.verified === true;
    record(
      "Stored Audit Hashes: historical & newly appended rows carry verified SHA-256 entry_hash",
      hasStoredHashes ? "PASS" : "FAIL",
      `oldestId=${oldestRow?.id}, newestId=${newestRow?.id}, total=${verifyAfter.body?.totalEntries}`,
    );
  }
} finally {
  if (localServer) await new Promise((resolve) => localServer.close(resolve));
  if (localPool) await localPool.end();
}

const counts = {
  PASS: results.filter((r) => r.status === "PASS").length,
  FAIL: results.filter((r) => r.status === "FAIL").length,
  PENDING_MIGRATION: results.filter((r) => r.status === "PENDING_MIGRATION").length,
  SKIPPED: results.filter((r) => r.status === "SKIPPED").length,
};
console.log(
  `\nSummary against ${baseUrl}: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.PENDING_MIGRATION} PENDING_MIGRATION, ${counts.SKIPPED} SKIPPED`,
);
process.exit(counts.FAIL === 0 && counts.PENDING_MIGRATION === 0 ? 0 : 1);
