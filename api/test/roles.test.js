import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { seed } from "../scripts/seed.js";
import { createApp } from "../src/app.js";
import { assertRestrictedRole } from "../src/role-check.js";
import { appDatabaseUrl, requireTestDatabase, resetDatabase, rolesSql, testDatabaseUrl } from "./helpers.js";

// `owner` is the schema owner; `app` connects as ledgerproof_app, the role the deployed API uses.
let owner;
let app;

before(() => {
  requireTestDatabase();
  owner = new pg.Pool({ connectionString: testDatabaseUrl, max: 3 });
  app = new pg.Pool({ connectionString: appDatabaseUrl(), max: 3 });
});

after(async () => {
  await owner.query("DROP OWNED BY anon; DROP ROLE IF EXISTS anon").catch(() => {});
  await app.end();
  await owner.end();
});

beforeEach(async () => {
  await resetDatabase(owner);
  await seed(owner);
});

const totalBalance = async () => (await owner.query("SELECT sum(balance_paise)::text AS total FROM accounts")).rows[0].total;
const DENIED = /permission denied|must be owner/;

test("the tests really connect as the restricted role, which is neither superuser nor table owner", async () => {
  const { rows } = await app.query(
    `SELECT current_user AS who,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
            (SELECT tableowner FROM pg_tables WHERE tablename = 'accounts') AS owner`,
  );
  assert.equal(rows[0].who, "ledgerproof_app");
  assert.equal(rows[0].is_superuser, false);
  assert.notEqual(rows[0].owner, "ledgerproof_app");
});

test("THREAT app role cannot tamper: no balance, owner, role or history edits, no trigger or schema changes", async () => {
  const attacks = [
    "UPDATE accounts SET balance_paise = balance_paise + 100000000",
    "UPDATE accounts SET owner_id = (SELECT id FROM users LIMIT 1)",
    "DELETE FROM accounts",
    "UPDATE users SET role = 'admin'",
    "DELETE FROM users",
    "UPDATE ledger_entries SET amount_paise = 1",
    "DELETE FROM audit_log",
    "TRUNCATE ledger_entries",
    "ALTER TABLE accounts DISABLE TRIGGER ALL",
    "DROP TRIGGER ledger_entries_apply ON ledger_entries",
    "DROP TABLE audit_log",
    "SET session_replication_role = replica",
    "CREATE TABLE public.sneaky (a int)",
  ];
  const before = await totalBalance();
  // Postgres makes a GRANT by a role without grant option a warning and a no-op, not an error; the
  // attacks below (DELETE FROM accounts) still being refused is what proves it granted nothing.
  await app.query("GRANT ALL ON accounts TO PUBLIC");
  for (const sql of attacks) await assert.rejects(app.query(sql), DENIED, `must be refused: ${sql}`);
  assert.equal(await totalBalance(), before);
});

test("THREAT temp trigger mint: a trigger on a temp table cannot be used to change balances", async () => {
  // The attack the Phase 1 security review ran: a trigger body runs with the caller's rights,
  // so it only works if the caller may update balances. The app role may not.
  const before = await totalBalance();
  const client = await app.connect();
  try {
    await client.query("CREATE TEMP TABLE bait (a int)");
    await client.query(
      `CREATE FUNCTION pg_temp.mint() RETURNS trigger LANGUAGE plpgsql AS
       $$ BEGIN UPDATE accounts SET balance_paise = 100000000; RETURN NEW; END $$`,
    );
    await client.query("CREATE TRIGGER bait_mint BEFORE INSERT ON bait FOR EACH ROW EXECUTE FUNCTION pg_temp.mint()");
    await assert.rejects(client.query("INSERT INTO bait VALUES (1)"), DENIED);
  } finally {
    client.release();
  }
  assert.equal(await totalBalance(), before);
});

