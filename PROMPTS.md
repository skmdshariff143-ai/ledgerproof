# PROMPTS

How AI (Claude Code) was used on this project, and where its output was wrong. Entries are written as the work happens, not afterwards.

## 2026-11-08: Overdraft was enforced only in application code

- **Asked:** Phase 1 of the schema: users, owned accounts, a system vault, and a stored balance the database checks.
- **What the AI had produced earlier:** The first ledger design (commit c54e719 / 9797ccc) checked "balance never below zero" only inside `transfer()`. DECISIONS.md justified this by saying the database "cannot cheaply enforce" it on an append-only ledger.
- **What was wrong:** AGENTS.md requires every money rule to be enforced twice, once in the API and once in the database. With the check only in JS, a bug in `transfer()`, or any hand-written SQL insert, could overdraw a user account and nothing in the database would stop it.
- **What was done instead:** `accounts.balance_paise` is kept by the `ledger_entries_apply` trigger on every ledger insert. `CHECK user_balance_not_negative` refuses any user balance below zero. `accounts_guard` stops anyone editing the balance directly. `transfer()` now locks both accounts in ascending id order, because the trigger writes both rows.
- **How verified:** Test `THREAT overdraft at the database` inserts ledger rows directly that would overdraw an account, and the database rejects them. `THREAT balance forgery`, `running balance is set by the database...` and the existing concurrency and deadlock tests also pass: 27/27.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/5ddb141

## 2026-11-08: Security review found holes in the new account guard (audit trail / access control)

- **Asked:** Run the `security-reviewer` subagent on the Phase 1 diff before committing.
- **What the AI produced:** `accounts_guard` allowed a balance change only at `pg_trigger_depth() >= 2`, meaning "only from inside the ledger trigger". The guard did not cover DELETE.
- **What was wrong (found by the reviewer, who ran both attacks on a scratch database):**
  1. Any session allowed to UPDATE `accounts` can create its own trigger, for example on a TEMP table, that changes `balance_paise` at depth 2. That mints money with no ledger entry. The app also connects as a superuser today.
  2. The vault row could be deleted while it had no entries, and replaced with a different vault.
- **What was done instead:** (2) is fixed: `accounts_guard` now rejects DELETE, and `THREAT ownership change` asserts this. (1) is **not fixed yet**. It is listed under "Known gaps" in THREATS.md. The planned fix is an app role with only `UPDATE (status)` on `accounts`, plus a `SECURITY DEFINER` ledger trigger.
- **How verified:** 27/27 tests pass, including the new delete assertion. There is no test for (1) yet.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/5ddb141

## 2026-11-08: Transfer route let account holders withdraw and probe other accounts (authorization)

- **Asked:** Phase 2: login, role checks, and ownership checks so Alice can never touch Bob's money.
- **What the AI produced:** The transfer route checked that the *source* account belongs to the caller, then handed the rest to `transfer()`.
- **What was wrong (found by the `security-reviewer` subagent, both confirmed against a scratch database):**
  1. The *destination* was not checked. Alice could send money to the `SYSTEM_VAULT`, which `transfer()` recorded as a `withdrawal`. That bypasses whatever rules the withdrawal endpoint will have.
  2. `transfer()` checked frozen status before funds. An under-funded request to Bob's account answered `ACCOUNT_FROZEN` if Bob was frozen and `INSUFFICIENT_FUNDS` if not, so Alice could learn another customer's account status without moving money.
- **What was done instead:** The transfer route rejects a vault destination with 400. `transfer()` now checks the source's status, then its funds, then the destination's status.
- **How verified:** New tests `THREAT withdrawal by transfer` and `THREAT frozen-status probe`. A separate mutation check removed the ownership checks and confirmed that `THREAT IDOR transfer`, `THREAT IDOR statement` and `THREAT vault minting` fail without them. 46/46 tests pass.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/249c0bf

