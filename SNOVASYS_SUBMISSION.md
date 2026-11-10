# Snovasys Fresher Hiring Challenge 2026 — VVIT
## Problem Statement: BalanceVault — Money Movement with a Ledger You Can Prove

Below are the ready-to-paste answers for the 6 Snovasys Hiring Challenge submission form questions.

---

### Q1. What did you build?

I built **LedgerProof**, a full-stack double-entry banking ledger, KYC onboarding system, and cryptographically verifiable audit trail where **every money-movement and authorization rule is enforced independently in both the Node.js API and inside PostgreSQL itself**.

**Tech Stack:**
- **Backend (`api/`):** Node.js 22 (ESM), Express 4, `pg` (PostgreSQL pool), `jsonwebtoken` (HS256 signed JWTs), `bcryptjs` (cost-12 password hashing), `zod` (strict request validation), `helmet` (security headers), and custom sliding-window rate limiters.
- **Database (`db/`):** PostgreSQL 16+ / Supabase (`schema.sql` + `roles.sql`) running under a least-privilege application role (`ledgerproof_app` with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) and `SECURITY DEFINER` triggers owned by the schema owner.
- **Frontend (`web/`):** React 18, Vite 5, React Router 6 — featuring a Role & KYC Status Banner, Account Holder Transfer & Double-Entry Statement view, Admin KYC Onboarding & Freeze Console, Auditor Reconciliation & Tamper-Proof Hash Chain Verifier, and a live **"Break It"** adversarial security test panel.

**Core Capabilities:**
1. **Three-Role Server-Enforced RBAC (`ADMIN`, `AUDITOR`, `ACCOUNT_HOLDER`):**
   - `ACCOUNT_HOLDER` can view only their own accounts/ledger entries and initiate transfers strictly from accounts they own.
   - `ADMIN` can approve/reject KYC onboarding (`PENDING_KYC -> ACTIVE`), freeze/unfreeze accounts, inspect system posture, and verify the SHA-256 audit chain, but **cannot move money** (`403 ROLE_CANNOT_TRANSFER`).
   - `AUDITOR` has read-only access to the full ledger, reconciliation endpoint (`GET /api/reconcile`), and cryptographic audit chain verifier (`GET /api/admin/audit-logs/verify`), and **cannot move money or alter state**.
2. **KYC Onboarding State Machine & First-Admin Bootstrap:**
   - Self-registered users (`POST /api/auth/register`) start in `PENDING_KYC` status with a `0`-paise `PENDING_KYC` account. Both sending and receiving funds are rejected with `403 KYC_PENDING`.
   - Only an authenticated `ADMIN` can transition a user via `POST /api/admin/users/:id/approve` (`/reject`, `/freeze`), which atomically activates their ledger account and writes a hash-chained audit record.
   - Idempotent First-Admin Bootstrap via CLI (`npm run db:bootstrap-admin`) or `POST /api/system/bootstrap` (guarded by `X-Bootstrap-Secret`) provisions the first `ADMIN` and system treasury (`SYS-TREASURY-001`) only when zero admins exist (`409 ALREADY_BOOTSTRAPPED` thereafter).
3. **Provable Double-Entry Ledger & Concurrency Safety:**
   - Money is stored in integer minor units (`BIGINT` paise) — zero floating-point math.
   - Every transfer executes inside a single `BEGIN ... COMMIT` transaction: checks `idempotency_key` first, locks both accounts in deterministic ascending ID order (`SELECT ... WHERE id = ANY($1::bigint[]) ORDER BY id ASC FOR NO KEY UPDATE`) to prevent deadlocks and lost updates, inserts two balanced rows in `ledger_entries` (`DEBIT` and `CREDIT`), updates cached balances via a `SECURITY DEFINER` trigger, and verifies `SUM(DEBIT) == SUM(CREDIT)` via a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` before commit.
4. **Cryptographic SHA-256 Hash-Chained Audit Trail:**
   - Every security and financial event is recorded in `audit_log` (exposed as `audit_logs`).
   - A PostgreSQL `BEFORE INSERT` trigger (`chain_audit_log`) acquires a transaction-scoped advisory lock (`pg_advisory_xact_lock`), reads the prior row's `entry_hash` (defaulting to `'GENESIS_LEDGERPROOF_2026'`), and computes:
     `entry_hash = SHA256(previous_hash | seq | actor_id | actor_role | action | target_id | canonicalJson(metadata) | created_at_iso)`
   - Append-only triggers (`prevent_ledger_mutation`, `prevent_audit_mutation`) and revoked SQL privileges block `UPDATE`, `DELETE`, and `TRUNCATE` on `transactions`, `ledger_entries`, and `audit_log`.

---

### Q2. How do we run and verify it?

#### Local Setup (5 Minutes)

1. **Install dependencies, apply schema & roles, seed demo data, and run all tests from the repo root:**
   ```bash
   cp .env.example .env
   npm install
   npm run db:migrate
   npm run db:bootstrap-admin
   npm run db:seed
   npm test
   npm run build
   npm run verify:live
   ```
2. **Start the application locally:**
   ```bash
   # Terminal 1 — API on http://localhost:3000
   cd api && npm run dev

   # Terminal 2 — Web UI on http://localhost:5173
   cd web && npm run dev
   ```

#### Live & Adversarial Verification Steps
- **Health & Readiness Probes:**
  - `curl http://localhost:3000/health` -> `200 OK` (`{"status":"ok"}`)
  - `curl http://localhost:3000/ready` -> `200 OK` (`{"status":"healthy","database":"connected","rateLimiter":"ready"}`)
