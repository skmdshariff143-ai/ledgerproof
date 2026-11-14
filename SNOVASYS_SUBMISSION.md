# Snovasys Fresher Hiring Challenge 2026 — VVIT
## Problem Statement: BalanceVault — Money Movement with a Ledger You Can Prove

Below are the ready-to-paste answers for the 6 Snovasys Hiring Challenge submission form questions, aligned 1:1 with the repository code, dependencies, and test suite.

---

### Q1. What did you build?

I built **Balance Vault** (the repository, URLs and database objects are still named `ledgerproof`), a full-stack double-entry banking ledger, KYC onboarding workflow, and cryptographically verifiable audit trail with defense-in-depth across the **Node.js API** and **PostgreSQL**:
- **Enforced in the Node.js API (backed by immutable DB columns and role grants):** HS256 JWT authentication and token revocation (`authenticate()`), route-level RBAC (`allowRoles()`), source-account ownership verification (`requireOwnAccount()`), and deterministic ascending-UUID lock ordering (`lockAccounts()`).
- **Enforced in both the Node.js API and PostgreSQL triggers/constraints/grants:** double-entry conservation (`SUM(debit) == SUM(credit)` via `transfer()` and deferred trigger `check_transaction_balanced()`), non-negative user balances (`user_balance_not_negative` and `apply_ledger_entry()`), active-account status checks (`transfer()` and `apply_ledger_entry()`), per-user idempotency (`idempotency_keys (user_id, key)`), append-only history (`prevent_ledger_mutation`, `prevent_audit_mutation`, `reject_change`), SHA-256 hash-chained audit logging (`chain_audit_log()`), and least-privilege runtime DB execution (`ledgerproof_app`).

**Tech Stack (Exact Repository Dependencies):**
- **Backend (`api/`):** Node.js 22+ (ESM), Express `^5.3.0`, `pg` `^8.13.0` (PostgreSQL pool with pinned Supabase Root CA in `api/src/supabase-ca.js`), `jsonwebtoken` `^9.0.3` (HS256 signed JWTs with `jti` revocation), `cors` `^2.8.6` (strict origin allow-list in `api/src/origins.js`), Node built-in `crypto.scrypt` + `timingSafeEqual` (`api/src/password.js`), strict UUID/paise validators (`api/src/errors.js`, `api/src/transfer.js`), and PostgreSQL-backed rate limiting (`api/src/rate-limit.js`).
- **Database (`db/`):** PostgreSQL 16+ / Supabase (`db/schema.sql` + `db/roles.sql`) running under a least-privilege application role (`ledgerproof_app` with `NOSUPERUSER`, no table ownership, no `UPDATE` on balances or roles, and no `DELETE`/`TRUNCATE` on history tables) plus `SECURITY DEFINER` triggers (`apply_ledger_entry`, `chain_audit_log`) with pinned `search_path = public, pg_temp`.
- **Frontend (`web/`):** React `^19.3.1`, Vite `^8.3.6`, Vitest `^5.1.0` — featuring float-free `BigInt` rupee/paise conversion (`web/src/money.js`), Role & KYC Status views (`HolderView.jsx`, `AdminView.jsx`, `AuditorView.jsx`, `Login.jsx`), an interactive Idempotency Retry Simulator (`MoneyForm.jsx`), a Reconciliation & SHA-256 Audit Chain Verifier (`ReconcileBanner.jsx`), and strict Content-Security-Policy headers (`web/vercel.json`).

**Core Capabilities:**
1. **Three-Role Server-Enforced RBAC (`admin`, `auditor`, `account_holder`):**
   - `account_holder` can view only their own accounts/statements (`GET /api/accounts`, `GET /api/accounts/:id/statement`) and initiate transfers/withdrawals strictly from accounts they own (`requireOwnAccount` in `api/src/create-app.js`).
   - `admin` can approve/reject/freeze KYC onboarding (`POST /api/admin/users/:id/approve`, `/reject`, `/freeze`), open checking accounts (`POST /api/accounts`), freeze/unfreeze accounts (`POST /api/accounts/:id/freeze`, `/unfreeze`), fund accounts from the system vault (`POST /api/transactions/deposit`), and verify the ledger/audit chain, but **cannot transfer money out of user accounts** (`403 FORBIDDEN`).
   - `auditor` has read-only access to all statements, the double-entry ledger (`GET /api/ledger/entries`), reconciliation (`GET /api/ledger/reconcile`), and the cryptographic audit trail (`GET /api/audit-logs`, `GET /api/admin/audit-logs/verify`), and **cannot call any write route** (`403 FORBIDDEN`).