## 2026-11-08: A failing audit write replaced the real error (audit trail)

- **Asked:** Audit every denied or failed request in its own transaction, so a rollback cannot erase it.
- **What the AI produced:** The `audited` helper in `app.js` caught the request's error, wrote an `error` audit row through the pool, then rethrew.
- **What was wrong (found by the `security-reviewer` subagent):** If the audit insert itself failed, its exception replaced the original one. An `INSUFFICIENT_FUNDS` transfer came back as `500 INTERNAL`, and the real cause was never logged. No money moved, but the client got the wrong answer and the failure was invisible.
- **What was done instead:** The audit write's own failure is logged with `console.error`, and the original error is still returned.
- **How verified:** Test `a failing audit write does not hide the original error` makes every new `audit_log` row fail (`CHECK (false) NOT VALID`) and asserts the response is still `422 INSUFFICIENT_FUNDS`.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/249c0bf

## 2026-11-08: Deposits were logged as ordinary transfers (audit trail)

- **Asked:** Phase 3: admin-only deposits, own-account withdrawals and a reconciliation endpoint, all reusing `transfer()`.
- **What the AI produced:** The new routes reused `transfer()` unchanged. Its success audit row was still hard-coded as `action: "transfer"`, with `target` set to the source account.
- **What was wrong (found by the `security-reviewer` subagent):** Every successful deposit was logged as a "transfer" from the vault. Failed deposits were logged as "deposit" by the route. An auditor filtering for `deposit` saw only the failures, so a rogue admin creating money would have blended into routine transfers. The reviewer also found that reconcile missed a transaction with no ledger rows, because it grouped only the rows that existed.
- **What was done instead:** `transfer()` now takes the audit action and target from the transaction type (`deposit`, `withdraw`, `transfer`), matching the names the routes use for denials and failures. Reconcile now starts from `transactions`, so an empty one is reported.
- **How verified:** New tests `THREAT hidden deposits` (one admin deposit adds exactly one `success`/`deposit` row, targeting the credited account) and `reconcile reports a transaction that has no ledger rows`. 58/58 tests pass.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/a79b4a6

## 2026-11-08: A replay could report a committed payment as a server error (idempotency / audit trail)

- **Asked:** Phase 4: per-user idempotency keys, a replay that answers exactly like the first call, and an audit row for every replay.
- **What the AI produced:** The `moneyRoute` helper wrote the replay's audit row with a plain `await audit(...)` before sending the 201.
- **What was wrong (found by the `security-reviewer` subagent):** If that audit insert failed, the error escaped and the client got `500 INTERNAL` for a payment that had already committed. The 500 happened outside the `audited` helper, so it left no error row either. A client that trusts the 500 might pay again some other way. This was the same mistake fixed in Phase 2 for the failure path, repeated in new code.
- **What was done instead:** The replay audit write now catches and logs its own failure, and the client still gets the original 201. The reviewer also asked for two decisions to be pinned by tests: a replay after the account is frozen still reports the original payment, and a withdrawal key reused on a transfer to the vault is refused, not replayed.
- **How verified:** New tests `a replay after the source account is frozen reports the payment that already happened` and `a withdrawal key reused on a transfer to the vault is refused, not replayed`. 66/66 tests pass. There is no automated test that forces the replay audit write to fail.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/724f4f8

## 2026-11-09: THREATS.md had drifted from the tests (documentation honesty)

