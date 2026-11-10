# DECISIONS

**Money is integer paise (bigint).** Floats cannot represent amounts exactly, so rounding could make the books drift.

**Double entry, checked at COMMIT.** Every transaction is a set of debit and credit rows. A deferred constraint trigger compares the totals when the transaction commits, so rows can be inserted one at a time but an unbalanced transaction can never be saved.

**Append-only history.** `ledger_entries` and `audit_log` reject UPDATE, DELETE and TRUNCATE. Corrections are made by posting a new reversing transaction, never by editing.

**Idempotency key is a primary key.** The database, not application code, decides that a key was already used, so two concurrent requests cannot both win.

**Lock both accounts, in ascending id order.** Each ledger row now updates its account's balance, so a transfer writes to both rows. `transfer()` locks both in one `SELECT ... ORDER BY id FOR NO KEY UPDATE`, so A->B and B->A running at once wait on the same first row instead of each holding one and waiting for the other. `FOR NO KEY UPDATE` is the same lock the balance UPDATE takes, and it does not block foreign-key checks.

**Idempotency key is written last.** The request is only recorded as done in the same transaction that moves the money. If two identical requests race, the loser fails on the key insert, rolls back, and returns the winner's result.

**Same key, different request is an error.** The request is hashed (user, from, to, amount); a mismatch is rejected with 409 rather than replayed, so a key cannot be reused to pay someone else. The operation needs no separate field: a deposit always has the vault as source, a withdrawal always has it as destination, and a transfer never involves it, so from and to already tell them apart.

**Idempotency keys belong to a user.** The primary key is `(user_id, key)`, and `user_id` comes from the verified token. One user cannot block another by sending their key first, and cannot learn whether a key was used.

**No IN_PROGRESS rows.** A common design writes an "in progress" row first and returns 409 to a duplicate that arrives meanwhile. Here the key row is written in the same transaction as the money, so a duplicate waits on the lock and then gets the real result instead of a 409. If the server crashes mid-request, the whole transaction rolls back and no stuck "in progress" row is left that would need cleaning by hand.

**A replay looks exactly like the first answer.** It returns the same status (201) and body (`{ transactionId }`), and only the `Idempotent-Replayed: true` header marks it. Each replay is audited too, so the audit log shows every request, not just the first. Failed requests (such as 422 for insufficient funds) are not stored, so a retry runs again and can succeed once the money is there. A replay is checked after authorization but before the frozen check: it reports a payment that already happened and moves nothing, so it still answers 201 after the account is frozen, while any new payment is refused.

**Overdraft is refused twice: by the app and by the database.** `accounts.balance_paise` caches credits minus debits, and `CHECK user_balance_not_negative` refuses any user balance below zero, so even a bug in `transfer()` or a hand-written SQL insert cannot overdraw. `transfer()` still checks first, after the lock, so callers get a clean `INSUFFICIENT_FUNDS` instead of a constraint error.

**Only the ledger can move a balance.** The `ledger_entries_apply` trigger updates the balance and writes `running_balance_paise` on every ledger insert, overwriting any value the client sent. `accounts_guard` rejects a direct change to `balance_paise` (it only allows it at trigger depth 2, i.e. from inside the ledger trigger) and rejects opening an account with a non-zero balance. The cache therefore cannot drift from the ledger.

**One vault, and only the vault may go negative.** Deposits debit the `SYSTEM_VAULT` account and credit the user, so money always comes from somewhere and the ledger stays balanced. A partial unique index allows exactly one vault, and `vault_has_no_owner` makes the vault ownerless and every user account owned.

**Account identity is fixed.** `account_type`, `owner_id` and `account_number` cannot change after creation. Changing the owner would hand someone else's money to a new user; changing the type would switch off the overdraft check.

**Frozen accounts are refused twice.** `transfer()` returns `ACCOUNT_FROZEN`, and `ledger_entries_apply` rejects any entry on a non-active account.

**Transaction type comes from the locked rows.** `deposit` (from the vault), `withdrawal` (to the vault) or `transfer` is derived from the account types `transfer()` just locked, not from the caller.

**Idempotency is rechecked after the lock.** A retry that arrives while the first request is still running would otherwise wait for the lock, find the balance spent, and report "insufficient funds" for a payment that succeeded. Rechecking the key after the lock makes it replay the result instead.

