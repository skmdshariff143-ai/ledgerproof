import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { poolConfig } from "../src/db-config.js";

const UPGRADE_SQL = `
-- Lock history and core tables so no concurrent writes can interleave with schema upgrade and hash backfill.
LOCK TABLE users, accounts, transactions, ledger_entries, idempotency_keys, audit_log IN ACCESS EXCLUSIVE MODE;
SELECT pg_advisory_xact_lock(20261110);

ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (lower(role) IN ('admin', 'account_holder', 'auditor'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (lower(status) IN ('pending_kyc', 'active', 'frozen', 'rejected'));

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
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (lower(type) IN ('deposit', 'withdrawal', 'transfer'));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('POSTED', 'FAILED'));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_amount_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_amount_check CHECK (amount IS NULL OR amount > 0);

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS amount bigint GENERATED ALWAYS AS (amount_paise) STORED;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS balance_after bigint GENERATED ALWAYS AS (running_balance_paise) STORED;
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_direction_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_direction_check CHECK (lower(direction) IN ('debit', 'credit'));

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS (id) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id uuid GENERATED ALWAYS AS (actor_user_id) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_type text GENERATED ALWAYS AS (CASE WHEN position(':' in target) > 0 THEN split_part(target, ':', 1) ELSE NULL END) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_id text GENERATED ALWAYS AS (target) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address text GENERATED ALWAYS AS (ip) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS metadata jsonb GENERATED ALWAYS AS (details) STORED;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS previous_hash text NOT NULL DEFAULT 'GENESIS_LEDGERPROOF_2026';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash text;

CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'transactions' AND TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

DROP TRIGGER IF EXISTS transactions_append_only ON transactions;
CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
DROP TRIGGER IF EXISTS transactions_no_truncate ON transactions;
CREATE TRIGGER transactions_no_truncate
  BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_mutation();

CREATE OR REPLACE FUNCTION apply_ledger_entry() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  account_status text;
BEGIN
  UPDATE accounts
     SET balance_paise = balance_paise
                         + CASE lower(NEW.direction) WHEN 'credit' THEN NEW.amount_paise ELSE -NEW.amount_paise END,
         version = version + 1
   WHERE id = NEW.account_id
  RETURNING balance_paise, status INTO NEW.running_balance_paise, account_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % does not exist', NEW.account_id;
  END IF;
  IF lower(account_status) <> 'active' THEN
    RAISE EXCEPTION 'account % is %', NEW.account_id, account_status;
  END IF;
  UPDATE transactions
     SET amount = COALESCE(amount, NEW.amount_paise),
         source_account_id = CASE WHEN lower(NEW.direction) = 'debit' THEN NEW.account_id ELSE source_account_id END,
         destination_account_id = CASE WHEN lower(NEW.direction) = 'credit' THEN NEW.account_id ELSE destination_account_id END
   WHERE id = NEW.transaction_id;
  RETURN NEW;
END;
$$;

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

-- Backfill hashes for confirmed legacy rows (entry_hash IS NULL) while preserving and verifying any
-- already-initialized prefix. Fails visibly on inconsistent existing hashes or out-of-order partial state.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only;

DO $$
DECLARE
  rec record;
  prev_hash text := 'GENESIS_LEDGERPROOF_2026';
  iso_ts text;
  payload text;
  expected_hash text;
  saw_unhashed boolean := false;
BEGIN
  FOR rec IN
    SELECT id, actor_user_id, actor_role, action, target, details, created_at, previous_hash, entry_hash
      FROM audit_log
     ORDER BY id ASC
  LOOP
    iso_ts := to_char(rec.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    payload := prev_hash || '|' || rec.id::text || '|' || COALESCE(rec.actor_user_id::text, 'ANONYMOUS')
               || '|' || COALESCE(rec.actor_role, 'ANONYMOUS') || '|' || rec.action
               || '|' || COALESCE(rec.target, '') || '|' || COALESCE(rec.details::text, '{}')
               || '|' || iso_ts;
    expected_hash := encode(sha256(convert_to(payload, 'UTF8')), 'hex');

    IF rec.entry_hash IS NOT NULL THEN
      IF saw_unhashed THEN
        RAISE EXCEPTION 'ambiguous audit_log migration state: unhashed legacy row precedes hashed row at id %', rec.id;
      END IF;
      IF rec.previous_hash IS DISTINCT FROM prev_hash OR rec.entry_hash IS DISTINCT FROM expected_hash THEN
        RAISE EXCEPTION 'inconsistent existing audit_log hash at id %: expected %, found %', rec.id, expected_hash, rec.entry_hash;
      END IF;
      prev_hash := rec.entry_hash;
    ELSE
      saw_unhashed := true;
      UPDATE audit_log
         SET previous_hash = prev_hash,
             entry_hash = expected_hash
       WHERE id = rec.id;
      prev_hash := expected_hash;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;
ALTER TABLE audit_log ALTER COLUMN entry_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_entry_hash_key ON audit_log (entry_hash);

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
`;

// Uses DIRECT_URL (port 5432) or OWNER_DATABASE_URL for DDL migrations, falling back to DATABASE_URL locally.
// Runs inside a single atomic transaction so any failure restores all original triggers and schema state.
export async function migrate(pool) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT to_regclass('public.users') AS users");
    if (!rows[0].users) {
      for (const file of ["schema.sql", "roles.sql"]) {
        await client.query(readFileSync(new URL(`../../db/${file}`, import.meta.url), "utf8"));
      }
      await client.query("COMMIT");
      return { applied: true, upgraded: false };
    }
    await client.query(UPGRADE_SQL);
    await client.query(readFileSync(new URL("../../db/roles.sql", import.meta.url), "utf8"));
    await client.query("COMMIT");
    return { applied: false, upgraded: true };
  } catch (err) {
    broken = await client.query("ROLLBACK").then(() => false, () => true);
    throw err;
  } finally {
    client.release(broken);
  }
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