test("the app role can still do exactly what the routes need, and the ledger trigger moves balances for it", async () => {
  const { rows: accounts } = await app.query("SELECT id, account_type FROM accounts ORDER BY account_type");
  const vault = accounts.find((a) => a.account_type === "system_vault").id;
  const holder = accounts.find((a) => a.account_type === "user_checking").id;
  const admin = (await app.query("SELECT id FROM users WHERE role = 'admin'")).rows[0].id;
  const balanceOf = async () => (await app.query("SELECT balance_paise::int AS b FROM accounts WHERE id = $1", [holder])).rows[0].b;
  const before = await balanceOf();
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    const tx = await client.query("INSERT INTO transactions (type, initiated_by) VALUES ('deposit', $1) RETURNING id", [admin]);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_paise)
       VALUES ($1, $2, 'debit', 700), ($1, $3, 'credit', 700)`,
      [tx.rows[0].id, vault, holder],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  assert.equal(await balanceOf(), before + 700);
  await app.query("UPDATE accounts SET status = 'frozen' WHERE id = $1", [holder]);
  await app.query("INSERT INTO accounts (account_type, owner_id) VALUES ('user_checking', (SELECT id FROM users WHERE role = 'account_holder' LIMIT 1))");
});

test("THREAT API roles: Supabase's anon, authenticated and service_role lose access to the ledger", async () => {
  await owner.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$");
  await owner.query("GRANT SELECT, UPDATE ON accounts, audit_log TO anon");
  await owner.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon");
  assert.equal((await owner.query("SELECT has_table_privilege('anon', 'accounts', 'UPDATE') AS can")).rows[0].can, true, "setup: anon starts with access");
  await owner.query(rolesSql);
  for (const table of ["accounts", "audit_log", "users", "ledger_entries"]) {
    const { rows } = await owner.query(
      "SELECT has_table_privilege('anon', $1, 'SELECT') AS can_read, has_table_privilege('anon', $1, 'UPDATE') AS can_write",
      [table],
    );
    assert.deepEqual(rows[0], { can_read: false, can_write: false }, `anon must have no access to ${table}`);
  }
  // Postgres lets everyone run new functions; the security-definer ledger trigger must not be open to the API roles.
  assert.equal((await owner.query("SELECT has_function_privilege('anon', 'apply_ledger_entry()', 'EXECUTE') AS can")).rows[0].can, false);
  // A table added later (a future migration) must not come with the access Supabase grants by default.
  await owner.query("CREATE TABLE added_later (a int)");
  assert.equal((await owner.query("SELECT has_table_privilege('anon', 'added_later', 'SELECT') AS can")).rows[0].can, false);
});

test("THREAT temp table shadow: a temp table named ledger_entries cannot hide an unbalanced transaction from the commit check", async () => {
  // The commit-time balance check reads ledger_entries. If it looked in the caller's temp schema first,
  // a fake empty table would make every transaction look balanced and money could be created.
  const before = await totalBalance();
  const holder = (await owner.query("SELECT id FROM accounts WHERE account_type = 'user_checking' LIMIT 1")).rows[0].id;
  const admin = (await owner.query("SELECT id FROM users WHERE role = 'admin'")).rows[0].id;
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE ledger_entries (transaction_id uuid, direction text, amount_paise bigint)");
    const tx = await client.query("INSERT INTO transactions (type, initiated_by) VALUES ('deposit', $1) RETURNING id", [admin]);
    await client.query(
      "INSERT INTO public.ledger_entries (transaction_id, account_id, direction, amount_paise) VALUES ($1, $2, 'credit', 999999)",
      [tx.rows[0].id, holder],
    );
    await assert.rejects(client.query("COMMIT"), /not balanced/);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  assert.equal(await totalBalance(), before);
});

test("THREAT privileged connection: the API refuses to serve when its database role has too many rights", async () => {
  await assert.rejects(assertRestrictedRole(owner), /more rights than the API needs/);
  await assert.doesNotReject(assertRestrictedRole(app));

  const ready = assertRestrictedRole(owner);
  ready.catch(() => {});
  const gated = createApp(owner, { jwtSecret: "x".repeat(32), ready }).listen(0);
  await new Promise((resolve) => gated.once("listening", resolve));
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${gated.address().port}/api/me`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL");
  } finally {
    console.error = original;
    await new Promise((resolve) => gated.close(resolve));
  }
});