2. **KYC Onboarding State Machine & First-Admin Bootstrap:**
   - Self-registered users (`POST /api/auth/register` -> `registerUser()` in `api/src/auth.js`) start in `PENDING_KYC` status with a `0`-paise `PENDING_KYC` checking account. Any attempt to send or receive funds is rejected inside `transfer()` with `403 KYC_PENDING`.
   - Only an authenticated `admin` can transition a user via `POST /api/admin/users/:id/approve` (`/reject`, `/freeze`), which updates the user and account status inside a transaction and writes a hash-chained audit record.
   - Idempotent First-Admin Bootstrap via CLI (`npm run db:bootstrap-admin`) or `POST /api/system/bootstrap` (guarded by `BOOTSTRAP_SECRET`) creates the first `admin` user and verifies the single `system_vault` (`VAULT-0001`) only when zero admins exist (`409 ALREADY_BOOTSTRAPPED` thereafter).
3. **Provable Double-Entry Ledger & Concurrency Safety:**
   - Money is stored in integer minor units (`bigint` paise) — zero floating-point math across DB, API, and UI.
   - Every deposit, withdrawal, and transfer runs through `transfer()` (`api/src/transfer.js`) inside a `BEGIN ISOLATION LEVEL READ COMMITTED ... COMMIT` transaction: checks `idempotency_keys (user_id, key)`, locks both accounts in deterministic ascending UUID order (`SELECT ... FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`) to prevent deadlocks and concurrent overdrafts, inserts two balanced rows into `ledger_entries` (`debit` and `credit`), updates cached balances via the `SECURITY DEFINER` trigger `apply_ledger_entry()`, and verifies `SUM(debit) == SUM(credit)` at commit time via the deferred constraint trigger `check_transaction_balanced()`.
4. **Cryptographic SHA-256 Hash-Chained Audit Trail:**
   - Every security and financial event is recorded in `audit_log` (with view `audit_logs`). Denials and failed attempts are written on the pool outside the rolled-back request transaction so rollbacks never erase evidence of an attack.
   - A PostgreSQL `BEFORE INSERT` trigger (`chain_audit_log()`) acquires a transaction-scoped advisory lock (`pg_advisory_xact_lock(20261110)`), locks the prior row (`ORDER BY id DESC LIMIT 1 FOR UPDATE`), links `previous_hash` (defaulting to `'GENESIS_LEDGERPROOF_2026'`), and computes `entry_hash = encode(sha256(...), 'hex')`.
   - Append-only triggers (`prevent_ledger_mutation`, `prevent_audit_mutation`, `reject_change`) and revoked SQL privileges block `UPDATE`, `DELETE`, and `TRUNCATE` on `transactions`, `ledger_entries`, `idempotency_keys`, and `audit_log`.

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

#### Live & Functional Verification Steps
- **Health & Readiness Probes:**
  - `curl http://localhost:3000/health` -> `200 OK` (`{"status":"ok"}`)
  - `curl http://localhost:3000/ready` -> `200 OK` (`{"status":"healthy","database":"connected","rateLimiter":"ready","rateLimiterBackend":"postgres"}`)
- **Demo Logins:**
  - Admin: `admin@ledgerline.com` (`Admin@123`) | Auditor: `auditor@ledgerline.com` (`Auditor@123`)
  - Holder A: `alice@ledgerline.com` (`Alice@123`) | Holder B: `bob@ledgerline.com` (`Bob@123`)
