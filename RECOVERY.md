# Recovery: the audit-chain function

Only the single function `chain_audit_log()` was changed on production (2026-11-13, UTC). This file
says how to put the previous version back and how to check the result. Nothing here is needed unless
the new function misbehaves.

## What was replaced

| | Body | md5 of `pg_get_functiondef()` |
|---|---|---|
| Before (production until 2026-11-13) | `db/schema.sql` at commit `9c02861` | `54a3835a1c72f8fde33eaa2ebd8d27dd` |
| After (commit `d5ad9b1`) | `db/schema.sql` at the current commit | run the query below on the database to read it |

The old body took the row id before the advisory lock, so restoring it brings the id race back.

## Restore the old function

1. Connect as the schema owner (the `postgres` role), not as `ledgerproof_app`.
2. Print the old definition and run only its `CREATE FUNCTION` statement as `CREATE OR REPLACE FUNCTION`:

   ```
   git show 9c02861:db/schema.sql
   ```

   It is the statement that starts `CREATE FUNCTION chain_audit_log()` and ends at the next `$$;`. Replacing
   the function keeps the trigger binding, the owner and the privileges, and takes no table lock.
3. A private copy of the exact text that was replaced is kept outside the repository by the owner.

## Check the result

```sql
select md5(pg_get_functiondef(oid)) from pg_proc
 where proname = 'chain_audit_log' and pronamespace = 'public'::regnamespace;
select tgname, tgenabled from pg_trigger
 where tgrelid = 'public.audit_log'::regclass and not tgisinternal;
```

- After a restore the first query must return `54a3835a1c72f8fde33eaa2ebd8d27dd`.
- The second must list `audit_log_append_only`, `audit_log_chain` and `audit_log_no_truncate`, all `O` (enabled).
- Then recompute the chain: for every row the stored `entry_hash` must equal the SHA-256 of
  `previous_hash|id|actor|role|action|target|details|created_at` as `chain_audit_log()` builds it, and each
  `previous_hash` must equal the row before's `entry_hash` (`GENESIS_LEDGERPROOF_2026` for the first row), and call
  `GET /api/admin/audit-logs/verify` with an admin or auditor token.

## What the 2026-11-13 production change did to the data

- The audit table was not changed: it kept its 205 rows, all with a valid hash and link, before and after.
- The rollback test (one synthetic audit insert inside a block that always rolled back) advanced the id
  sequence by two, so production ids skip 206 and 207. The verifier accepts gaps.
- No audited request reached production between the change and the last check, so a normal request through
  `ledgerproof_app` and the new function has not yet been observed there; locally it is covered by the tests.
