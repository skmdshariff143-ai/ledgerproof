# DECISIONS

**Money is integer paise (bigint).** Floats cannot represent amounts exactly, so rounding could make the books drift.

**Double entry, checked at COMMIT.** Every transaction is a set of debit and credit rows. A deferred constraint trigger compares the totals when the transaction commits, so rows can be inserted one at a time but an unbalanced transaction can never be saved.

**Append-only history.** `ledger_entries` and `audit_log` reject UPDATE, DELETE and TRUNCATE. Corrections are made by posting a new reversing transaction, never by editing.

**Idempotency key is a primary key.** The database, not application code, decides that a key was already used, so two concurrent requests cannot both win.

**Lock the source account, not both.** A transfer locks only the paying account row while it checks the balance, so two spends cannot both see the same balance. It uses `FOR NO KEY UPDATE` because a plain `FOR UPDATE` clashes with the foreign-key check on the other account and can deadlock opposite transfers.

**Idempotency key is written last.** The request is only recorded as done in the same transaction that moves the money. If two identical requests race, the loser fails on the key insert, rolls back, and returns the winner's result.

**Same key, different request is an error.** The request is hashed (from, to, amount); a mismatch is rejected rather than replayed, so a key cannot be reused to pay someone else.

**Overdraft rule lives in the app, backed by a lock.** The database cannot cheaply enforce "balance never below zero" on an append-only ledger; the locked check in `transfer()` is the enforcement and the concurrency test is its proof.

**Idempotency is rechecked after the lock.** A retry that arrives while the first request is still running would otherwise wait for the lock, find the balance spent, and report "insufficient funds" for a payment that succeeded. Rechecking the key after the lock makes it replay the result instead.

**Isolation is pinned to READ COMMITTED.** The balance read must see the latest committed rows after the lock is granted. Under REPEATABLE READ the snapshot would predate the wait and could miss another spend.

**Reference tables are append-only too.** `transactions` and `idempotency_keys` cannot be edited or deleted, and `accounts.allow_negative` cannot change, because changing any of them would switch off an integrity check.