- **Verify Cryptographic Audit Chain & Double-Entry Invariants:**
  - Log in as `admin@ledgerline.com` or `auditor@ledgerline.com` and use **"Verify audit chain"** (calls `GET /api/admin/audit-logs/verify`) and **"Re-check books"** (calls `GET /api/ledger/reconcile`).
- **End-to-End Smoke Verification Script:**
  ```bash
  npm run verify:live
  ```

---

### Q3. Which AI tools did you use?

- **Claude Code & Google Antigravity:** Used for pair-programming the PostgreSQL trigger logic, designing the concurrency and lock-order tests, building the React verification views, and performing adversarial security reviews (`security-reviewer` / `security-auditor` subagents).
- All dated prompts, AI mistakes, diagnostics, and human corrections are documented with commit links in [`PROMPTS.md`](PROMPTS.md).

---

### Q4. What did the AI get wrong, and what did you fix yourself?

1. **Vercel Serverless Entrypoint Detection (`src/app.js` vs `src/index.js`) & Direct Express Import:**
   - *What AI got wrong:* First (commit `37ed7eb`), AI placed the app factory in `src/app.js` and the serverless export in `src/index.js`. Vercel's zero-config detector ranked `src/app.js` ahead of `src/index.js` and crashed with `FUNCTION_INVOCATION_FAILED`. Second (commit `ffb5aa6`), after renaming `app.js` to `create-app.js`, Vercel's build failed with `No entrypoint found which imports express` because `src/index.js` re-exported the app from `create-app.js` without importing `express` directly.
   - *How I fixed it:* I inspected the Vercel build and runtime logs, renamed the factory to `src/create-app.js`, imported `express` directly in `src/index.js` (`const app = express(); app.use(createApp(...))`), guarded `app.listen()` so it only runs locally outside production/Vercel, and configured `api/vercel.json` to route `/(.*)` to `src/index.js`.

2. **Supabase TLS Root CA Pinning & PgBouncer Transaction Pooler (`6543`) vs Direct Migration (`5432`):**
   - *What AI got wrong:* AI initially connected with a plain `new pg.Pool({ connectionString })` tested only against local Postgres without TLS, and when Supabase rejected unencrypted/unverified connections (`SELF_SIGNED_CERT_IN_CHAIN`), AI proposed `sslmode=no-verify`. Later, AI mixed runtime pooled connections (`:6543`) with multi-statement DDL migrations.
   - *How I fixed it:* I refused `sslmode=no-verify`, pinned Supabase's root CA in `api/src/supabase-ca.js`, stripped URL `sslmode` overrides in `poolConfig()` (`api/src/db-config.js`, commit `67a7f97`), and separated `DATABASE_URL` (runtime `ledgerproof_app` via transaction pooler) from `DIRECT_URL` / `OWNER_DATABASE_URL` (port `5432` schema owner for `npm run db:migrate`). I also ensured `chain_audit_log()` uses transaction-level `pg_advisory_xact_lock(20261110)` rather than session-level `pg_advisory_lock`.

3. **Application-Only Balance Checks, Temp-Table Trigger Shadowing, and PL/pgSQL Trigger Plan Errors:**
   - *What AI got wrong:*
     - Early drafts checked `balance >= 0` only in JavaScript (`transfer()`), leaving the database unprotected against direct SQL overdrafts (fixed in commit `5ddb141`).
     - `check_transaction_balanced()` initially read `ledger_entries` without a pinned `search_path`, allowing a session with `TEMP` privilege to create `pg_temp.ledger_entries` and hide an unbalanced transaction at commit (fixed in commit `1d16c66`).
     - In commit `caa27b1`, AI added `NEW.type IS NOT DISTINCT FROM OLD.type` inside `prevent_ledger_mutation()`, which is shared by both `transactions` and `ledger_entries`. When `UPDATE ledger_entries` fired in `schema.test.js`, PL/pgSQL failed with `record "new" has no field "type"` instead of `ledger_entries is append-only`.
   - *How I fixed it:* I pinned `search_path = public, pg_temp` on every trigger function, revoked balance/history mutation rights from `ledgerproof_app` in `db/roles.sql`, simplified the depth-2 check in `prevent_ledger_mutation()` so it never references table-specific columns on `NEW` (`9cc726b`), and verified all 14 database trigger tests in `schema.test.js`.

