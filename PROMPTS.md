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
