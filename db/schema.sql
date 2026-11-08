-- LedgerProof schema. Money is integer paise. Ledger, transaction, idempotency and audit tables are append-only.

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- Only system accounts (e.g. a treasury that funds others) may go below zero.
  allow_negative boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid   NOT NULL REFERENCES transactions (id),
  account_id     uuid   NOT NULL REFERENCES accounts (id),
  direction      text   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Balance lookups and the commit-time balance check read by these columns.
CREATE INDEX ledger_entries_account_id_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_transaction_id_idx ON ledger_entries (transaction_id);

-- One row per accepted request key. The primary key is what stops a second payment.
CREATE TABLE idempotency_keys (
  key            text PRIMARY KEY,
  request_hash   text NOT NULL,
  transaction_id uuid NOT NULL REFERENCES transactions (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,
  action     text NOT NULL,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only: block UPDATE, DELETE and TRUNCATE on history tables.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER transactions_no_truncate
  BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER idempotency_keys_append_only
  BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER idempotency_keys_no_truncate
  BEFORE TRUNCATE ON idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- allow_negative switches off the overdraft check, so it can never change after creation.
CREATE FUNCTION reject_allow_negative_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.allow_negative IS DISTINCT FROM OLD.allow_negative THEN
    RAISE EXCEPTION 'accounts.allow_negative cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_allow_negative_fixed
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION reject_allow_negative_change();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Double entry: checked at COMMIT, so a transaction may insert its rows one by one.
CREATE FUNCTION check_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits  bigint;
  credits bigint;
BEGIN
  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0),
         COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)
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