- **Demo Logins:**
  - Admin: `admin@ledgerline.com` (`Admin@123`) | Auditor: `auditor@ledgerline.com` (`Auditor@123`)
  - Holder A: `alice@ledgerline.com` (`Alice@123`) | Holder B: `bob@ledgerline.com` (`Bob@123`)
- **Verify Cryptographic Audit Chain & Double-Entry Invariants:**
  - Log in as `admin@ledgerline.com` or `auditor@ledgerline.com` and click **"Verify Ledger & Audit Chain Integrity"** (calls `GET /api/admin/audit-logs/verify` and `GET /api/ledger/reconcile`).
- **End-to-End Live Verification & Attack Scripts:**
  ```bash
  LIVE_API_URL=https://ledgerproof-api.vercel.app LIVE_WEB_URL=https://ledgerproof-web.vercel.app npm run verify:live
  API_URL=https://ledgerproof-api.vercel.app npm run attack
  ```

---

### Q3. Which AI tools did you use?

- **Claude Code (Claude Opus 4.6) & Google Antigravity:** Used for pair-programming the PostgreSQL trigger logic, designing the concurrency test suite (`Promise.all` overdraft races, inverted AB/BA deadlock tests, idempotency replay races), scaffolding the React verification views, and performing adversarial code reviews.
- All prompts, rejected AI suggestions, and human overrides are documented in [`PROMPTS.md`](PROMPTS.md).

---

### Q4. What did the AI get wrong, and what did you fix yourself?

1. **Vercel Serverless Entrypoint (`src/index.js` vs `app.listen()`) & Monorepo Routing:**
   - *What AI got wrong:* The initial Vercel deployment setup pointed `vercel.json` at `src/app.js` while leaving `src/index.js` executing an unconditional `app.listen(PORT)` at module import time. When Vercel's `@vercel/node` builder targeted `src/index.js`, the serverless function either bound to a random port and hung or failed build resolution, and CORS rejected browser preflight requests from preview URLs.
   - *How I fixed it:* I inspected the Vercel build/runtime logs, refactored `api/src/index.js` so `app.listen()` only runs when `process.env.NODE_ENV !== "production" && !process.env.VERCEL`, exported the Express `app` as the default serverless handler (`export default app`), updated `api/vercel.json` with explicit `"builds": [{"src": "src/index.js", "use": "@vercel/node"}]` and `"routes": [{"src": "/(.*)", "dest": "src/index.js"}]`, and updated the CORS origin validator to allow configured `FRONTEND_URL` origins, `.vercel.app` deployments, and `http://localhost:*`.

2. **Supabase Transaction Pooler (`6543`) vs Direct Migration Connection (`5432`) & TLS CA Pinning:**
   - *What AI got wrong:* AI initially used a single `DATABASE_URL` for both runtime queries and multi-statement DDL migrations (`schema.sql` / `roles.sql`), and stripped `?sslmode=require` indiscriminately when attaching a pinned Supabase CA certificate. Running DDL and `ALTER DEFAULT PRIVILEGES` through PgBouncer in transaction-pooling mode (`:6543`) caused prepared-statement and session-level role switching issues, while local/CI Postgres without SSL failed when `ssl` config was forced globally.
   - *How I fixed it:* I separated runtime traffic onto `DATABASE_URL` (Supabase Transaction Pooler on port `6543` with `?pgbouncer=true`) and created dedicated migration/bootstrap scripts (`api/scripts/migrate.js`, `api/scripts/bootstrap-admin.js`) that prioritize `DIRECT_URL` (port `5432`) for DDL and role provisioning. In `api/src/db.js`, I gated custom TLS CA pinning so it activates only when the connection string explicitly requests SSL (`sslmode=require` / `ssl=true`) or `PGSSLROOTCERT` is set.