- **Asked:** Phase 5: stress tests for concurrent overdraft and opposite-direction transfers, and a final check that THREATS.md matches the tests.
- **What the AI produced earlier:** In Phase 2, fixing the security reviewer's findings added two tests (`THREAT withdrawal by transfer`, `THREAT frozen-status probe`). Their threats were never added to THREATS.md, and the commit and my summary did not say so.
- **What was wrong:** THREATS.md is graded as "every threat mapped to a test", and CLAUDE.md says docs must describe what exists. For three phases it silently omitted two real defenses. Nothing in the project would have noticed.
- **What was done instead:** A new test file `threats.test.js` reads THREATS.md and fails if a test it names does not exist, or if a `THREAT` test is not listed. Its first run failed on exactly those two tests, plus the new deadlock test. All three are now documented in THREATS.md.
- **How verified:** The failing run showed the three missing titles; after the fix, 71/71 pass on three consecutive runs. A mutation check on the new deadlock test (locking accounts in request order instead of ascending id) made it fail with Postgres `deadlock detected`, so the stress test does catch the bug it exists for.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/4a0c4f0

## 2026-11-09: Pay-by-account-number leaked which accounts exist, and CORS accepted "null" (authorization / information leak)

- **Asked:** Phase 6: let account holders pay each other by account number from the browser app, and let the browser read API answers (CORS) from a configured origin.
- **What the AI produced:** The transfer route looked up the recipient number first and validated the amount and idempotency key afterwards. `server.js` split `ALLOWED_ORIGINS` on commas and trusted every entry.
- **What was wrong (found by the `security-auditor` subagent, both confirmed by probes):**
  1. A malformed request (for example `amountPaise: "x"`) to a known number returned 400 and to an unknown number returned 404. Account numbers are sequential (`LP` plus 10 digits), so any account holder could count every live account without moving money.
  2. The value `null` in `ALLOWED_ORIGINS` was echoed back as an allowed origin, so sandboxed iframes and local files could read API answers. `*` and a trailing slash passed silently too (they allowed nothing, which would have been a confusing failure).
- **What was done instead:** The amount and idempotency key are validated before the number is looked up, so both cases now get the same 400. `parseAllowedOrigins` refuses anything that is not an exact origin, so the server does not start on a bad value. A third finding, that a funded user paying by number can see whether a recipient is frozen, was not changed: it is documented as an accepted tradeoff in THREATS.md and DECISIONS.md, and it is yours to overrule.
- **How verified:** New tests `THREAT account number probe` and `THREAT origin config`, written to fail on the old behavior; 80/80 API tests pass, plus 32 web tests. I did not re-run the old code to watch those two tests fail.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/e2013b4


> **Rules note (2026-11-09, not an AI-use entry):**
> Updated `CLAUDE.md` on 2026-11-08/09 to remove the `Co-Authored-By` trailer requirement and enforce manual `git push` after earlier commits (5 of the first 19) included the trailer.

## 2026-11-09: The commit-time balance check could be hidden with a temp table (database integrity)

- **Asked:** Deploy: give the API a restricted database role, then have the `security-reviewer` subagent audit the diff.
- **What the AI produced:** In Phase 1 the double-entry check `check_transaction_balanced()` was written as a plain trigger function that reads `ledger_entries` by its bare name. It passed every test in the next five phases and every earlier security review.
- **What was wrong (found by the reviewer, who ran it on a scratch database):** PostgreSQL searches the session's temporary schema before `public`, and every database user may create temp tables by default. A session could create a temp table named `ledger_entries`, insert a lone credit into the real one, and `COMMIT`. The deferred check read the empty fake table, saw 0 = 0 and passed. The account was credited 999,999 paise and the vault stayed at 0: money created with no debit. This needed SQL access to the database, not just the HTTP API, which is why the API tests never touched it. It had been there since Phase 1 and only surfaced when the review asked what the restricted role could do.
- **What was done instead:** All the trigger functions now pin `search_path = public, pg_temp`, so a temp table is searched last. A second thing I got wrong in the same change: my first test of the restricted role expected `GRANT ALL ... TO PUBLIC` to be rejected, but PostgreSQL turns a grant by a role without grant option into a warning and a no-op. I rewrote that test to prove the grant did nothing, which is the real property.
- **How verified:** The new test `THREAT temp table shadow` was written first and run against the old schema; it failed because `COMMIT` succeeded. After the fix it passes. A mutation check (giving the app role `UPDATE` on accounts) makes the two role tests fail. 88/88 API tests pass, all running as the restricted role.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/1d16c66

