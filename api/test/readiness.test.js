import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/create-app.js";

const READY_FIELDS = ["database", "rateLimiter", "rateLimiterBackend", "status"];

// Serves createApp over a real socket with a fake pool, so no database is needed.
async function getReady(query, ready = Promise.resolve()) {
  const app = createApp({ query }, { jwtSecret: "x".repeat(64), ready });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}

const fails = (message, code) => async () => {
  throw Object.assign(new Error(message), { code });
};

test("readiness: healthy database and rate_limit_buckets answer 200 with stable fields", async () => {
  const { status, text } = await getReady(async () => ({ rows: [] }));
  const body = JSON.parse(text);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), READY_FIELDS);
  assert.deepEqual(body, { status: "healthy", database: "connected", rateLimiter: "ready", rateLimiterBackend: "postgres" });
});

test("readiness: a missing rate_limit_buckets table answers 503 degraded, not healthy", async () => {
  const query = async (sql) => {
    if (sql.includes("rate_limit_buckets")) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
    return { rows: [] };
  };
  const { status, text } = await getReady(query);
  assert.equal(status, 503);
  assert.deepEqual(JSON.parse(text), { status: "degraded", database: "connected", rateLimiter: "degraded", rateLimiterBackend: "memory_fallback" });
});

test("THREAT readiness leak: an unreachable database answers 503 without the driver's message, host, role or stack", async () => {
  const secretMessage = 'password authentication failed for user "ledgerproof_app" at db.secret-host.example:6543';
  const { status, text } = await getReady(fails(secretMessage, "28P01"));
  const body = JSON.parse(text);
  assert.equal(status, 503);
  assert.deepEqual(Object.keys(body).sort(), READY_FIELDS);
  assert.equal(body.status, "degraded");
  assert.equal(body.database, "unreachable");
  for (const leak of ["secret-host", "ledgerproof_app", "password", "6543", "28P01", "at "]) {
    assert.ok(!text.includes(leak), `response must not contain ${leak}`);
  }
});

test("THREAT readiness leak: an unexpected rate limiter error after a good SELECT 1 still hides the message", async () => {
  const query = async (sql) => {
    if (sql.includes("rate_limit_buckets")) throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432"), { code: "ECONNREFUSED" });
    return { rows: [] };
  };
  const { status, text } = await getReady(query);
  assert.equal(status, 503);
  assert.equal(JSON.parse(text).database, "connected");
  assert.ok(!text.includes("10.1.2.3"));
});

test("THREAT readiness leak: a failed startup role check answers 503 with stable fields, not a 500 or its message", async () => {
  const ready = Promise.reject(new Error('connected as role "postgres", expected ledgerproof_app'));
  ready.catch(() => {});
  const { status, text } = await getReady(async () => ({ rows: [] }), ready);
  const body = JSON.parse(text);
  assert.equal(status, 503);
  assert.deepEqual(Object.keys(body).sort(), READY_FIELDS);
  assert.equal(body.database, "startup_check_failed");
  assert.ok(!text.includes("postgres") && !text.includes("ledgerproof_app"));
});