4. **Legacy `audit_log` Migration Leaving `NULL` Hashes on Existing Rows:**
   - *What AI got wrong:* In `api/scripts/migrate.js` (`9cc726b`), `UPGRADE_SQL` added `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash text` without backfilling existing legacy rows. On a populated v1 database, existing rows kept `entry_hash = NULL`, causing `verifyAuditChain()` to report `verified: false, tamperedSeq: 1` immediately after migration. Additionally, `verify-live.js` initially fell back to an RBAC check when registration failed on an unmigrated remote DB and counted it as `PASS`.
   - *How I fixed it:* I reproduced the defect on a disposable legacy schema first (`repro-legacy.mjs`), then updated `migrate.js` to lock the tables in `ACCESS EXCLUSIVE MODE` inside a single transaction, backfill `previous_hash` and `entry_hash` in ascending `id` order for confirmed legacy (`NULL`) rows while verifying any existing hashes and failing visibly on inconsistent or out-of-order state, and re-enable `audit_log_append_only` + `SET NOT NULL UNIQUE` before `COMMIT`. I also updated `verify-live.js` so unmigrated checks report `PENDING_MIGRATION` / `SKIPPED` instead of a false `PASS`.

5. **Defects found in a pre-release review of my own AI-written code (2026-11-14), each reproduced before it was fixed:**
   - *Retrying a payment after a lost response paid twice (`94c0951`):* the web form made a new idempotency key for every attempt, so a retry after a network failure could move money again. I reproduced it (balance fell by 2.50 for a 1.25 payment) and the form now keeps the key until the outcome is known.
   - *An admin could activate a pending, rejected or frozen user without KYC approval (`28acf1f`):* freeze, then unfreeze, set the account to active. Unfreeze now refuses an owner who is not active (`403 KYC_PENDING` / `422 ACCOUNT_FROZEN`); the security-reviewer agent then found a second path, which is also closed.
   - *The audit chain reported "tampered" on an untouched log (`d5ad9b1`):* row ids were drawn before the advisory lock, so two concurrent requests could swap places. The id is now drawn under the lock; a test with 30 concurrent audited requests failed 3 of 3 times before and passed 3 of 3 after.
   - *Open input-length defects, fixed in pull request #6, which I have deliberately not merged:* a 9,000-character email was accepted and stored, an oversized account id was copied into the audit log, and a huge `offset` returned 500. See `LAUNCH_AUDIT.md` (items 08 and 17) for what is and is not on production.

---

### Q5. What integrity decisions did you make to guarantee the wrong person cannot move money and that you can prove who moved it?