**Isolation is pinned to READ COMMITTED.** The balance read must see the latest committed rows after the lock is granted. Under REPEATABLE READ the snapshot would predate the wait, so a request that had waited for another spend to commit would fail with a serialization error (40001) instead of re-reading the balance. `THREAT isolation` fails without the explicit `BEGIN ISOLATION LEVEL READ COMMITTED`.

**The token holds only the user id.** The JWT is signed and checked with HS256 only, which also rejects `alg: none`. On every request `authenticate` looks the user up again, so a changed role or a deleted user takes effect at once. A role kept in the token would keep working until the token expired.

**Deny by default.** Every route except login is registered through `route(method, path, roles, handler)`, which always runs `authenticate` and `allowRoles`. A route cannot be added without naming who may call it. Auditors are named on no write route, so every POST they send is refused.

**Ownership is checked against the database, never the request.** The transfer route loads the source account and compares `owner_id` with the logged-in user. This check can run before the money transaction because `owner_id` can never change (`accounts_guard`). The vault has no owner, so no account holder can name it as the source.

**403 for missing and foreign accounts alike.** An account holder asking for an account that does not exist gets the same 403 as for someone else's account, so account ids cannot be probed.

**Admins manage, they do not spend.** Admins can create, freeze and unfreeze user accounts, but the transfer route is for account holders only, so an admin cannot move money out of a user's account.

**Denials and failures are audited outside the request's transaction.** `deny()` and the `audited` helper write through the pool, which commits on its own, so the record survives when the request's transaction rolls back. A success is audited with the request's own client, so it commits together with the change it describes, or not at all.

**Audit rows keep the role at the time.** `audit_log.actor_role` is copied when the row is written, so a later role change does not alter what the history says.

**Passwords use scrypt from Node's standard library.** Each password gets a random salt, comparison runs in constant time, and an unknown email is checked against a dummy hash so it takes as long as a wrong password.

**The seed is idempotent.** The opening deposits use fixed idempotency keys, so running `npm run seed` twice replays them instead of paying twice.

**Deposits, withdrawals and transfers share one code path.** All three call `transfer()`, so they get the same lock order, overdraft check, idempotency and audit row. They differ only in who may call them and which side is the vault. A deposit is the vault paying a user and is admin-only, because it creates customer money. A withdrawal is a user paying the vault, from their own account only.

**Reconcile recomputes, it does not trust.** `GET /api/ledger/reconcile` sums the ledger rows itself and compares the result with the stored balances and the last running balances. It also lists any transaction whose debits and credits differ, and any user account below zero. All checks read one `REPEATABLE READ READ ONLY` snapshot, so transfers committing during the check cannot cause false alarms. Its job is to catch what the triggers cannot stop, such as a superuser editing a balance with triggers switched off.

**Paying by account number.** A transfer may name the recipient by account number (`LP0000000002`) instead of the UUID, so people can pay each other without knowing internal ids. The source account's ownership is checked first, and the number is only a bound parameter after a strict pattern check. The amount and idempotency key are validated before the lookup so malformed requests cannot be used to find which numbers exist. A real payment still shows whether a number exists or is frozen; that is accepted because account numbers are public by design and the sender must learn why a payment failed.

**CORS is a reader allow-list, not the lock.** `ALLOWED_ORIGINS` lists the browser pages allowed to read API answers; empty means none. Requests are authenticated by a bearer token in a header, not by cookies, so a foreign page cannot ride on a logged-in session, and CORS only stops it reading answers. The setting is parsed strictly at startup: `null`, `*`, trailing slashes and paths stop the server, so a typo cannot quietly widen or break access.

**The browser never uses floats for money.** `web/src/money.js` turns what a person types ("100.50") into integer paise with string maths and BigInt, and formats paise back to rupees the same way. It refuses zero, negatives, more than two decimals, exponents and commas. The API sends money as strings, so a large balance is never squeezed through a JavaScript number. The server validates the amount again; the browser check only saves a round trip.

**The browser app is a client, not a gatekeeper.** Each role sees a different screen, but that is convenience. Every request is checked by the server from the verified token, so opening another role's screen (or calling its URLs by hand) gets a 403 and an audit row.

