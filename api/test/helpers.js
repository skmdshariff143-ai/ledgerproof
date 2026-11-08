import { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createApp } from "../src/app.js";
import { seed } from "../scripts/seed.js";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const readSql = (file) => readFileSync(new URL(`../../db/${file}`, import.meta.url), "utf8");
const schemaSql = readSql("schema.sql");
export const rolesSql = readSql("roles.sql");
const jwtSecret = randomBytes(32).toString("hex");
export const ALLOWED_ORIGIN = "http://localhost:5173";
const APP_ROLE_PASSWORD = "test-only-password";
let server, baseUrl;
// Live bindings: importers see the pools once before() has created them.
// `pool` is the owner connection (wipes, seeds, assertions); `appPool` is the restricted role the API uses.
export let pool;
export let appPool;

// These tests wipe the database, so refuse anything not named *_test.
export function requireTestDatabase() {
  assert.ok(testDatabaseUrl && new URL(testDatabaseUrl).pathname.endsWith("_test"), "TEST_DATABASE_URL must point to a *_test database");
}

// Connection string for ledgerproof_app, the role the deployed API connects as.
export function appDatabaseUrl() {
  const appUrl = new URL(testDatabaseUrl);
  appUrl.username = "ledgerproof_app";
  appUrl.password = APP_ROLE_PASSWORD;
  return appUrl.toString();
}

// A fresh schema, then the restricted role, exactly as in a real deployment.
export async function resetDatabase(admin) {
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.query(schemaSql);
  await admin.query(rolesSql);
  await admin.query(`ALTER ROLE ledgerproof_app WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
}

// Each test gets a fresh schema, the demo seed, and the API (as the restricted role) on a random local port.
export function useSeededServer() {
  before(() => {
    requireTestDatabase();
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 25 });
    appPool = new pg.Pool({ connectionString: appDatabaseUrl(), max: 25 });
  });
  after(async () => {
    await appPool.end();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await seed(pool);
    server = createApp(appPool, { jwtSecret, allowedOrigins: [ALLOWED_ORIGIN] }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));
}

export async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const PASSWORDS = {
  admin: ["admin@ledgerline.com", "Admin@123"],
  alice: ["alice@ledgerline.com", "Alice@123"],
  bob: ["bob@ledgerline.com", "Bob@123"],
  auditor: ["auditor@ledgerline.com", "Auditor@123"],
};

export async function tokenFor(who) {
  const [email, password] = PASSWORDS[who];
  const res = await call("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(res.status, 200);
  return res.body.token;
}

export async function accountOf(email) {
  const { rows } = await pool.query(
    "SELECT a.id, a.balance_paise::int AS balance FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.email = $1",
    [email],
  );
  return rows[0];
}

export async function vaultId() {
  const { rows } = await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'");
  return rows[0].id;
}

export async function auditRows(outcome, action) {
  const { rows } = await pool.query(
    `SELECT u.email, l.actor_role, l.target FROM audit_log l LEFT JOIN users u ON u.id = l.actor_user_id
      WHERE l.outcome = $1 AND l.action = $2 ORDER BY l.id`,
    [outcome, action],
  );
  return rows;
}
