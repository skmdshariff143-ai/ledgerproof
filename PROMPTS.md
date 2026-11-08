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