## 2026-11-09: The first Vercel deployment crashed on a file name (deployment)

- **Asked:** Deploy: make the API run as an Express function on Vercel.
- **What the AI produced:** `src/index.js` exports the Express app as the default export, as Vercel's documentation describes, but the factory that builds the app stayed in `src/app.js`, which exports only the named function `createApp`.
- **What was wrong:** Vercel's zero-config detection treats `app.js`, `index.js` and `server.js` as entry point candidates, and it picked `src/app.js` first. Every request to the deployed API failed with `FUNCTION_INVOCATION_FAILED` ("The default export must be a function or server"). All 88 local tests passed because they import the files directly and never go through Vercel's entry detection. I had read which names count as entries but not their order, and my plan only said I would check the docs. It was found only by sending a request to the live URL and reading the runtime log.
- **What was done instead:** The factory is now `create-app.js`, so `index.js` is the only candidate. DECISIONS.md records why the file is not called `app.js`.
- **How verified:** An import check shows `index.js` default-exports a function with `listen`, and 88/88 API tests pass. The fix is **not yet verified on the live site**: it needs a push, and the API's secrets are not set yet.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/37ed7eb

## 2026-11-09: My first fix for the Vercel entry point was incomplete (deployment)

- **Asked:** Make the API deployable on Vercel after its first build crashed.
- **What the AI produced:** After the runtime log said `src/app.js` was loaded as the entry and exported no app, I renamed the file to `create-app.js` so `src/index.js` would be the only candidate. I checked that `index.js` default-exports a working app and that all 88 tests passed, and reported the fix as ready for a push.
- **What was wrong:** I had fixed the symptom in the log without reading the rule behind it. The next build failed outright: `No entrypoint found which imports express. Found possible entrypoint: src/index.js`. Vercel's detector only accepts a file that imports `express` itself, so an entry that gets its app from another module is rejected. The first crash and this build failure were two halves of one rule. My local checks could not catch either, because nothing locally runs Vercel's detection. I found it by reading the build log of the new deployment.
- **What was done instead:** `index.js` imports `express`, creates an app and mounts the app from `create-app.js` inside it. I tested that wiring locally the way production runs it (`VERCEL=1`, restricted database role): `/api/me` answers a clean 401, a forwarded client address lands in the audit log, and a privileged database role is refused.
- **How verified:** 88/88 API tests pass and the local production-mode checks above pass. **Not verified on the live site yet:** the fix needs a push, and the API's secrets are not set.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/ffb5aa6

## 2026-11-09: The API could not connect to Supabase at all: no TLS (deployment / database security)

- **Asked:** Seed the Supabase database and connect the deployed API to it.
- **What the AI produced:** All six phases connected to Postgres with a plain `pg.Pool({ connectionString })` and were tested only against a local Docker Postgres, which has no TLS.
- **What was wrong:** Supabase accepts only encrypted connections. The first live attempt failed with `no encryption`. With TLS on, Node refused the connection (`SELF_SIGNED_CERT_IN_CHAIN`), because Supabase signs with its own root CA. The deployed API would have failed the same way. Nothing in the tests could catch it, since none of them touched a TLS database. Then I made it worse: I proposed `sslmode=no-verify` for the seed, which encrypts but accepts any server, and the environment's safety check blocked it. I should have reached for verification first, not last.
- **What was done instead:** With the owner's permission I downloaded Supabase's public root certificate and only trusted it after it verified the live direct and pooler servers, host names included. It is pinned in `api/src/supabase-ca.js`, and `poolConfig` applies it to Supabase hosts and drops any `sslmode` setting from the URL. The security review then found a second mistake of mine in that fix: a mixed-case or trailing-dot Supabase host name skipped the pin, and on Vercel a non-Supabase database got no TLS requirement at all. Both are fixed, and the API now refuses to start with TLS checking disabled. The seed itself was done through the Supabase connection tool, so no unverified connection was ever made.
- **How verified:** 94/94 tests pass. By hand, connections to the live direct host and the Mumbai pooler with a deliberately wrong login fail at authentication, not at the certificate, including when the URL carries `sslmode=no-verify`. **Not yet verified:** a real connection from the deployed API, which still needs its environment variables.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/67a7f97

