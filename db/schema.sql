-- LedgerProof schema. Money is integer paise. Ledger, transaction, idempotency and audit tables are append-only.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'account_holder', 'auditor')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- balance_paise is a cache of SUM(credits) - SUM(debits) kept by the ledger trigger below;
-- it lets the database itself refuse an overdraft.
CREATE SEQUENCE account_number_seq;

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number text NOT NULL UNIQUE DEFAULT 'LP' || lpad(nextval('account_number_seq')::text, 10, '0'),
  account_type   text NOT NULL CHECK (account_type IN ('system_vault', 'user_checking')),
  owner_id       uuid REFERENCES users (id),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  balance_paise  bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_has_no_owner CHECK ((account_type = 'system_vault') = (owner_id IS NULL)),
  -- Only the vault may go below zero: it is where deposited money comes from.
  CONSTRAINT user_balance_not_negative CHECK (account_type = 'system_vault' OR balance_paise >= 0)
);

CREATE UNIQUE INDEX accounts_single_vault ON accounts (account_type) WHERE account_type = 'system_vault';

INSERT INTO accounts (account_number, account_type) VALUES ('VAULT-0001', 'system_vault');

CREATE TABLE transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'transfer')),
  initiated_by uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid   NOT NULL REFERENCES transactions (id),
  account_id     uuid   NOT NULL REFERENCES accounts (id),
  direction      text   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  -- Set by the ledger_entries_apply trigger; any value the client sends is overwritten.
  running_balance_paise bigint NOT NULL,
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
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users (id),
  actor_role    text,
  action        text NOT NULL,
  target        text,
  ip            text,
  details       jsonb,
  outcome       text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  created_at    timestamptz NOT NULL DEFAULT now()
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

-- Accounts open empty, are never deleted, never change type, owner or number, and their
-- balance moves only through ledger_entries_apply (which runs at trigger depth 2).
CREATE FUNCTION guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE FUNCTION apply_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_status text;
BEGIN
  UPDATE accounts
     SET balance_paise = balance_paise
                         + CASE NEW.direction WHEN 'credit' THEN NEW.amount_paise ELSE -NEW.amount_paise END
   WHERE id = NEW.account_id
  RETURNING balance_paise, status INTO NEW.running_balance_paise, account_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % does not exist', NEW.account_id;
  END IF;
  IF account_status <> 'active' THEN
    RAISE EXCEPTION 'account % is %', NEW.account_id, account_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_apply
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();

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