| Integrity Guarantee | Application Layer Enforcement (`api/src/`) | Database Layer Enforcement (`db/schema.sql` & `db/roles.sql`) |
| :--- | :--- | :--- |
| **Wrong person cannot move money** | `authenticate()` (`api/src/auth.js`) verifies HS256 JWT signature, algorithm pin (`algorithms: ["HS256"]`), `isUuid(sub)`, `isTokenRevoked()` (`revoked_tokens`), and queries `users` on every request for current `role` and `status`. `allowRoles()` restricts `/api/transactions/transfer` and `/withdraw` to `account_holder` and `/deposit` to `admin`. `requireOwnAccount()` verifies `account.owner_id === req.user.id`. | `accounts_guard` makes `owner_id`, `account_type`, and `account_number` immutable and blocks `DELETE`. `ledgerproof_app` cannot `UPDATE users (role)` (`42501`). `assertRestrictedRole()` (`api/src/role-check.js`) refuses to serve on Vercel if the DB role is a superuser, table owner, or can edit balances/roles. |
| **Unapproved (`PENDING_KYC`), rejected, or frozen accounts cannot move or receive money** | `transfer()` (`api/src/transfer.js`) checks both source and destination accounts after `FOR NO KEY UPDATE` lock: `pending_kyc` throws `403 KYC_PENDING`, and `frozen` throws `422 ACCOUNT_FROZEN`. Unfreezing an account whose owner is not active is refused, so freeze then unfreeze cannot be used to skip KYC. | `apply_ledger_entry()` independently inspects `accounts.status` on every inserted ledger entry and raises an exception (`account % is %`) if `lower(account_status) <> 'active'`. |
| **Balances can never go negative or drift from ledger entries** | `lockAccounts()` locks both accounts in ascending UUID order (`ORDER BY id FOR NO KEY UPDATE`) under `READ COMMITTED` isolation and checks `balance_paise >= $2 AS has_funds` in SQL. | `accounts` enforces `CHECK (account_type = 'system_vault' OR balance_paise >= 0)`. `accounts_guard` rejects direct `balance_paise` updates (`pg_trigger_depth() < 2`). `apply_ledger_entry` (`SECURITY DEFINER`) updates `balance_paise` and `running_balance_paise`, and `check_transaction_balanced` (`DEFERRABLE INITIALLY DEFERRED`) rejects the commit if `SUM(debit) <> SUM(credit)`. |
| **Ledger and audit history cannot be rewritten or deleted** | No API route updates or deletes transactions, ledger entries, idempotency keys, or audit logs. | `ledgerproof_app` has `SELECT` and column-level `INSERT` only (cannot choose `id` or `created_at`). `prevent_ledger_mutation`, `prevent_audit_mutation`, and `reject_change` block `UPDATE`, `DELETE`, and `TRUNCATE`. |
| **Cryptographic proof of who moved money and when** | Every transfer, deposit, withdrawal, replay, KYC approval/rejection, freeze, bootstrap, and denied/failed attempt writes an `audit_log` row recording `actor_user_id`, `actor_role`, `action`, `target`, `ip`, `details`, and `outcome`. | `chain_audit_log()` (`SECURITY DEFINER`) acquires `pg_advisory_xact_lock(20261110)`, reads the prior `entry_hash` (`FOR UPDATE`), and computes `NEW.entry_hash = encode(sha256(...), 'hex')`. `GET /api/admin/audit-logs/verify` (`verifyAuditChain()`) recomputes the entire SHA-256 chain from `GENESIS_LEDGERPROOF_2026` to head and reports `tamperedSeq` if altered. *(Note: for legacy rows created before hash columns existed, migration backfill records their state at migration time and proves post-migration continuity, while pre-migration integrity rests on `audit_log_append_only` and restricted role grants.)* |

---

### Q6. Current verification status and remaining production hardening items

#### Current Verification Status
- **122 / 122 Backend Integration Tests Passing (2026-11-14) (`cd api && npm test`):**
  - Every `THREAT` test in `THREATS.md` is verified by `threats.test.js` (1:1 bidirectional check).
  - Covers schema triggers (`schema.test.js`), atomic transfers & lock ordering (`transfer.test.js`), HS256 pin & IDOR (`auth.test.js`), deposits/withdrawals/reconciliation (`money.test.js`), sequential & concurrent idempotency (`idempotency.test.js`), 20x overdraft & 30x opposite-transfer concurrency (`concurrency.test.js`), restricted DB role & temp-table shadowing (`roles.test.js`), pinned Supabase CA (`db-config.test.js`), and KYC onboarding, SHA-256 audit chain tamper detection, PostgreSQL token revocation/rate limiting, PgBouncer lock safety, and legacy audit migration backfill (`onboarding-and-chain.test.js`).
- **47 / 47 Frontend Unit Tests (2026-11-14) & Production Build Passing (`cd web && npm test && npm run build`):**
  - Verifies float-free rupee-to-paise parsing and formatting (`web/src/money.test.js`) and builds the production Vite bundle cleanly.
- **13 / 13 Local Production-Mode Smoke Checks Passing (last run 2026-11-13 on a migrated copy of the production schema; the 13th check is logout then reuse of the token) (`npm run verify:live` against local DB):**
  - Verifies `/health`, `/ready` (`rateLimiterBackend=postgres`), `/api/system/status`, Admin login, `/api/admin/audit-logs/verify` (`verified: true`), RBAC (`ACCOUNT_HOLDER` -> `/api/admin/users` `403`), Registration (`POST /api/auth/register` -> `201 PENDING_KYC`), Onboarding gate (`PENDING_KYC` transfer -> `403 KYC_PENDING`), Onboarding approval (`POST /api/admin/users/:id/approve` -> `200 ACTIVE`), Approved holder transfer & idempotent replay, `/api/ledger/reconcile` (`balanced: true`), and stored `entry_hash` verification across historical and newly appended `audit_log` rows.
