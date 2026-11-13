import { test } from "node:test";
import assert from "node:assert/strict";
import { isTokenRevoked, revokeToken } from "../src/auth.js";
import { checkRateLimiterHealth } from "../src/rate-limit.js";

// Missing table (42P01) and missing grant (42501): the two ways an unmigrated database fails.
const SCHEMA_ERRORS = ["42P01", "42501"];

// A pool whose schema lacks the table or whose role lacks the grant.
const brokenPool = (code) => ({
  query: async () => {
    throw Object.assign(new Error("schema problem"), { code });
  },
});

test("THREAT logout fails open: the revocation check refuses to say not revoked when revoked_tokens is missing or not granted", async () => {
  for (const code of SCHEMA_ERRORS) {
    await assert.rejects(isTokenRevoked(brokenPool(code), "jti-never-seen"), { code });
  }
});

test("THREAT logout fails open: logout reports failure instead of silently skipping the shared revocation write", async () => {
  for (const code of SCHEMA_ERRORS) {
    const decoded = { jti: `jti-${code}`, sub: "00000000-0000-4000-8000-000000000001", exp: Math.floor(Date.now() / 1000) + 60 };
    await assert.rejects(revokeToken(brokenPool(code), decoded), { code });
  }
});

test("readiness does not call a missing or ungranted rate_limit_buckets table ready", async () => {
  for (const code of SCHEMA_ERRORS) {
    assert.deepEqual(await checkRateLimiterHealth(brokenPool(code)), { status: "degraded", backend: "memory_fallback" });
  }
});
