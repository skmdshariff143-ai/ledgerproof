# THREATS

Only threats with a passing test are listed. Tests named `THREAT ...` live in:
- `api/test/schema.test.js`: database defenses.
- `api/test/transfer.test.js`: the `transfer()` service.
- `api/test/auth.test.js`: HTTP authentication, roles, ownership and audit, tested against a running server.

## Authentication, authorization and audit trail

| Threat | API defense | DB defense | Test (auth.test.js) |
|---|---|---|---|
| Alice moves money out of Bob's account (IDOR) | Transfer route compares the source account's `owner_id` with the logged-in user; 403 plus a `denied` audit row | `owner_id` immutable (`accounts_guard`) | `THREAT IDOR transfer` |
| Alice reads Bob's statement, or probes which account ids exist | Statement route checks ownership; a missing account gets the same 403 as a foreign one; both audited | none | `THREAT IDOR statement` |
| Account holder mints money by naming the vault as the source | Vault has no owner, so the ownership check refuses it | `vault_has_no_owner` | `THREAT vault minting` |
| Alice withdraws from Bob's account (IDOR) | Withdraw route checks the source account's `owner_id`; 403 plus a `denied` audit row | `owner_id` immutable | `THREAT IDOR withdrawal` (money.test.js) |
| Account holder or auditor creates money with a deposit | Deposit route allows `admin` only; 403 plus a `denied` audit row | none | `THREAT self-deposit` (money.test.js) |
| A rogue admin's deposits blend into routine transfers in the audit log | `transfer()` audits each success under the route's own action name (`deposit`, `withdraw`, `transfer`) and target | none | `THREAT hidden deposits` (money.test.js) |
| Auditor writes (transfer, create, freeze) | `allowRoles`: auditor is named on no write route; 403 plus a `denied` audit row | none | `THREAT auditor writes` |
| Admin spends from a user's account | Transfer route allows `account_holder` only | none | `THREAT admin forging` |
| No token, token signed with another secret, `alg: none` | `jwt.verify` with `algorithms: ['HS256']`; 401 | none | `THREAT no or forged token` |
| Old token keeps a role that was taken away | Role is read from `users` on every request; the token holds only the user id | none | `THREAT stale role` |
| Password guessing goes unnoticed | Failed logins return 401 and are audited as `denied` | none | `THREAT bad login` |
| A rollback erases the record of a failed attempt | Denials and failures are audited through the pool, in their own transaction | none | `admin freezes Bob ... audited outside the rolled-back transaction` |
| Audit trail edited or deleted | none | Triggers block UPDATE, DELETE, TRUNCATE on `audit_log`; `outcome` limited by CHECK | `THREAT tampering: audit log` (schema.test.js) |
| Errors leak SQL or stack traces | Error handler returns only `{ error: { code, message } }`; unknown errors become a generic 500 | none | `THREAT error leaks` |

## Ledger and money movement

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
| Withdrawal beyond the balance, or zero, negative, fractional, string or null amounts | `transfer()` locked funds check; `validate()` requires a positive safe integer | `user_balance_not_negative`; `CHECK (amount_paise > 0)` | `THREAT overdraft withdrawal and bad amounts` (money.test.js) |
| Retried deposit or withdrawal pays twice | Same idempotency key returns the original transaction | primary key on `idempotency_keys.key` | `THREAT replayed deposit and withdrawal` (money.test.js) |
| Books silently drift: a balance edited past the triggers (for example by a superuser with triggers disabled) | `GET /api/ledger/reconcile` recomputes every balance from the ledger and reports `balance_mismatch` and `running_balance_mismatch` | append-only ledger is the source of truth | `THREAT tampering past the triggers` and `reconcile: balanced after ...` (money.test.js) |
| A transaction recorded with no ledger rows | Reconcile starts from `transactions` and reports any with no entries | none | `reconcile reports a transaction that has no ledger rows` (money.test.js) |
| Slow balance lookups hold the lock longer as the ledger grows | none | Indexes on `ledger_entries(account_id)` and `(transaction_id)` | `THREAT slow lock` (checks the indexes exist, not timing) |

Known gaps:
- A database superuser can drop the triggers. The app must connect with an INSERT/SELECT-only role (not done yet).
- The `accounts_guard` balance check trusts `pg_trigger_depth() >= 2`. A session with UPDATE on `accounts` can create its own trigger (for example on a TEMP table) that updates `balance_paise` at depth 2 and mints money with no ledger entry. Found by the security review. Fix: the app connects as a role with only `UPDATE (status)` on `accounts`, and `apply_ledger_entry` runs as `SECURITY DEFINER` (not done yet).
- `transfer()` itself does not check ownership; the HTTP route does. Any new caller of `transfer()` must authorize first.
- No rate limit on login yet.
- Because keys are global, one user can claim a key another user will send. For example, Bob sends a 1-paise transfer with the key an admin is about to use for a deposit. The admin's deposit then gets 409, and the 409 tells Bob the key exists. No money moves wrongly. Fixed by per-user keys (Phase 4).
- A replayed request returns the original result but writes no audit row of its own.
- Reconcile scans the whole ledger and has no rate limit. Its `problems` list is not capped.
- Idempotency keys are global, not per user. They become per user when authentication is added.
- No `lock_timeout` or `statement_timeout` is set yet.