## 2026-11-09: The live attack script assumed every answer comes from my API (testing)

- **Asked:** Prove the guarantees in THREATS.md against the deployed system, not just against local tests.
- **What the AI produced:** `api/scripts/attack.js` parsed every response as JSON and expected the API itself to answer each attack. It passed 16/16 against a local server.
- **What was wrong:** On its first run against the live site it crashed on the third check. For a token with `alg: none`, Vercel's platform firewall (`X-Vercel-Mitigated: deny`) answered with a plain-text `403 Forbidden` before the request reached the API, so `JSON.parse` threw. The check had also hard-coded a 401, so even without the crash it would have been marked as failed although the attack was refused. The script was only ever tested in the one environment where nothing sits in front of the API.
- **What was done instead:** The script now tolerates answers that are not JSON, and that one check accepts a refusal from either layer (401 from the API, 403 from the platform firewall). The API's own rejection of `alg: none` is still proven by the local test `THREAT no or forged token`.
- **How verified:** The re-run against `https://ledgerproof-api.vercel.app` passed 16/16, including exactly 5 of 20 simultaneous withdrawals succeeding and a balanced reconcile at the end. I also confirmed by hand that a garbage token reaches the API and gets its JSON 401, while the `alg: none` token is stopped at the platform edge.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/cf9a4dc

## 2026-11-09: Two of my tests claimed more than they proved, and arrays passed my UUID check (testing / authorization)

- **Asked:** Run a multi-agent audit (security-auditor, code-reviewer, test-runner, release-shipper) over the finished system.
- **What the AI produced earlier:** A deadlock test and a forged-token test that THREATS.md cited as proof of the lock ordering and of the HS256 pin, and an `isUuid`-style check written as `UUID.test(value)`.
- **What was wrong (found by the code-reviewer and the security-auditor; I re-ran both claims myself):**
  1. Deleting `ORDER BY id` from `lockAccounts()` left every opposite-transfer test green (two runs of each file), so nothing proved the ordering that THREATS.md and DECISIONS.md credited to it. My first re-check of this was itself wrong: I ran two test files at once, they wiped the same test database, and I read the artifacts as a result.
  2. `jsonwebtoken` already rejects `alg: none` by default, so the forged-token test stayed green without the `algorithms: ["HS256"]` pin. An HS512 token signed with the real secret was accepted when the pin was removed.
  3. `UUID.test(["<id>"])` is true, because an array of one id turns into that id as text. A transfer with `toAccountId: [id]` reached Postgres and returned a 500 instead of a 400.
- **What was done instead:** A `THREAT lock order` test that holds the lower account's lock, starts a transfer from the higher account, waits until Postgres shows it blocked, then checks the higher account is still free. It fails 3 of 3 runs without `ORDER BY id`. The reviewer then found it only discriminates under the plan Postgres currently picks, so I added a precondition that fails loudly if that changes. An HS512 case now proves the pin (fails without it). `isUuid()` requires a string and replaced every `UUID.test` call. The audit's other Lows were fixed too: `X-Powered-By` is off on the outer app, and the API role's INSERT on the history tables is per column, so it cannot choose an id or back-date a timestamp.
- **How verified:** Each new test was run against deliberately broken code and failed, then passed on the real code. 97/97 API tests and 32/32 web tests pass. On the live Supabase database the new grants were then applied in one migration; the role's insertable columns were checked per table (no table-wide INSERT left, no `id` or `created_at`), the security advisor stayed at 0 findings, and the 16 live attack checks passed afterwards.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/24c1418

