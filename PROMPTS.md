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
