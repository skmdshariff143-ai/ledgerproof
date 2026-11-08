# THREATS

Only threats with a passing test are listed. API defenses do not exist yet.

| Threat | API defense | DB defense | Test (api/test/schema.test.js) |
|---|---|---|---|
| Books go out of balance (debits != credits) | not built yet | Deferred constraint trigger `ledger_entries_balanced` rejects the transaction at COMMIT | `THREAT unbalanced books` |
| Zero or negative amounts | not built yet | `CHECK (amount_paise > 0)` | `THREAT bad amounts` |
| Past ledger rows edited or deleted | not built yet | Triggers block UPDATE, DELETE, TRUNCATE on `ledger_entries` | `THREAT tampering: ledger entries` |
| Audit trail edited or deleted | not built yet | Triggers block UPDATE, DELETE, TRUNCATE on `audit_log` | `THREAT tampering: audit log` |
| Same request pays twice | not built yet | `idempotency_keys.key` is the primary key | `THREAT double payment` |

Known gap: a database superuser can drop the triggers. The app must connect with a non-owner role (not done yet).
