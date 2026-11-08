import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { appPool, call, pool, useSeededServer } from "./helpers.js";

useSeededServer();

const FORGED = "203.0.113.9";

const wrongLoginBody = { email: "alice@ledgerline.com", password: "wrong" };

const loggedIps = async () => (await pool.query("SELECT ip FROM audit_log WHERE action = 'login' ORDER BY id")).rows.map((r) => r.ip);

test("THREAT forged client IP: X-Forwarded-For is ignored unless the API sits behind a trusted proxy", async () => {
  await call("POST", "/api/auth/login", { body: wrongLoginBody, headers: { "X-Forwarded-For": FORGED } });
  assert.ok(!(await loggedIps()).includes(FORGED), "a client must not be able to choose the address recorded for it");

  const behindProxy = createApp(appPool, { jwtSecret: "x".repeat(32), trustProxy: 1 }).listen(0);
  await new Promise((resolve) => behindProxy.once("listening", resolve));
  try {
    await fetch(`http://127.0.0.1:${behindProxy.address().port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": FORGED },
      body: JSON.stringify(wrongLoginBody),
    });
  } finally {
    await new Promise((resolve) => behindProxy.close(resolve));
  }
  assert.ok((await loggedIps()).includes(FORGED), "behind the trusted proxy, the forwarded address is the one recorded");
});
