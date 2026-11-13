import { test } from "node:test";
import assert from "node:assert/strict";
import { call, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

test("THREAT audit chain race: audit rows written at the same moment still form one verifiable chain", async () => {
  const token = await tokenFor("admin");

  // Each of these requests writes one audit row. Sent together, their inserts overlap.
  const reads = await Promise.all(Array.from({ length: 30 }, () => call("GET", "/api/audit-logs", { token })));
  for (const res of reads) assert.equal(res.status, 200);

  const verify = await call("GET", "/api/admin/audit-logs/verify", { token });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.verified, true, `chain reported broken at entry ${verify.body.tamperedSeq}`);
});