3. **Naive Balance Updates & Application-Only Invariants vs Row-Level Locking & DB Triggers:**
   - *What AI got wrong:* Early AI drafts suggested updating `accounts.balance` directly from application SQL (`UPDATE accounts SET balance = balance - $1`) and checking `SUM(DEBIT) == SUM(CREDIT)` in JavaScript before `COMMIT`. Under concurrent requests, two parallel transfers passed the application-level balance check before either committed (lost update / negative balance), and any bug or SQL injection in the app could mutate balances without writing matching `ledger_entries`.
   - *How I fixed it:*
     - I revoked direct `UPDATE (balance_paise)` privileges from `ledgerproof_app` in `db/roles.sql` so naked `UPDATE accounts SET balance_paise = ...` fails with SQLSTATE `42501 (insufficient_privilege)`.
     - I moved balance updates into a `SECURITY DEFINER` trigger (`apply_ledger_entry`) that fires only when a row is inserted into `ledger_entries`.
     - Inside `executeTransfer`, I locked both accounts in deterministic ascending ID order (`SELECT ... WHERE id = ANY($1::bigint[]) ORDER BY id ASC FOR NO KEY UPDATE`) before checking KYC/frozen status and balance, eliminating both race-condition overdrafts and AB/BA deadlocks.
     - I added a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` (`enforce_transaction_balanced`) that verifies at `COMMIT` time that every transaction has >= 2 entries, impacts >= 2 distinct accounts, and has `SUM(DEBIT) == SUM(CREDIT)` with positive integer amounts.

4. **Database Privilege Bypass via `TRUNCATE` and Unsynchronized Audit Hash Chains:**
   - *What AI got wrong:* AI wrote `BEFORE UPDATE OR DELETE` triggers to make `ledger_entries` and `audit_log` append-only, missing that PostgreSQL's `DEFAULT` table grants include `TRUNCATE` (which bypasses row-level `BEFORE DELETE` triggers). Additionally, computing SHA-256 audit hashes in Node.js before `INSERT` created a race condition when two concurrent transactions read the same `previous_hash`.
   - *How I fixed it:* I explicitly revoked `TRUNCATE`, `UPDATE`, and `DELETE` in `db/roles.sql` AND added a `BEFORE TRUNCATE` trigger alongside the `BEFORE UPDATE OR DELETE` triggers (`prevent_ledger_mutation`, `prevent_audit_mutation`). I also moved the SHA-256 hash computation into an in-database `BEFORE INSERT` trigger (`chain_audit_log`) guarded by `pg_advisory_xact_lock(hashtext('audit_log_chain'))`, guaranteeing a strictly linear, race-free hash chain even under parallel load.

---

### Q5. What integrity decisions did you make to guarantee the wrong person cannot move money and that you can prove who moved it?

| Integrity Guarantee | Application Layer Enforcement (`api/src/`) | Database Layer Enforcement (`db/schema.sql` & `db/roles.sql`) |
| :--- | :--- | :--- |
| **Wrong person cannot move money** | `requireAuth` verifies HS256 JWT signature, algorithm whitelist, expiry, and `jti` revocation. `executeTransfer` re-queries `accounts` + `users` inside the SQL transaction to verify `owner_user_id === actor.id`, `role === 'holder'`, `user.status === 'ACTIVE'`, and `account.status === 'active'`. Body fields like `userId`, `owner_id`, or `role` are rejected by Zod `.strict()`. | `ledgerproof_app` cannot `UPDATE users (role)` (`42501`). Startup posture check (`verifyDbRolePosture`) refuses to boot if `ledgerproof_app` is a superuser or can edit roles. |
| **Unapproved (`PENDING_KYC`) or frozen accounts cannot move or receive money** | `executeTransfer` checks both source and destination accounts inside the `FOR NO KEY UPDATE` lock: if either is `PENDING_KYC` (`403 KYC_PENDING`) or `frozen` (`423 ACCOUNT_FROZEN`), the transaction rolls back before any entry is written. | `apply_ledger_entry` trigger independently inspects `accounts.status` on both legs and raises `P0001 (ACCOUNT_FROZEN)` if any leg is not `active`. |
| **Balances can never go negative or drift from ledger entries** | `executeTransfer` locks both accounts in ascending ID order (`ORDER BY id ASC FOR NO KEY UPDATE`) and verifies `from.balance_paise >= amountPaise`. | `accounts` has `CHECK (balance_paise >= 0)` (SQLSTATE `23514`), `ledgerproof_app` has no `UPDATE` grant on `balance_paise` (`42501`), `apply_ledger_entry` updates balances strictly from `ledger_entries`, and `enforce_transaction_balanced` verifies `SUM(DEBIT) == SUM(CREDIT)` at commit. |
| **Ledger and audit history cannot be rewritten or deleted** | No API endpoint exposes update/delete operations on transactions, ledger entries, or audit logs. | `ledgerproof_app` has `SELECT, INSERT` only; `prevent_ledger_mutation` and `prevent_audit_mutation` triggers raise `28000 (APPEND_ONLY_VIOLATION)` on any `UPDATE`, `DELETE`, or `TRUNCATE`. |
| **Cryptographic proof of who moved money and when** | Every transfer, KYC state change, freeze/unfreeze, bootstrap, and blocked unauthorized attempt writes an `audit_log` row inside the same SQL transaction (or error path) capturing `actor_id`, `actor_role`, `action`, `target_id`, `ip_address`, `user_agent`, `request_id`, and JSONB metadata. | `chain_audit_log` trigger locks the chain head (`pg_advisory_xact_lock`), links `previous_hash` from `'GENESIS_LEDGERPROOF_2026'`, and computes `entry_hash = SHA256(...)`. `GET /api/admin/audit-logs/verify` recomputes every hash from Genesis to tip and pinpoints the exact `seq` if even a single byte was altered by a superuser. |

---

### Q6. Current verification status and production hardening architecture

#### Current Verification Status
- **105 / 105 Backend Integration Tests Passing (`npm test`):**
  - Covers every threat in `THREATS.md` (`threats.test.js` enforces 1:1 traceability between documented threats and automated tests).
  - Covers RBAC (`401`/`403` on `/api/admin/*`), `PENDING_KYC` transfer blocking (`403 KYC_PENDING`), atomic overdraft rollback with zero orphan rows (`422 INSUFFICIENT_FUNDS`), 20-way concurrent overdraft race (`Promise.all`), 30-way inverted AB/BA deadlock stress test, idempotency replay and conflict (`409 IDEMPOTENCY_CONFLICT`), direct SQL privilege blocks (`42501` / `28000`), SHA-256 audit chain verification & superuser tamper detection (`GET /api/admin/audit-logs/verify`), PostgreSQL-backed token revocation & rate limiting (`revoked_tokens`, `rate_limit_buckets`), and PgBouncer transaction-level advisory lock safety (`pg_advisory_xact_lock`).
- **32 / 32 Frontend Tests & Production Build Passing (`cd web && npm test && npm run build`):**
  - Verifies float-free rupee-to-paise integer conversion (`money.test.js`) and builds the production Vite bundle cleanly.
- **8 / 8 Live Smoke Verification Checks (`npm run verify:live`) & 16 / 16 Live Adversarial Attack Checks (`npm run attack`):**
  - Programmatically verifies `/health`, `/ready`, `/api/system/status`, Admin JWT login, `/api/admin/audit-logs/verify` (`verified: true`), `ACCOUNT_HOLDER` -> `/api/admin/users` (`403`), `PENDING_KYC` transfer rejection (`403`), and idempotent double-entry transfers with `GET /api/ledger/reconcile` (`balanced: true`, `SUM(debits) == SUM(credits)`).

#### Serverless & PgBouncer Production Hardening Completed
1. **PostgreSQL-Backed JWT Revocation & Rate Limiting (`revoked_tokens` & `rate_limit_buckets`):** Eliminated process-local JavaScript `Map` state so logged-out/revoked JWT `jti`s (`POST /api/auth/logout`) and sliding-window rate-limit buckets persist in PostgreSQL and synchronize immediately across all Vercel serverless instances.
2. **Supabase PgBouncer Transaction-Pooler Safety (`:6543?pgbouncer=true`):** `chain_audit_log()` uses transaction-level `pg_advisory_xact_lock(20261110)` rather than session-level `pg_advisory_lock`, and all transaction settings use `SET LOCAL` inside `BEGIN ... COMMIT`, leaving zero dangling locks or session state on pooled connections.
3. **Pinned Supabase Root CA & Restricted DB Role (`ledgerproof_app`):** Production connections verify the TLS chain against Supabase's pinned root CA (`api/src/supabase-ca.js`) and fail closed at startup (`assertRestrictedRole`) if connected as a superuser or table owner.
