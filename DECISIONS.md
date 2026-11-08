# DECISIONS

**Money is integer paise (bigint).** Floats cannot represent amounts exactly, so rounding could make the books drift.

**Double entry, checked at COMMIT.** Every transaction is a set of debit and credit rows. A deferred constraint trigger compares the totals when the transaction commits, so rows can be inserted one at a time but an unbalanced transaction can never be saved.

**Append-only history.** `ledger_entries` and `audit_log` reject UPDATE, DELETE and TRUNCATE. Corrections are made by posting a new reversing transaction, never by editing.

**Idempotency key is a primary key.** The database, not application code, decides that a key was already used, so two concurrent requests cannot both win.

**Lock both accounts, in ascending id order.** Each ledger row now updates its account's balance, so a transfer writes to both rows. `transfer()` locks both in one `SELECT ... ORDER BY id FOR NO KEY UPDATE`, so A->B and B->A running at once wait on the same first row instead of each holding one and waiting for the other. `FOR NO KEY UPDATE` is the same lock the balance UPDATE takes, and it does not block foreign-key checks.

**Idempotency key is written last.** The request is only recorded as done in the same transaction that moves the money. If two identical requests race, the loser fails on the key insert, rolls back, and returns the winner's result.

**Same key, different request is an error.** The request is hashed (from, to, amount); a mismatch is rejected rather than replayed, so a key cannot be reused to pay someone else.

**Overdraft is refused twice: by the app and by the database.** `accounts.balance_paise` caches credits minus debits, and `CHECK user_balance_not_negative` refuses any user balance below zero, so even a bug in `transfer()` or a hand-written SQL insert cannot overdraw. `transfer()` still checks first, after the lock, so callers get a clean `INSUFFICIENT_FUNDS` instead of a constraint error.

**Only the ledger can move a balance.** The `ledger_entries_apply` trigger updates the balance and writes `running_balance_paise` on every ledger insert, overwriting any value the client sent. `accounts_guard` rejects a direct change to `balance_paise` (it only allows it at trigger depth 2, i.e. from inside the ledger trigger) and rejects opening an account with a non-zero balance. The cache therefore cannot drift from the ledger.

**One vault, and only the vault may go negative.** Deposits debit the `SYSTEM_VAULT` account and credit the user, so money always comes from somewhere and the ledger stays balanced. A partial unique index allows exactly one vault, and `vault_has_no_owner` makes the vault ownerless and every user account owned.

**Account identity is fixed.** `account_type`, `owner_id` and `account_number` cannot change after creation. Changing the owner would hand someone else's money to a new user; changing the type would switch off the overdraft check.

**Frozen accounts are refused twice.** `transfer()` returns `ACCOUNT_FROZEN`, and `ledger_entries_apply` rejects any entry on a non-active account.

**Transaction type comes from the locked rows.** `deposit` (from the vault), `withdrawal` (to the vault) or `transfer` is derived from the account types `transfer()` just locked, not from the caller.

**Idempotency is rechecked after the lock.** A retry that arrives while the first request is still running would otherwise wait for the lock, find the balance spent, and report "insufficient funds" for a payment that succeeded. Rechecking the key after the lock makes it replay the result instead.

**Isolation is pinned to READ COMMITTED.** The balance read must see the latest committed rows after the lock is granted. Under REPEATABLE READ the snapshot would predate the wait and could miss another spend.

**Reference tables are append-only too.** `transactions` and `idempotency_keys` cannot be edited or deleted, because changing either would switch off an integrity check.
