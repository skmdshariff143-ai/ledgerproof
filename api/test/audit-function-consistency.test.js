import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migrate } from "../scripts/migrate.js";
import { appPool, call, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const NEXTVAL = "NEW.id := nextval('audit_log_id_seq')";

// The body production ran before the id was taken under the lock (kept here only to prove an upgrade replaces it).
const OLD_BODY = `CREATE OR REPLACE FUNCTION chain_audit_log() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev text; payload text; iso_ts text;
BEGIN
  PERFORM pg_advisory_xact_lock(20261110);
  SELECT entry_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE;
  NEW.previous_hash := COALESCE(prev, 'GENESIS_LEDGERPROOF_2026');
  iso_ts := to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  payload := NEW.previous_hash || '|' || NEW.id::text || '|' || COALESCE(NEW.actor_user_id::text, 'ANONYMOUS')
             || '|' || COALESCE(NEW.actor_role, 'ANONYMOUS') || '|' || NEW.action
             || '|' || COALESCE(NEW.target, '') || '|' || COALESCE(NEW.details::text, '{}')
             || '|' || iso_ts;
  NEW.entry_hash := encode(sha256(convert_to(payload, 'UTF8')), 'hex');
  RETURN NEW;
END; $$;`;

const functionSource = async () => (await pool.query("SELECT prosrc FROM pg_proc WHERE proname = 'chain_audit_log'")).rows[0].prosrc;

test("THREAT old audit function restored by a later migration: the only definitions in the repo take the id after the lock", () => {
  for (const file of ["../../db/schema.sql", "../scripts/migrate.js"]) {
    const parts = source(file).split(/CREATE (?:OR REPLACE )?FUNCTION chain_audit_log\(\)/);
    assert.equal(parts.length, 2, `${file} must define chain_audit_log() exactly once`);
    const body = parts[1].slice(0, parts[1].indexOf("END;"));
    assert.ok(body.includes(NEXTVAL), `${file} must take the id with nextval`);
    assert.ok(body.indexOf("pg_advisory_xact_lock") < body.indexOf(NEXTVAL), `${file} must take the id after the advisory lock`);
  }
});

test("THREAT old audit function restored by a later migration: a fresh install and an upgrade of the old body both end with the corrected function", async () => {
  assert.ok((await functionSource()).includes(NEXTVAL), "fresh install (schema.sql) installs the corrected function");

  await pool.query(OLD_BODY);
  assert.ok(!(await functionSource()).includes(NEXTVAL), "test setup: the old body is installed");

  assert.deepEqual(await migrate(pool), { applied: false, upgraded: true });
  assert.ok((await functionSource()).includes(NEXTVAL), "the upgrade replaces the old body");

  assert.deepEqual(await migrate(pool), { applied: false, upgraded: true });
  assert.ok((await functionSource()).includes(NEXTVAL), "running the upgrade again keeps the corrected body");
});

test("audit verification accepts gaps in the id sequence, and normal audited requests work as the restricted role", async () => {
  assert.equal((await appPool.query("SELECT current_user AS u")).rows[0].u, "ledgerproof_app", "the API pool is the restricted role");

  // Consume ids two ways: directly, and by an audit insert that is rolled back (as a failed request would).
  await pool.query("SELECT nextval('audit_log_id_seq'), nextval('audit_log_id_seq')");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO audit_log (actor_role, action, outcome) VALUES ('synthetic', 'rolled_back_check', 'success')");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const token = await tokenFor("admin");
  assert.equal((await call("GET", "/api/audit-logs", { token })).status, 200);
  assert.equal((await call("GET", "/api/audit-logs", { token })).status, 200);

  const { rows } = await pool.query("SELECT count(*)::int AS n, max(id)::int AS max_id FROM audit_log");
  assert.ok(rows[0].max_id - rows[0].n >= 4, `expected id gaps, got ${rows[0].n} rows with max id ${rows[0].max_id}`);

  const verify = await call("GET", "/api/admin/audit-logs/verify", { token });
  assert.equal(verify.body.verified, true);
  assert.equal(verify.body.totalEntries, rows[0].n, "every persisted row is walked");
});

test("THREAT audit rows altered past the triggers: a changed hash, link or payload is caught on the first, a middle and the last row", async () => {
  const token = await tokenFor("admin");
  for (let i = 0; i < 3; i++) await call("GET", "/api/audit-logs", { token });
  const ids = (await pool.query("SELECT id::int FROM audit_log ORDER BY id")).rows.map((r) => r.id);
  const edits = [
    ["first row hash", ids[0], "UPDATE audit_log SET entry_hash = repeat('0', 64) WHERE id = $1"],
    ["middle row link", ids[Math.floor(ids.length / 2)], "UPDATE audit_log SET previous_hash = repeat('1', 64) WHERE id = $1"],
    ["last row payload", ids.at(-1), "UPDATE audit_log SET details = '{\"forged\":true}'::jsonb WHERE id = $1"],
  ];

  const alter = async (sql, params) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(sql, params);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  };

  for (const [label, id, sql] of edits) {
    const original = (await pool.query("SELECT entry_hash, previous_hash, details FROM audit_log WHERE id = $1", [id])).rows[0];
    await alter(sql, [id]);
    const verify = await call("GET", "/api/admin/audit-logs/verify", { token });
    assert.equal(verify.body.verified, false, `${label} must be reported`);
    assert.equal(verify.body.tamperedSeq, id, `${label} must be pinpointed`);
    await alter("UPDATE audit_log SET entry_hash = $2, previous_hash = $3, details = $4 WHERE id = $1", [id, original.entry_hash, original.previous_hash, original.details]);
    assert.equal((await call("GET", "/api/admin/audit-logs/verify", { token })).body.verified, true, `${label}: restored chain verifies again`);
  }
});
