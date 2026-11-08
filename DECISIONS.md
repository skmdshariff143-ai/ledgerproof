# DECISIONS

**Money is integer paise (bigint).** Floats cannot represent amounts exactly, so rounding could make the books drift.

**Double entry, checked at COMMIT.** Every transaction is a set of debit and credit rows. A deferred constraint trigger compares the totals when the transaction commits, so rows can be inserted one at a time but an unbalanced transaction can never be saved.

**Append-only history.** `ledger_entries` and `audit_log` reject UPDATE, DELETE and TRUNCATE. Corrections are made by posting a new reversing transaction, never by editing.

**Idempotency key is a primary key.** The database, not application code, decides that a key was already used, so two concurrent requests cannot both win.
