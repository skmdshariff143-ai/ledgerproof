import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { appDatabaseUrl, jwtSecret, useSeededServer } from "./helpers.js";

useSeededServer();

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// A separate Node process has its own revoked-token cache, like a separate serverless instance.
async function startInstance() {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/local.js", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: appDatabaseUrl(), JWT_SECRET: jwtSecret, PORT: String(port), NODE_ENV: "test", VERCEL: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => String(chunk).includes("listening") && resolve());
    child.once("exit", (code) => reject(new Error(`API instance exited early with code ${code}`)));
  });
  const request = async (method, path, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { request, stop: () => child.kill() };
}

test("THREAT cross-instance revocation: a token revoked through one API process is refused by another process that never saw the logout", async () => {
  const [a, b] = await Promise.all([startInstance(), startInstance()]);
  try {
    const login = await a.request("POST", "/api/auth/login", { body: { email: "alice@ledgerline.com", password: "Alice@123" } });
    assert.equal(login.status, 200);
    const token = login.body.token;
    assert.equal((await a.request("GET", "/api/me", { token })).status, 200);

    assert.equal((await b.request("POST", "/api/auth/logout", { token })).status, 200);

    // Instance A's cache has never held this token, so only the shared revoked_tokens row can refuse it.
    const reuse = await a.request("GET", "/api/me", { token });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error.code, "UNAUTHENTICATED");
  } finally {
    a.stop();
    b.stop();
  }
});