**The login token lives in sessionStorage.** It disappears when the tab closes and is sent as a bearer header, so there are no cookies to forge a request with. The price is that any script running on the page could read it. The defense is that the app renders all text through React (no `dangerouslySetInnerHTML`, `innerHTML` or `eval`), so data from the API cannot become script. A strict Content-Security-Policy, set by `web/vercel.json`, adds a second layer: the page may load scripts and styles only from itself and talk only to itself and the API.

**Idempotency is visible in the UI.** Every money form creates a fresh UUID v4 `Idempotency-Key`. "Simulate network retry" sends the request twice with that key at the same moment, so the page shows the server paying once and answering the second call as a replay.

**The API connects as a restricted database role.** `ledgerproof_app` (see `db/roles.sql`) can read the tables, insert into the history tables (only the columns the routes write, so it cannot pick a row id or back-date a timestamp), open accounts (type and owner only) and change `accounts.status`. It cannot update or delete anything else, cannot update balances, is not the table owner, and cannot disable triggers or alter the schema. So even if the API had an SQL injection or a bug, the database would still refuse to forge a balance, change a role or rewrite history. The schema owner is used only to load the schema and run the seed. Every API test runs as this role, so what the tests prove is what the deployment gets.

**The ledger trigger runs as the owner.** Balances must change when a ledger row is inserted, but the API role may not change them. `apply_ledger_entry` is `SECURITY DEFINER` with a pinned `search_path`, so the trigger does the update with the owner's rights while a trigger written by the API role (which runs with its own rights) fails. This closes the gap where a session could mint money with a trigger on a temp table.

**Supabase's REST API gets no access.** Supabase exposes every table in `public` to its anon, authenticated and service roles by default. `roles.sql` revokes that, because the ledger is reached only through this API.

**Behind Vercel, trust one proxy hop; elsewhere none.** Audit rows record the client address, so the API must know the real one. On Vercel `X-Forwarded-For` is set by the platform, so Express trusts that single hop. Anywhere else the header is ignored, so a client cannot choose the address that is written to the audit log.

**The API exports an app; a small file listens.** `src/index.js` builds and exports the Express app (what Vercel runs). `src/local.js` only calls `listen` for `npm start`. The factory lives in `create-app.js`, not `app.js`: Vercel treats `src/app.js` as an entry point candidate and ranks it above `index.js`, so a file of that name made the first deployment crash. The database pool is small (5) and logs idle-connection errors instead of crashing the instance.

**The database connection is verified TLS, with the CA pinned in code.** Supabase accepts only TLS and signs with its own root CA, which Node does not trust, so the first live connection failed. Turning verification off (`sslmode=no-verify`) would encrypt the traffic but let anyone impersonate the database, so it is not offered. Instead `api/src/supabase-ca.js` holds Supabase's public root certificate, confirmed against the live servers, and `poolConfig` applies it to Supabase hosts only. It also removes any `sslmode` setting from the URL, because `pg` lets the URL override the config and a stray `no-verify` would silently weaken it. A local Postgres is left as configured.

**Reference tables are append-only too.** `transactions` and `idempotency_keys` cannot be edited or deleted, because changing either would switch off an integrity check.

**Cryptographic SHA-256 hash-chained audit trail.** Every row inserted into `audit_log` is chained by `chain_audit_log()` inside an advisory-locked transaction (`SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE`). The genesis anchor is `GENESIS_LEDGERPROOF_2026`, and each `entry_hash` is computed over `previous_hash|seq|actor_id|actor_role|action|target_id|canonicalJson(metadata)|created_at_iso`. `GET /api/admin/audit-logs/verify` recomputes the entire chain from Genesis to tip and pinpoints the exact `tamperedSeq` if any row is altered past triggers.

**KYC onboarding state machine & first-admin bootstrap.** Self-registered users (`POST /api/auth/register`) open in `PENDING_KYC` status with ₹0 balance and cannot send or receive money (`403 KYC_PENDING`) until an admin approves them (`POST /api/admin/users/:id/approve`). First-admin initialization (`npm run db:bootstrap-admin` or `POST /api/system/bootstrap` guarded by `BOOTSTRAP_SECRET`) is idempotent and runs only when zero admins exist.

