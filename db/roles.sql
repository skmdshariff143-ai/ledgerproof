-- Run by the schema owner after schema.sql. The API connects as ledgerproof_app, which can do only
-- what the routes need. Its password is set separately, never in this file:
--   ALTER ROLE ledgerproof_app WITH LOGIN PASSWORD '<your password>';
-- Safe to run more than once.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledgerproof_app') THEN
    CREATE ROLE ledgerproof_app NOLOGIN;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Postgres lets everyone execute new functions. These are trigger functions, run only by their triggers.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ledgerproof_app;

-- Read what the routes read; write only what they write. There is no UPDATE, DELETE or TRUNCATE
-- on any table except accounts.status and users.status (for KYC onboarding), so the app cannot edit roles, history or balances.
GRANT SELECT ON users, accounts, transactions, ledger_entries, idempotency_keys, audit_log, audit_logs TO ledgerproof_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON revoked_tokens, rate_limit_buckets TO ledgerproof_app;
-- Inserts name their columns, so the role cannot choose an id (which could squat on a future ledger id)
-- or a created_at (which would back-date history). Both are defaults. The REVOKE first makes a re-run
-- of this file replace an older, table-wide grant.
REVOKE INSERT ON users, transactions, ledger_entries, idempotency_keys, audit_log FROM ledgerproof_app;
GRANT INSERT (email, password_hash, role, status) ON users TO ledgerproof_app;
GRANT UPDATE (status) ON users TO ledgerproof_app;
GRANT INSERT (idempotency_key, type, status, amount, source_account_id, destination_account_id, initiated_by, reference) ON transactions TO ledgerproof_app;
GRANT INSERT (transaction_id, account_id, direction, amount_paise) ON ledger_entries TO ledgerproof_app;
GRANT INSERT (user_id, key, request_hash, transaction_id) ON idempotency_keys TO ledgerproof_app;
GRANT INSERT (actor_user_id, actor_role, action, target, ip, details, outcome, previous_hash, entry_hash) ON audit_log TO ledgerproof_app;
-- Admins open accounts (type, owner, status, currency only; the rest are defaults) and freeze/approve them (status only).
-- Balances move only through the ledger trigger, which runs as the owner.
GRANT INSERT (account_type, owner_id, status, currency) ON accounts TO ledgerproof_app;
GRANT UPDATE (status) ON accounts TO ledgerproof_app;
GRANT USAGE ON SEQUENCE account_number_seq, ledger_entries_id_seq, audit_log_id_seq TO ledgerproof_app;

-- Supabase gives its REST API roles access to every table in public by default.
-- This ledger is reached only through the API above, never through that REST API.
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      -- Objects created later by this role (a future migration) must not re-open that access.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