## 2026-11-10: Shared trigger referenced a table-specific column on NEW, and audit insert broke on unmigrated columns (database triggers / deployment)

- **Asked:** Add the KYC onboarding state machine (`PENDING_KYC` -> `ACTIVE`), SHA-256 hash-chained audit trail (`chain_audit_log`), and PostgreSQL-backed token revocation (`revoked_tokens`) and rate limiting (`rate_limit_buckets`).
- **What the AI produced:**
  1. In commit `caa27b1`, `audit()` was changed to insert a physical `target_type` column into `audit_log`, and `transfer()` was changed to insert extended columns into `transactions`. When Vercel auto-deployed `caa27b1` against the live Supabase database (which still had the commit `1d16c66` schema and column grants), `POST /api/auth/login` returned `500 INTERNAL` because `target_type` was not an insertable column on the live database.
  2. When moving `transactions` metadata updates into `apply_ledger_entry()`, the AI wrote `IF TG_TABLE_NAME = 'transactions' AND TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 AND NEW.type IS NOT DISTINCT FROM OLD.type` inside `prevent_ledger_mutation()`, which is attached to both `transactions` and `ledger_entries`.
- **What was wrong:**
  1. Deploying code that writes new columns before the database migration is run breaks live sign-in immediately.
  2. In PL/pgSQL, `NEW.type` is resolved against the firing table's row type when the IF expression is planned. When `THREAT tampering: ledger entries cannot be updated or deleted` (`schema.test.js`) ran `UPDATE ledger_entries SET amount_paise = 1`, Postgres failed with `error: record "new" has no field "type"` instead of raising `ledger_entries is append-only`.
- **What was done instead:** `target_type` was converted to a `GENERATED ALWAYS AS (...) STORED` column on `audit_log` so `audit()` inserts only the original seven columns granted to `ledgerproof_app`. `prevent_ledger_mutation()` was simplified to check `IF TG_TABLE_NAME = 'transactions' AND TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN RETURN NEW; END IF;` without referencing `NEW.type`.
- **How verified:** `schema.test.js` passed 14/14 and the full suite passed 105/105 API tests and 32/32 web tests. After pushing commit `9cc726b`, `POST /api/auth/login` on `https://ledgerproof-api.vercel.app` returned `200 OK`.
- **Commit:** https://github.com/skmdshariff143-ai/ledgerproof/commit/caa27b1 and https://github.com/skmdshariff143-ai/ledgerproof/commit/9cc726b

## 2026-11-11: Legacy audit_log migration left existing rows with NULL entry_hash, and verify-live.js counted a fallback as PASS (audit trail / verification honesty)

- **Asked:** Audit the repository at `9cc726b`, reproduce what happens when `api/scripts/migrate.js` upgrades a populated legacy schema, and separate RBAC from registration/onboarding in `verify-live.js`.
- **What the AI had produced in `9cc726b`:**
  1. `UPGRADE_SQL` in `api/scripts/migrate.js` ran `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash text` without backfilling hashes for existing legacy rows, and `verifyAuditChain()` silently fell back to computing hashes on the fly when `entry_hash` was missing.
  2. In `api/scripts/verify-live.js`, when `POST /api/auth/register` failed against the unmigrated remote database, the script fell back to testing an RBAC denial (`POST /api/admin/users/:id/approve` as an account holder -> `403`) and logged `PASS`.
- **What was wrong:**
  1. Reproducing the upgrade on a disposable legacy schema (`ledgerproof_test`) with two synthetic `audit_log` rows showed that `migrate()` left `entry_hash = NULL` on those rows, so `verifyAuditChain()` immediately returned `{"verified":false,"totalEntries":2,"tamperedSeq":1,"actualHash":null}`.
  2. Counting an RBAC refusal as a pass when registration failed hid the fact that the remote database migration was still pending.
