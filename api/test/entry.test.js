import { test } from "node:test";
import assert from "node:assert/strict";
import { appDatabaseUrl, requireTestDatabase } from "./helpers.js";

test("the deployed entry point answers without disclosing the framework", async () => {
  requireTestDatabase();
  process.env.DATABASE_URL = appDatabaseUrl();
  process.env.JWT_SECRET = "x".repeat(40);
  const { default: app } = await import("../src/index.js");
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/me`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-powered-by"), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
