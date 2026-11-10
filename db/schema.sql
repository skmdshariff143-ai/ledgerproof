-- LedgerProof schema. Money is integer paise. Ledger, transaction, idempotency and audit tables are append-only.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (lower(role) IN ('admin', 'account_holder', 'auditor')),
  status        text NOT NULL DEFAULT 'active' CHECK (lower(status) IN ('pending_kyc', 'active', 'frozen', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- balance_paise is a cache of SUM(credits) - SUM(debits) kept by the ledger trigger below;
-- it lets the database itself refuse an overdraft.
CREATE SEQUENCE account_number_seq;

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number text NOT NULL UNIQUE DEFAULT 'LP' || lpad(nextval('account_number_seq')::text, 10, '0'),
  account_type   text NOT NULL DEFAULT 'user_checking' CHECK (account_type IN ('system_vault', 'user_checking')),
  owner_id       uuid REFERENCES users (id),
  user_id        uuid GENERATED ALWAYS AS (owner_id) STORED,
  currency       text NOT NULL DEFAULT 'INR',
  status         text NOT NULL DEFAULT 'active' CHECK (lower(status) IN ('pending_kyc', 'active', 'frozen')),
  balance_paise  bigint NOT NULL DEFAULT 0,
  balance        bigint GENERATED ALWAYS AS (balance_paise) STORED,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_has_no_owner CHECK ((account_type = 'system_vault') = (owner_id IS NULL)),
  -- Only the vault may go below zero: it is where deposited money comes from.
  CONSTRAINT user_balance_not_negative CHECK (account_type = 'system_vault' OR balance_paise >= 0)
);

CREATE UNIQUE INDEX accounts_single_vault ON accounts (account_type) WHERE account_type = 'system_vault';

INSERT INTO accounts (account_number, account_type) VALUES ('VAULT-0001', 'system_vault');

CREATE TABLE transactions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key        text UNIQUE,
  type                   text NOT NULL CHECK (lower(type) IN ('deposit', 'withdrawal', 'transfer')),
  status                 text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'FAILED')),
  amount                 bigint CHECK (amount IS NULL OR amount > 0),
  source_account_id      uuid REFERENCES accounts (id),
  destination_account_id uuid REFERENCES accounts (id),
  initiated_by           uuid NOT NULL REFERENCES users (id),
  reference              text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid   NOT NULL REFERENCES transactions (id),
  account_id     uuid   NOT NULL REFERENCES accounts (id),
  direction      text   NOT NULL CHECK (lower(direction) IN ('debit', 'credit')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  amount         bigint GENERATED ALWAYS AS (amount_paise) STORED,
  -- Set by the ledger_entries_apply trigger; any value the client sends is overwritten.
  running_balance_paise bigint NOT NULL,
  balance_after  bigint GENERATED ALWAYS AS (running_balance_paise) STORED,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Balance lookups and the commit-time balance check read by these columns.
-- (account_id, id) also serves "latest entry per account" in reconcile.
CREATE INDEX ledger_entries_account_id_idx ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_transaction_id_idx ON ledger_entries (transaction_id);

-- One row per accepted request key. The primary key is what stops a second payment.
-- Keys belong to the user who sent them, so one user cannot claim or probe another's keys.
CREATE TABLE idempotency_keys (
  user_id        uuid NOT NULL REFERENCES users (id),
  key            text NOT NULL,
  request_hash   text NOT NULL,
  transaction_id uuid NOT NULL REFERENCES transactions (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- actor_role is copied at the time of the event, so a later role change cannot rewrite history.
-- actor_user_id is NULL only for anonymous events such as a failed login.
-- Every row is cryptographically hash-chained with SHA-256 (previous_hash -> entry_hash).
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  seq           bigint GENERATED ALWAYS AS (id) STORED,
  actor_user_id uuid REFERENCES users (id),
  actor_id      uuid GENERATED ALWAYS AS (actor_user_id) STORED,
  actor_role    text,
  action        text NOT NULL,
  target        text,
  target_type   text GENERATED ALWAYS AS (CASE WHEN position(':' in target) > 0 THEN split_part(target, ':', 1) ELSE NULL END) STORED,
  target_id     text GENERATED ALWAYS AS (target) STORED,
  ip            text,
  ip_address    text GENERATED ALWAYS AS (ip) STORED,
  details       jsonb,
  metadata      jsonb GENERATED ALWAYS AS (details) STORED,
  outcome       text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'error')),
  previous_hash text NOT NULL DEFAULT 'GENESIS_LEDGERPROOF_2026',
  entry_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW audit_logs AS SELECT * FROM audit_log;

-- Serverless-safe JWT revocation store (persists logged-out / revoked token JTIs across instances).
CREATE TABLE revoked_tokens (
  jti        text PRIMARY KEY,
  user_id    uuid REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX revoked_tokens_expires_at_idx ON revoked_tokens (expires_at);

-- Serverless-safe distributed rate-limiting buckets backed by PostgreSQL.
CREATE TABLE rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  points     int NOT NULL DEFAULT 1,
  reset_at   timestamptz NOT NULL
);

-- Append-only: block UPDATE, DELETE and TRUNCATE on history tables.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'transactions' AND TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER transactions_no_truncate
  BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER idempotency_keys_append_only
  BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER idempotency_keys_no_truncate
  BEFORE TRUNCATE ON idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Accounts open empty, are never deleted, never change type, owner or number, and their
-- balance moves only through ledger_entries_apply (which runs at trigger depth 2).
CREATE FUNCTION guard_account() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounts cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_paise <> 0 THEN
      RAISE EXCEPTION 'accounts must open with a zero balance';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_number IS DISTINCT FROM OLD.account_number
     OR NEW.account_type IS DISTINCT FROM OLD.account_type
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'accounts id, account_number, account_type and owner_id cannot be changed';
  END IF;
  IF NEW.balance_paise IS DISTINCT FROM OLD.balance_paise AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'accounts.balance_paise changes only through ledger_entries';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_account();

-- Each ledger row moves its account's balance and records the result as running_balance_paise.
-- The UPDATE also fires user_balance_not_negative, so an overdraft fails here.
-- SECURITY DEFINER: it runs with the schema owner's rights, so the API's database role needs
-- no permission to change balances itself (see roles.sql). search_path is pinned so a caller
-- cannot make the function pick up its own look-alike table.
CREATE FUNCTION apply_ledger_entry() RETURNS trigger LANGUAGE plpgsql
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

CREATE TRIGGER ledger_entries_apply
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();

-- Automatically chains audit rows and computes SHA-256 entry_hash inside the active transaction.
CREATE FUNCTION chain_audit_log() RETURNS trigger LANGUAGE plpgsql
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

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION chain_audit_log();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_mutation();

-- Double entry: checked at COMMIT, so a transaction may insert its rows one by one.
-- search_path is pinned with pg_temp last: otherwise a session could create a temp table named
-- ledger_entries, which would be searched first and make every transaction look balanced.
CREATE FUNCTION check_transaction_balanced() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
DECLARE
  debits  bigint;
  credits bigint;
BEGIN
  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE lower(direction) = 'debit'), 0),
         COALESCE(SUM(amount_paise) FILTER (WHERE lower(direction) = 'credit'), 0)
    INTO debits, credits
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'transaction % not balanced: debits % credits %', NEW.transaction_id, debits, credits;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_balanced();