- **What was done instead:**
  1. `migrate()` now runs inside a single `BEGIN ... COMMIT` transaction, takes `ACCESS EXCLUSIVE` table locks plus `pg_advisory_xact_lock(20261110)`, temporarily disables `audit_log_append_only`, backfills `previous_hash` and `entry_hash` in ascending `id` order for confirmed legacy (`NULL`) rows while verifying any existing hashed prefix (raising an exception on inconsistent hashes or out-of-order partial state), re-enables `audit_log_append_only`, and sets `entry_hash NOT NULL UNIQUE`.
  2. `verifyAuditChain()` now returns `verified: false, schemaMigrated: false, reason: "MISSING_HASH_COLUMNS"` if the hash columns are absent, and `verify-live.js` reports distinct `PASS`, `FAIL`, `PENDING_MIGRATION`, and `SKIPPED` statuses (exiting non-zero if any check is `FAIL` or `PENDING_MIGRATION`).
- **How verified:** Focused test `THREAT legacy audit migration` in `api/test/onboarding-and-chain.test.js` tests a fresh DB, a populated legacy DB, a repeat migration, appending a new audit row as `ledgerproof_app`, and rejection of both inconsistent existing hashes and ambiguous partial state. 106/106 API tests and 32/32 web tests pass.

## 2026-11-13: Logout failed open and /ready called a missing table "healthy" (authorization / token revocation)

- **Asked:** Audit the repository and live deployment at `95754c7` before launch, and treat `memory_fallback` as a symptom rather than a pass.
- **What the AI had produced in `9cc726b`:**
  1. `isTokenRevoked()` in `api/src/auth.js` returned `false` and `revokeToken()` silently succeeded when `revoked_tokens` was missing (`42P01`) or not granted (`42501`).
  2. `checkRateLimiterHealth()` in `api/src/rate-limit.js` reported `status: "ready"` while on the in-memory fallback, so `GET /ready` returned `200 healthy`.
- **What was wrong:** Live `GET /ready` returned `rateLimiterBackend: "memory_fallback"`, so the production V2 migration that creates `rate_limit_buckets` and `revoked_tokens` is not applied (or the runtime role lacks the grant). With that code, a logged-out JWT stayed valid on every other serverless instance until it expired, and the health check hid it. Not reproduced live, because that would write to the production database.
- **What was done instead:** Both revocation functions now let the database error propagate, so the request fails with `500` instead of treating an unprovable token as valid, and a failed logout no longer reports `logged_out`. `/ready` returns `503 degraded` while rate limiting is on the memory fallback. Commit: https://github.com/skmdshariff143-ai/ledgerproof/commit/eedcf7e2b69bfb3028f87fe3ef5ba08397c32bb3
- **How verified:** New `api/test/revocation-fail-closed.test.js` failed 6/6 on the old code and passes 6/6 on the fix. The full API suite passed 112/112 (0 fail, 0 skipped) against the disposable local `ledgerproof_test` database. The fix must not reach production before `npm run db:migrate`, and `revoked_tokens` must then be checked directly as `ledgerproof_app`.

## 2026-11-13: /ready leaked driver errors, and preview builds called the production API (information leak / data isolation)

- **Asked:** Harden the public readiness answer, keep Vercel previews away from production data, and correct the README's live token-revocation claim.
- **What the AI had produced:**
  1. `GET /ready` in `api/src/create-app.js` returned `error: err.message` on failure, and my first uncommitted draft still let a failed startup role check fall through to a generic `500`.
  2. `web/src/api.js` read `VITE_API_URL`, which the Vercel web project also sets for previews, so every preview build called the production API. My first fix fell back to the production URL whenever `VERCEL_ENV` was missing, and offered a `VITE_PREVIEW_API_URL` that the web CSP (`connect-src`) would have blocked anyway.
  3. README listed cross-instance token revocation under "Built and verified" while production had no `revoked_tokens` table.
