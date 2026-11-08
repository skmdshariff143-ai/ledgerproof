# THREATS

Only threats with a passing test are listed. The HTTP API does not exist yet; "API defense" below means the `transfer()` function in `api/src/transfer.js`.

Tests named `THREAT ...` live in `api/test/schema.test.js` (DB defenses) and `api/test/transfer.test.js` (`transfer()` defenses).

| Threat | API defense | DB defense | Test |
|---|---|---|---|
| Books go out of balance (debits != credits) | not built yet | Deferred constraint trigger `ledger_entries_balanced` rejects the transaction at COMMIT | `THREAT unbalanced books` |
| Zero or negative amounts | not built yet | `CHECK (amount_paise > 0)` | `THREAT bad amounts` |
| Past ledger rows edited or deleted | not built yet | Triggers block UPDATE, DELETE, TRUNCATE on `ledger_entries` | `THREAT tampering: ledger entries` |
| Audit trail edited or deleted | not built yet | Triggers block UPDATE, DELETE, TRUNCATE on `audit_log` | `THREAT tampering: audit log` |
| Same request pays twice | not built yet | `idempotency_keys.key` is the primary key | `THREAT double payment` |
| Overdraft: spend more than the balance | `transfer()` checks the locked `balance_paise`; only the `system_vault` may go below zero | `CHECK user_balance_not_negative` on `accounts` | `THREAT overdraft`, `THREAT overdraft at the database` |
| Overdraft by racing requests | Both account rows are locked (`FOR NO KEY UPDATE`) before the balance is read | balance UPDATE in `ledger_entries_apply` row-locks the account; `user_balance_not_negative` | `THREAT concurrent overdraft` |
| Balance edited directly, or account opened with money | none (no API writes balances) | `accounts_guard`: `balance_paise` changes only from the ledger trigger; accounts open at zero | `THREAT balance forgery` |
| Cached balance or running balance drifts from the ledger | none | `ledger_entries_apply` computes both on insert and overwrites client values | `running balance is set by the database...`, `transaction type is derived ... balance_paise matches the ledger` |
| Account reassigned to another owner, turned into the vault, or the vault deleted and replaced | none | `accounts_guard`: `owner_id`, `account_type`, `account_number` immutable; accounts cannot be deleted | `THREAT ownership change` |
| Second money source, ownerless user account, unknown role | none | partial unique index `accounts_single_vault`; `vault_has_no_owner`; `users_role_check` | `THREAT second vault, ownerless user account or unknown role` |
| Money moved on a frozen account | `transfer()` returns `ACCOUNT_FROZEN` | `ledger_entries_apply` rejects entries on non-active accounts | `THREAT frozen account`, `THREAT frozen account at the database` |
| Bad input (fractional, zero, negative, same account, unknown account) | `validate()` and account lookups | `CHECK (amount_paise > 0)` | `THREAT bad input` |
| Same request sent twice | Existing key returns the original transaction, `replayed: true` | primary key on `idempotency_keys.key` | `THREAT double payment: replaying` |
| Same key reused for a different request | Request hash compared, `IDEMPOTENCY_CONFLICT` | none | `THREAT key reuse` |
| Same request sent in parallel | Key row is the last write, so the losing request rolls back and returns the winner's result | primary key on `idempotency_keys.key` | `THREAT concurrent double payment` |
| Deadlock between opposite transfers | Both accounts locked in one statement, ascending id order, `FOR NO KEY UPDATE` | none | `opposite-direction parallel transfers do not deadlock` |
| Retry races the original (same key, exact balance) | Key is re-checked inside the transaction after the lock, so the retry replays instead of failing | primary key on `idempotency_keys.key` | `THREAT retry race` |
| Database default isolation weakens the overdraft check | Transaction starts with `ISOLATION LEVEL READ COMMITTED` | none | `THREAT isolation` |
| Malformed or case-variant account ids, oversized keys | `validate()` requires lowercase UUIDs and key length <= 200 | uuid column types | `THREAT malformed ids` |
| Idempotency keys or transactions edited or deleted | none | Triggers: `transactions` and `idempotency_keys` append-only | `THREAT tampering: idempotency keys and transactions are append-only` |
| Slow balance lookups hold the lock longer as the ledger grows | none | Indexes on `ledger_entries(account_id)` and `(transaction_id)` | `THREAT slow lock` (checks the indexes exist, not timing) |

Known gaps:
- A database superuser can drop the triggers. The app must connect with an INSERT/SELECT-only role (not done yet).
- The `accounts_guard` balance check trusts `pg_trigger_depth() >= 2`. A session with UPDATE on `accounts` can create its own trigger (for example on a TEMP table) that updates `balance_paise` at depth 2 and mints money with no ledger entry. Found by the security review. Fix: the app connects as a role with only `UPDATE (status)` on `accounts`, and `apply_ledger_entry` runs as `SECURITY DEFINER` (not done yet).
- `transfer()` has no caller identity yet, so any caller can name the vault as `from` and mint a deposit. Authorization comes with the HTTP API.
- Idempotency keys are global, not per user. They become per user when authentication is added.
- No `lock_timeout` or `statement_timeout` is set yet.
