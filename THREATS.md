# THREATS

Only threats with a passing test are listed. The HTTP API does not exist yet; "API defense" below means the `transfer()` function in `api/src/transfer.js`.

| Threat | API defense | DB defense | Test (api/test/schema.test.js) |
|---|---|---|---|
| Books go out of balance (debits != credits) | not built yet | Deferred constraint trigger `ledger_entries_balanced` rejects the transaction at COMMIT | `THREAT unbalanced books` |
| Zero or negative amounts | not built yet | `CHECK (amount_paise > 0)` | `THREAT bad amounts` |
| Past ledger rows edited or deleted | not built yet | Triggers block UPDATE, DELETE, TRUNCATE on `ledger_entries` | `THREAT tampering: ledger entries` |
| Audit trail edited or deleted | not built yet | Triggers block UPDATE, DELETE, TRUNCATE on `audit_log` | `THREAT tampering: audit log` |
| Same request pays twice | not built yet | `idempotency_keys.key` is the primary key | `THREAT double payment` |
| Overdraft: spend more than the balance | `transfer()` checks balance after locking the source account; only `allow_negative` system accounts may go below zero | not built yet | `THREAT overdraft` |
| Overdraft by racing requests | Source account row is locked (`FOR NO KEY UPDATE`) before the balance is read | none | `THREAT concurrent overdraft` |
| Bad input (fractional, zero, negative, same account, unknown account) | `validate()` and account lookups | `CHECK (amount_paise > 0)` | `THREAT bad input` |
| Same request sent twice | Existing key returns the original transaction, `replayed: true` | primary key on `idempotency_keys.key` | `THREAT double payment: replaying` |
| Same key reused for a different request | Request hash compared, `IDEMPOTENCY_CONFLICT` | none | `THREAT key reuse` |
| Same request sent in parallel | Key row is the last write, so the losing request rolls back and returns the winner's result | primary key on `idempotency_keys.key` | `THREAT concurrent double payment` |
| Deadlock between opposite transfers | Lock mode `FOR NO KEY UPDATE` does not clash with foreign-key checks | none | `opposite-direction parallel transfers do not deadlock` |
| Retry races the original (same key, exact balance) | Key is re-checked inside the transaction after the lock, so the retry replays instead of failing | primary key on `idempotency_keys.key` | `THREAT retry race` |
| Database default isolation weakens the overdraft check | Transaction starts with `ISOLATION LEVEL READ COMMITTED` | none | `THREAT isolation` |
| Malformed or case-variant account ids, oversized keys | `validate()` requires lowercase UUIDs and key length <= 200 | uuid column types | `THREAT malformed ids` |
| Overdraft check switched off via `allow_negative`; keys or transactions deleted | none | Triggers: `allow_negative` immutable; `transactions` and `idempotency_keys` append-only | `THREAT tampering: accounts cannot turn on allow_negative` |
| Slow balance lookups hold the lock longer as the ledger grows | none | Indexes on `ledger_entries(account_id)` and `(transaction_id)` | `THREAT slow lock` (checks the indexes exist, not timing) |

Known gaps:
- A database superuser can drop the triggers. The app must connect with an INSERT/SELECT-only role (not done yet).
- Idempotency keys are global, not per user. They become per user when authentication is added.
- No `lock_timeout` or `statement_timeout` is set yet.