- **What was wrong:** A database error message can contain the host, port and role. A preview's requests reached production; CORS decides only what the browser may read, not whether the request arrives. The `security-reviewer` agent flagged the `VERCEL_ENV` fail-open, the CSP mismatch and the `500` path; while fixing the last one, a `const ready` in the handler shadowed the startup `ready` promise and broke four tests until it was renamed.
- **What was done instead:** `/ready` returns only `status`, `database`, `rateLimiter` and `rateLimiterBackend`, with `503` on any failure, and logs only the error code: https://github.com/skmdshariff143-ai/ledgerproof/commit/2ba4d65412cda192d420e3f4743269d3d2970f98. The web build resolves its API URL at build time and fails closed: only `VERCEL_ENV=production` or a local build aimed at localhost gets one; other builds turn sign-in and money actions off and show a banner: https://github.com/skmdshariff143-ai/ledgerproof/commit/1d6ac9b5c977f1df9d8ff3890da501dab2f13a27. README now says revocation is verified locally only, and records the read-only production schema check.
- **How verified:** `api/test/readiness.test.js` (5 tests; the two leak tests failed on the old code) and `web/src/apiUrl.test.js` (4 tests). Full API suite 114/114 and web 36/36 against the disposable `ledgerproof_test` database. A preview-mode build contains no production API URL, and in a browser its demo login sent no request beyond its own static files.

## 2026-11-13: Production logout could be proven only in parts: the stored row was observed, the 401 was reported (audit trail / token revocation)

- **Asked:** Verify on production that logout really revokes a token after the V2 migration and the release of `9c02861`, without claiming a pass from table counts or `/ready`.
- **What the AI had produced:** A release plan whose proof of the revocation store was a synthetic `revoked_tokens` insert as `ledgerproof_app` in a rolled-back transaction, plus the live checks in `verify-live.js`. Neither could be run by the AI.
- **What was wrong (the evidence gap):** Supabase's owner role could not `SET ROLE ledgerproof_app`, so the synthetic insert never ran and only the grants were checked. The AI does not send passwords to a production host, so it could not sign in. `/ready` reads only `rate_limit_buckets`, and a grant is not a write. A rejected revoked token writes no `audit_log` row and Vercel runtime logs carry no response codes, so the `401` could not be seen from the server side. Two database checks after the owner first reported running the script found no trace of it (no `revoked_tokens` row, no new registration).
- **What was done instead:** The owner ran `npm run verify:live` against production. The AI then read the database: an `audit_log` `logout` entry with outcome `success`, and one `revoked_tokens` row written 4 ms earlier, with query statistics showing the insert came from `ledgerproof_app`. The reused-token `401` is recorded in README as the owner's report of the script output. README no longer says revocation is "not live yet", does not claim all 13 checks passed (the summary was not kept), and states that one `401` does not test revocation across server instances. Implementation: https://github.com/skmdshariff143-ai/ledgerproof/commit/eedcf7e2b69bfb3028f87fe3ef5ba08397c32bb3 (fail-closed revocation) and https://github.com/skmdshariff143-ai/ledgerproof/commit/2ba4d65412cda192d420e3f4743269d3d2970f98 (`/ready`). Release commit, which also adds the logout check to `verify-live.js`: https://github.com/skmdshariff143-ai/ledgerproof/commit/9c02861aa772ae108d27a0fe07eb9aafde7bd375
- **How verified:** Read-only SQL on the production database and the Vercel alias for `ledgerproof-api.vercel.app` (deployment built from `9c02861`). Before release the same migration was rehearsed on a local copy of the production V1 schema, where `verify-live.js` passed 13/13 as `ledgerproof_app`. Still unverified: revocation across different server instances, and the production result of `GET /api/admin/audit-logs/verify`.
