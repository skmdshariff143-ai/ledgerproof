import { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createApp } from "../src/app.js";
import { seed } from "../scripts/seed.js";

const url = process.env.TEST_DATABASE_URL;
const schemaSql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
const jwtSecret = randomBytes(32).toString("hex");
let server, baseUrl;
// Live binding: importers see the pool once before() has created it.
export let pool;

// Each test gets a fresh schema, the demo seed, and the API on a random local port.
export function useSeededServer() {
  before(() => {
    // These tests wipe the database, so refuse anything not named *_test.
    assert.ok(url && new URL(url).pathname.endsWith("_test"), "TEST_DATABASE_URL must point to a *_test database");
    pool = new pg.Pool({ connectionString: url, max: 25 });
  });
  after(() => pool.end());
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(schemaSql);
    await seed(pool);
    server = createApp(pool, { jwtSecret }).listen(0);
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
  return { status: res.status, headers: res.headers, body: await res.json() };
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
