import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { poolConfig } from "../src/db-config.js";

const UPGRADE_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_id uuid GENERATED ALWAYS AS (owner_id) STORED;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance bigint GENERATED ALWAYS AS (balance_paise) STORED;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check CHECK (lower(status) IN ('pending_kyc', 'active', 'frozen'));

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key text UNIQUE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'POSTED';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount bigint;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_account_id uuid REFERENCES accounts (id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS destination_account_id uuid REFERENCES accounts (id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference text;

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS amount bigint GENERATED ALWAYS AS (amount_paise) STORED;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS balance_after bigint GENERATED ALWAYS AS (running_balance_paise) STORED;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS (id) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id uuid GENERATED ALWAYS AS (actor_user_id) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_type text GENERATED ALWAYS AS (CASE WHEN position(':' in target) > 0 THEN split_part(target, ':', 1) ELSE NULL END) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_id text GENERATED ALWAYS AS (target) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address text GENERATED ALWAYS AS (ip) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS metadata jsonb GENERATED ALWAYS AS (details) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS previous_hash text NOT NULL DEFAULT 'GENESIS_LEDGERPROOF_2026';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash text;

CREATE OR REPLACE VIEW audit_logs AS SELECT * FROM audit_log;

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        text PRIMARY KEY,
  user_id    uuid REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON revoked_tokens (expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  points     int NOT NULL DEFAULT 1,
  reset_at   timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION chain_audit_log() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prev text;
  payload text;
  iso_ts text;
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
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION chain_audit_log();
`;

// Uses DIRECT_URL (port 5432) or OWNER_DATABASE_URL for DDL migrations, falling back to DATABASE_URL locally.
export async function migrate(pool) {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS users");
  if (!rows[0].users) {
    for (const file of ["schema.sql", "roles.sql"]) {
      await pool.query(readFileSync(new URL(`../../db/${file}`, import.meta.url), "utf8"));
    }
    return { applied: true, upgraded: false };
  }
  await pool.query(UPGRADE_SQL);
  await pool.query(readFileSync(new URL("../../db/roles.sql", import.meta.url), "utf8"));
  return { applied: false, upgraded: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.DIRECT_URL ?? process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DIRECT_URL, OWNER_DATABASE_URL or DATABASE_URL is required");
  const pool = new pg.Pool(poolConfig(connectionString));
  try {
    const result = await migrate(pool);
    console.log(result.applied ? "Applied database schema and roles." : "Upgraded existing database schema and refreshed roles.");
  } finally {
    await pool.end();
  }
}
