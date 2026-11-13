import { test } from "node:test";
import assert from "node:assert/strict";
import { isTokenRevoked, revokeToken } from "../src/auth.js";
import { checkRateLimiterHealth } from "../src/rate-limit.js";

// A pool whose schema lacks the table (42P01) or whose role lacks the grant (42501).
const brokenPool = (code) => ({
  query: async () => {
    throw Object.assign(new Error("schema problem"), { code });
  },
});

for (const code of ["42P01", "42501"]) {
  test(`THREAT logout fails open: revocation check refuses to say "not revoked" when revoked_tokens is unusable (${code})`, async () => {
    await assert.rejects(isTokenRevoked(brokenPool(code), "jti-never-seen"), { code });
  });

  test(`THREAT logout fails open: logout reports failure instead of silently skipping the shared revocation write (${code})`, async () => {
    const decoded = { jti: `jti-${code}`, sub: "00000000-0000-4000-8000-000000000001", exp: Math.floor(Date.now() / 1000) + 60 };
    await assert.rejects(revokeToken(brokenPool(code), decoded), { code });
  });

  test(`readiness does not call a missing rate_limit_buckets table "ready" (${code})`, async () => {
    const health = await checkRateLimiterHealth(brokenPool(code));
    assert.equal(health.status, "degraded");
    assert.equal(health.backend, "memory_fallback");
  });
}