- **Live Deployment Verification Status (`https://ledgerproof-api.vercel.app` & `https://ledgerproof-web.vercel.app`), release of 2026-11-14:**
  - **Release:** the released code is `78ed94d60e5b86c3060339bd9787151b81015d6f`; both production aliases serve deployments built from `main`, whose later commits changed documentation only, and the production database has the V2 schema and the corrected `chain_audit_log()`. The 20-point launch matrix, with its evidence and limits, is in [`LAUNCH_AUDIT.md`](LAUNCH_AUDIT.md).
  - **Observed passing on live without signing in (2026-11-14, 10:43 UTC):** `GET /health` `200`; `GET /ready` `200` with `rateLimiterBackend: "postgres"`; the page loads as Balance Vault and reaches `GET /api/system/status` (`200`); an unauthenticated `GET /api/admin/audit-logs/verify` returns `401`; unknown addresses return a real `404`.
  - **Observed earlier on live (2026-11-13, signed in by the owner):** a logout wrote an `audit_log` entry and a `revoked_tokens` row; that the reused token was then refused with `401` is the owner's report of the verifier output.
  - **Read-only SQL on the production database (2026-11-14, 10:44 UTC):** all 205 audit rows recompute correctly (hashes and links), ledger debits equal credits, and balances sum to zero. This is a recomputation in SQL, not the endpoint's answer.
  - **Verified on live by `npm run verify:live` (2026-11-14, run by the owner; captured output of the second run: 14 PASS, 0 FAIL, 0 PENDING_MIGRATION, 0 SKIPPED, exit code 0, finished 11:17:26 UTC):** registration (`PENDING_KYC`, 0 balance), the pending-KYC transfer refused with `KYC_PENDING`, admin approval, a transfer and its same-key replay (one debit, one transaction ID), reconciliation (`balanced: true`, 4,517,920 paise each side), the authenticated `GET /api/admin/audit-logs/verify` (`verified: true`, head `e7b369f578cf` matching audit row 241), and logout followed by `401` on the reused token. The database shows two complete runs (14 audit rows, 2 transfers and 1 new user each); all 233 audit rows verify, and balances are unchanged.
  - **Still not verified on live:** revocation across different server instances (the reused-token `401` may have come from the instance that handled the logout) and a second-device test.

#### Remaining Production Hardening Items & Known Limitations
1. **Cross-instance revocation is verified only locally:** two separate API processes on a test database refuse a token revoked through the other, and on production a logout persists a `revoked_tokens` row and the reused token gets `401`, but that `401` may have been served by the same instance. A second-device test has not been done.
2. **Database Session Timeouts & Endpoint Rate-Limit Coverage:** Rate limiting is active on `/api/auth/login` and `/api/auth/register`; `GET /api/ledger/reconcile` and money routes do not yet enforce per-IP rate limits, and `lock_timeout` / `statement_timeout` are not yet pinned on the `ledgerproof_app` role.
3. **Input-length limits and the favicon are not on production yet:** the fixes (email 254 and password 128 characters, a clamped `offset`, a "B" favicon instead of the old "L") are in open pull request #6, not merged, so `LAUNCH_AUDIT.md` marks items 08 and 17 as FAIL until it is. The first-admin bootstrap route has no length limits (it needs `BOOTSTRAP_SECRET`). Privacy and terms pages exist only as drafts (`PRIVACY.md`, `TERMS.md`) awaiting my approval.
4. **Browser E2E Automation & External Audit Anchoring:** The React UI was verified manually across all roles while all API and money math paths are covered by 122 automated tests; headless browser E2E tests and external KMS anchoring of `headHash` remain future enhancements.
