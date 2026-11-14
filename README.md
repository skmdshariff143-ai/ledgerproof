# Balance Vault

Money movement with a ledger you can prove. Solo submission for the **Snovasys Fresher Hiring Challenge 2026 — VVIT**.

**Naming:** the product's display name is Balance Vault. Earlier names still appear in technical identifiers and are kept on purpose: `ledgerproof` (the repository, the live URLs, the Vercel projects, the database role and package names) and LedgerLine (the demo email domain and the challenge's name for the project).

## Live

| Service | Address |
|---|---|
| Web App | https://ledgerproof-web.vercel.app |
| Backend API | https://ledgerproof-api.vercel.app (for example `GET /health` returns 200; `GET /api/me` returns 401 without a token) |

Sign in with the demo logins below (the login screen has a one-click button for each), or register a new `PENDING_KYC` account and approve it from the Admin console. The ledger on the live site is append-only and already contains the activity of the live attack checks (`npm run attack`), so you will see extra transfers and withdrawals that net to zero.

```
Browser app (web/, React + Vite)  ->  API (api/, Express + pg)  ->  PostgreSQL (db/schema.sql + db/roles.sql)
   role-based views, KYC banner          JWT (HS256), fresh DB RBAC,    append-only triggers, row locks,
   idempotency retry simulator           atomic double-entry transfers  SHA-256 hash-chained audit trail
```

## Architecture & Security Model (How the Books Stay Correct)

- **Double-entry ledger math.** Every money movement (`deposit`, `transfer`, `withdrawal`) writes two balanced rows into `ledger_entries`: one `debit` and one `credit` of equal `amount_paise` (`SUM(DEBIT) == SUM(CREDIT)`). A deferred PostgreSQL constraint trigger (`ledger_entries_balanced`) rejects any transaction whose debits and credits differ at `COMMIT`.
- **Integer minor units (paise).** Money is stored as `bigint` paise in PostgreSQL (`amount_paise` / `balance_paise`) and sent over HTTP as strings. The browser parses and formats rupees with string math and `BigInt` (`web/src/money.js`)—never IEEE-754 floats.
- **No naked balance updates.** `accounts.balance_paise` is updated exclusively by the `SECURITY DEFINER` database trigger `apply_ledger_entry()` on `ledger_entries` insert. The `accounts_guard` trigger rejects any direct `UPDATE accounts SET balance_paise = ...` (enforcing `pg_trigger_depth() >= 2`) and enforces `CHECK (balance_paise >= 0)` on all user accounts. Only the single `SYSTEM_VAULT` treasury account may go below zero.
- **Deterministic row-level locking & concurrency safety.** Every transfer executes inside a single atomic `BEGIN ISOLATION LEVEL READ COMMITTED ... COMMIT` transaction and locks both accounts in ascending UUID order (`SELECT ... FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`). Opposite-direction concurrent transfers (`A -> B` and `B -> A`) queue on the lower ID instead of deadlocking, and 20 simultaneous withdrawals never overdraw an account.
- **Idempotency per user.** Each money request requires an `Idempotency-Key` header. The key and SHA-256 request hash (`user_id`, `from`, `to`, `amount`) are stored in `idempotency_keys` inside the same SQL transaction as the ledger entries. Retrying the same transfer returns the original `201` response with `Idempotent-Replayed: true` and debits the sender only once; reusing a key with different parameters returns `409 IDEMPOTENCY_CONFLICT`.
- **Server-enforced RBAC & KYC onboarding state machine.** The JWT (`HS256`) carries only the `sub` user ID. On every request, `authenticate()` queries the user's current `role` (`admin`, `auditor`, `account_holder`) and `status` from PostgreSQL. Self-registered users (`POST /api/auth/register`) start in `PENDING_KYC` status with `0` balance and receive `403 Forbidden` (`KYC_PENDING`) if they attempt to send or receive money until an Admin calls `POST /api/admin/users/:id/approve`.
- **Append-only triggers & restricted DB role.** `ledger_entries`, `transactions`, `idempotency_keys`, and `audit_log` have `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers (`prevent_ledger_mutation`, `prevent_audit_mutation`, `reject_change`) that raise an exception on any mutation attempt. In production, the API connects as `ledgerproof_app` (`db/roles.sql`), which has no `UPDATE`, `DELETE`, or `TRUNCATE` privileges on history or balances.
- **Cryptographic SHA-256 hash-chained audit trail.** Every row in `audit_log` (including denied and failed attempts committed outside rolled-back transactions) is cryptographically linked to its predecessor by `chain_audit_log()`:
  `entry_hash = SHA256(previous_hash + '|' + seq + '|' + actor_id + '|' + actor_role + '|' + action + '|' + target_id + '|' + canonicalJson(metadata) + '|' + created_at_iso)` starting from `GENESIS_LEDGERPROOF_2026`. Calling `GET /api/admin/audit-logs/verify` recomputes every hash from Genesis to head and pinpoints the exact `tamperedSeq` if any record was altered.
- **Books reconciliation.** `GET /api/ledger/reconcile` runs in a `REPEATABLE READ READ ONLY` snapshot, recomputes every account balance from `ledger_entries`, and flags any mismatch.

Details: [DECISIONS.md](DECISIONS.md) explains each integrity decision. [THREATS.md](THREATS.md) maps each threat to its defenses and the test that proves it. [PROMPTS.md](PROMPTS.md) records how AI was used and where it was wrong. [SNOVASYS_SUBMISSION.md](SNOVASYS_SUBMISSION.md) contains the complete submission questionnaire responses.

## Demo Logins

Created by `npm run seed`. The login screen includes one-click evaluator buttons for each:

| Role | Email | Password | Starting Balance |
|---|---|---|---|
| Admin | `admin@ledgerline.com` | `Admin@123` | none (manages `SYSTEM_VAULT` & KYC) |
| Account holder | `alice@ledgerline.com` | `Alice@123` | ₹10,000.00 (`1000000` paise) |
| Account holder | `bob@ledgerline.com` | `Bob@123` | ₹5,000.00 (`500000` paise) |
| Auditor | `auditor@ledgerline.com` | `Auditor@123` | none (read-only ledger & audit verifier) |

## Run Locally (5-Minute Stranger Setup)

Requires Node.js 22.12+ and PostgreSQL 16+ (or Docker).

```bash
# 1. Configure environment variables
cp .env.example .env
# Set JWT_SECRET (at least 32 chars) and BOOTSTRAP_SECRET in .env:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Start PostgreSQL via Docker Compose and create the app database
docker compose up -d
docker compose exec db createdb -U ledger ledgerproof

# 3. Install dependencies, run migrations/seed, bootstrap admin, and run the test suite
# (All scripts work from both the repository root and inside api/ or web/)
npm install
npm run db:migrate
npm run db:bootstrap-admin
npm run db:seed
npm test
npm run build
npm run verify:live

# 4. Start the API and React + Vite frontend in two terminals
cd api && npm run dev
cd web && npm run dev
```

The API listens on `http://localhost:3000` and the web app on `http://localhost:5173`.

### Environment Variables (`.env.example` & `web/.env.example`)

| Variable | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | `api` | Runtime app database connection. Locally: `postgres://ledger:ledger@localhost:5432/ledgerproof`. On Supabase/Vercel: use the Transaction Pooler URL on port `6543` (`?pgbouncer=true`) with user `ledgerproof_app.<project-ref>`. Verified TLS is enforced in code via `api/src/supabase-ca.js`. |
| `DIRECT_URL` | `api` scripts | Direct PostgreSQL connection on port `5432` for DDL migrations (`npm run db:migrate`), `npm run db:bootstrap-admin`, and `npm run seed`. Falls back to `OWNER_DATABASE_URL` or `DATABASE_URL`. |
| `OWNER_DATABASE_URL` | `api` seed | Schema owner connection string for `npm run seed` on a deployed database. |
| `TEST_DATABASE_URL` | `api` tests | Test database URL. Must end in `_test` (`postgres://ledger:ledger@localhost:5432/ledgerproof_test`) because the test suite wipes and rebuilds it on each test. |
| `JWT_SECRET` | `api` | Secret for HS256 JWT signing (minimum 32 characters). The server refuses to start without it. |
| `BOOTSTRAP_SECRET` | `api` | Secret guarding `POST /api/system/bootstrap` for First-Admin initialization when zero admins exist. |
| `ALLOWED_ORIGINS` | `api` | Comma-separated exact browser origins allowed by CORS (e.g. `http://localhost:5173,https://ledgerproof-web.vercel.app`). |
| `PORT` | `api` | Local HTTP port (defaults to `3000`). |
| `VITE_API_URL` | `web` | Base URL of the backend API (defaults to `http://localhost:3000`). |
| `API_URL` | `npm run attack` | Target URL of your own deployment for live adversarial checks. |

## Deploy (Vercel + Supabase)

1. **Database (`db/schema.sql` & `db/roles.sql`).** Create a Supabase project. Using the Direct connection (`DIRECT_URL` on port `5432` as `postgres`), run `npm run db:migrate` (or execute `db/schema.sql` followed by `db/roles.sql`) and set a password for the restricted app role:
   ```sql
   ALTER ROLE ledgerproof_app WITH LOGIN PASSWORD '<strong-random-password>';
   ```
2. **Bootstrap & Demo Data.** Run `DIRECT_URL=<owner-direct-url> npm run seed` (or `npm run db:bootstrap-admin` for a clean production instance with only the first admin and `SYSTEM_VAULT`).
3. **API Project on Vercel** (Root Directory: `api`).
   - `api/vercel.json` routes all requests (`/(.*)`) to `src/index.js` using `@vercel/node`.
   - `src/index.js` exports the Express `app` for Vercel serverless execution and only invokes `app.listen()` when `process.env.NODE_ENV !== 'production'`.
   - Set environment variables: `DATABASE_URL` (Supabase Transaction Pooler on port `6543` as `ledgerproof_app.<project-ref>`), `DIRECT_URL` (port `5432`), `JWT_SECRET` (64 hex chars), `BOOTSTRAP_SECRET`, and `ALLOWED_ORIGINS` (`https://ledgerproof-web.vercel.app,http://localhost:5173`).
4. **Web Project on Vercel** (Root Directory: `web`).
   - Set `VITE_API_URL` to your deployed API URL (`https://ledgerproof-api.vercel.app`) and match `connect-src` in `web/vercel.json`.
5. **Verify Live Deployment.** Run `API_URL=https://ledgerproof-api.vercel.app npm run attack` from `api/` to execute all 16 live adversarial checks.

## API Reference

All routes except `/health`, `/ready`, `/api/auth/login`, `/api/auth/register`, `/api/system/status`, and `/api/system/bootstrap` require `Authorization: Bearer <token>`. Money amounts are integer paise.

| Method & Path | Roles | Description |
|---|---|---|
| `GET /health` | public | Process liveness probe (`200 OK`) |
| `GET /ready` | public | Readiness probe (`SELECT 1` DB check + rate-limiter status; `200` or `503`) |
| `POST /api/auth/login` | public | `{ email, password }` -> `{ token }` (1h HS256 JWT) |
| `POST /api/auth/register` | public | `{ email, password }` -> registers `account_holder` with `PENDING_KYC` status and ₹0 balance |
| `GET /api/system/status` | public | Returns `{ initialized, adminCount }` |
| `POST /api/system/bootstrap` | public (secret) | Guarded by `BOOTSTRAP_SECRET`; creates first `admin` & verifies `SYSTEM_VAULT` if 0 admins exist |
| `GET /api/me` | all | Current user profile & status |
| `GET /api/accounts` | all | Account holders see only their own accounts; Admin/Auditor see all |
| `GET /api/accounts/:id/statement` | all | Double-entry statement (`debit`/`credit` rows + `running_balance_paise`); ownership enforced |
| `POST /api/transactions/transfer` | `account_holder` | `{ fromAccountId, toAccountId \| toAccountNumber, amountPaise }` + `Idempotency-Key` header |
| `POST /api/transactions/deposit` | `admin` | `{ toAccountId, amountPaise }` + `Idempotency-Key` header; debits `SYSTEM_VAULT`, credits user |
| `POST /api/transactions/withdraw` | `account_holder` | `{ fromAccountId, amountPaise }` + `Idempotency-Key` header; debits user, credits `SYSTEM_VAULT` |
| `GET /api/ledger/reconcile` | `admin`, `auditor` | Recomputes all balances from `ledger_entries` in a `REPEATABLE READ` snapshot |
| `GET /api/ledger/entries` | `admin`, `auditor` | Latest 200 double-entry rows |
| `GET /api/audit-logs` | `admin`, `auditor` | Filterable hash-chained security audit trail (also mounted at `GET /api/admin/audit-logs`) |
| `GET /api/admin/audit-logs/verify` | `admin`, `auditor` | Recomputes every SHA-256 hash from `GENESIS_LEDGERPROOF_2026` to tip (`{ verified, totalEntries, headHash }`) |
| `GET /api/users` / `GET /api/admin/users` | `admin` | Lists users with role and KYC status (never selects `password_hash`) |
| `POST /api/admin/users/:id/approve` | `admin` | Transitions user & account from `PENDING_KYC` to `ACTIVE` and records signed audit log |
| `POST /api/admin/users/:id/reject` | `admin` | Rejects onboarding (`REJECTED` / `FROZEN`) and records signed audit log |
| `POST /api/admin/users/:id/freeze` | `admin` | Freezes user & account and records signed audit log |
| `POST /api/accounts` | `admin` | Opens a new checking account for an `account_holder` |
| `POST /api/accounts/:id/freeze`, `/unfreeze` | `admin` | Freezes or unfreezes a user checking account |

## Automated Verification Suite

Run the full backend and frontend test suites:

```bash
cd api && npm test
cd web && npm test && npm run build
```

| Test File | What It Proves |
|---|---|
| `api/test/schema.test.js` | Database triggers & constraints: balanced entries, append-only tables (`prevent_ledger_mutation`, `prevent_audit_mutation`), no negative user balances, no direct balance edits, single vault, immutable owners |
| `api/test/transfer.test.js` | `transfer()` atomicity: overdraft rollback, input validation, idempotency, ascending ID lock ordering (`THREAT lock order`), `READ COMMITTED` isolation |
| `api/test/auth.test.js` | JWT HS256 pinning, fresh DB role lookup, IDOR blocking on statements and transfers, out-of-transaction denial auditing |
| `api/test/onboarding-and-chain.test.js` | `/health` & `/ready` probes, `/api/admin/*` RBAC (`403`), `PENDING_KYC` money movement blocking (`403`), zero orphan rows on overdraft (`422`), SHA-256 audit hash-chain verification & tamper detection, First-Admin bootstrap guard |
| `api/test/money.test.js` | Admin deposits, user withdrawals, and full ledger reconciliation catching superuser balance tampering |
| `api/test/idempotency.test.js` | Per-user `Idempotency-Key` isolation, sequential & 5x concurrent replay (`Idempotent-Replayed: true`), `409` on payload mismatch |
| `api/test/concurrency.test.js` | 20 simultaneous withdrawals of ₹1,000 from ₹5,000 let exactly 5 succeed; 30 opposite transfers (`Alice <-> Bob`) complete with zero deadlocks |
| `api/test/roles.test.js` | Restricted DB role (`ledgerproof_app`) cannot tamper with balances, roles, or history, shadow tables with `pg_temp`, or run with superuser privileges |
| `api/test/db-config.test.js` | Verified TLS with pinned Supabase Root CA (`api/src/supabase-ca.js`) and rejection of `sslmode=no-verify` |
| `api/test/threats.test.js` | Verifies every threat in `THREATS.md` maps to a real test and every `THREAT` test is documented |
| `web/src/money.test.js` | 32 unit tests proving float-free rupee-to-paise parsing and formatting |

## How AI Was Used

This project was built with Claude Code and Antigravity working under the rules in `CLAUDE.md` and `AGENTS.md`. A separate security-review agent audited diffs touching money, authorization, idempotency, and SQL. I read, ran, verified, and own every line of code. [PROMPTS.md](PROMPTS.md) and [SNOVASYS_SUBMISSION.md](SNOVASYS_SUBMISSION.md) document the specific mistakes the AI made, how they were caught in logs and tests, and how each was fixed.

## Status

Built and verified:
- Provable double-entry ledger schema with database-enforced invariants (`db/schema.sql`, `db/roles.sql`).
- Atomic deposits, withdrawals, and P2P transfers (by UUID or account number) with ascending-ID row locking.
- KYC onboarding workflow (`PENDING_KYC` -> `ACTIVE`), First-Admin bootstrap, and server-enforced RBAC.
- Cryptographic SHA-256 hash-chained audit trail with live tamper verification (`GET /api/admin/audit-logs/verify`) and full ledger reconciliation (`GET /api/ledger/reconcile`).
- Per-user idempotency keys with sequential and concurrent replay protection.
- **PostgreSQL token revocation & rate limiting (`revoked_tokens`, `rate_limit_buckets`), verified locally, logout observed once in production.** Against the local test database, `POST /api/auth/logout` stores the token's `jti` in `revoked_tokens` and a reused token gets `401`; auth endpoints are rate limited through `rate_limit_buckets`. Revocation fails closed: if `revoked_tokens` is missing or not granted, authenticated requests and logout fail with `500` instead of accepting a possibly revoked token. **Production (2026-11-13, API deployment `9c02861aa772ae108d27a0fe07eb9aafde7bd375`):** after the V2 migration, one logout was observed in the production database as an `audit_log` `logout` entry with outcome `success` and a persisted `revoked_tokens` row written by `ledgerproof_app`. That the same token was then refused with `401` is the owner's report of the `verify:live` output, not an observation from the database. That single `401` may have been served by the instance that handled the logout, so it does not independently test revocation across different server instances. Locally, `cross-instance-revocation.test.js` starts two separate API processes on the test database, logs in through one, logs out through the other, and the first refuses the token; the in-memory cache only ever stores tokens already known to be revoked, so it cannot accept one. Cross-instance revocation has not been observed in production.
- **PgBouncer Transaction-Pooler safety (`:6543?pgbouncer=true`).** `chain_audit_log()` uses transaction-scoped `pg_advisory_xact_lock` (never session-level `pg_advisory_lock`) and all session settings use `SET LOCAL` inside `BEGIN ... COMMIT`, leaving zero dangling locks on pooled connections.
- **React + Vite verification dashboard** for Account Holders, Auditors, and Admins, with strict CSP headers.
- **122/122 backend tests** and **47/47 frontend unit tests** passing against a disposable local PostgreSQL database (2026-11-14); earlier, **12/12 local `npm run verify:live` checks**.
- **Live deployment status (`https://ledgerproof-web.vercel.app` & `https://ledgerproof-api.vercel.app`), release of 2026-11-14:** PR #2 and PR #3 were merged with normal merge commits; `main` is `78ed94d60e5b86c3060339bd9787151b81015d6f`. Both production aliases serve deployments built from it (web `dpl_6z35RRLmk5N6JhBFTnqfoqQod6pq`, API `dpl_G1uDWQwqRoLz2rbE5T5WmHBpbvJJ`); the deployments from the first merge (`d4a7a4e`) are not active. **Observed on 2026-11-14 at 10:43 UTC, not signed in:** `GET /health` 200; `GET /ready` 200 with `rateLimiterBackend: "postgres"`; the production page, opened in a browser, loads as Balance Vault and its request to `GET /api/system/status` returns 200 with no console error (the API's CORS answer allows only the production origin); `GET /api/admin/audit-logs/verify` without a token returns 401; `robots.txt`, `sitemap.xml`, `favicon.svg` and `og.png` return 200 and an unknown address returns a real 404 with the Balance Vault page. **Read-only SQL on the production database at 10:44 UTC:** all 205 `audit_log` rows recomputed correctly (hashes and links), ledger debits equal credits (4,515,920 paise), account balances sum to zero, and `chain_audit_log()` is the corrected version. **Not verified on production after this release:** everything that needs a sign-in, namely registration, the pending-KYC transfer refusal, approval, a transfer and its same-key replay, the reconciliation endpoint, the authenticated `GET /api/admin/audit-logs/verify` answer, and logout with the reused-token refusal. The AI that prepared the release does not enter passwords on a production site, so these were left for the owner to run with `npm run verify:live`. Earlier, on 2026-11-13, one logout was observed in production (see above); the SQL recompute above is not the endpoint's answer; and cross-instance revocation has not been observed on production.
- **Vercel previews never call the production API.** Only a Vercel production build (or a local build aimed at a local API) gets an API URL; preview builds have sign-in and money actions turned off and show a banner saying so. There is no isolated preview backend.

- **Launch-audit additions, deployed with the release of 2026-11-14:** page title, description, canonical and Open Graph text with a 1200x630 share image (`og.png`, made for this page, text only); an SVG favicon; `robots.txt` and a one-URL sitemap; a standalone `404.html`; immutable caching for hashed `/assets` files; redesigned sign-in, account-holder, admin and auditor screens, checked in a browser at 320, 360, 390, 768, 1024, 1440 and 1920 px with no sideways scrolling; draft `PRIVACY.md` and `TERMS.md`, neither approved nor linked from the app.
- **Vercel settings change (2026-11-13, dashboard only):** two Supabase integration connections were removed from the `ledgerproof-web` project, because the web app reads none of their variables and their provisioning step had timed out three preview deployments. The databases and the API project were not changed. The web project's only variable is now `VITE_API_URL`.

- **Two defects found in the final release review, fixed and deployed with the release of 2026-11-14:** (1) retrying a payment whose response was lost used a new idempotency key, so the retry could pay twice; with the response dropped in a browser the balance fell by 2.50 for one intended 1.25 payment, and the form now reuses the key and says the result is unknown; (2) an admin could activate the account of a pending, rejected or frozen user, without approval, by freezing and then unfreezing the account; both routes now refuse it. Each has a failing-first test; see THREATS.md and DECISIONS.md.

Known gaps & remaining production hardening items (also listed in [THREATS.md](THREATS.md)):
- The live site runs on free tiers (Vercel serverless cold starts + Supabase free project pause after inactivity), and the additive V2 schema migration (`users.status`, `audit_log.entry_hash` backfill, `revoked_tokens`, `rate_limit_buckets`) is applied by the database owner via `DIRECT_URL=... npm run db:migrate`.
- Initializing `entry_hash` values for legacy `audit_log` rows during migration records their state at migration time and proves post-migration continuity; pre-migration integrity rests on the restricted `ledgerproof_app` role grants and the `audit_log_append_only` trigger.
- **Audit-chain race, fixed (production function replaced 2026-11-13 UTC).** Two audit rows written at the same moment could be chained out of id order, which made `GET /api/admin/audit-logs/verify` report an untouched log as tampered. `chain_audit_log()` now takes the row id under its lock (see DECISIONS.md). On production only that one function was replaced, with a single `CREATE OR REPLACE FUNCTION` run by the database owner. Afterwards all 205 `audit_log` rows recomputed correctly (hashes and links), the trigger, function owner and privileges were unchanged, and a synthetic insert in a transaction that was rolled back linked to the previous tip and hashed correctly. That test used two sequence values, so ids now skip 206 and 207. The race itself was reproduced locally, not on production, and the endpoint's authenticated answer on production has still not been observed. How to restore the previous function and check the result is in [RECOVERY.md](RECOVERY.md).
- No automated browser end-to-end (Playwright/Cypress) test suite is committed; the UI was checked by hand in a browser (all roles, seven widths, failure, empty and lost-response cases) and the API and money paths are covered by 122 automated tests.
- **Cleanup pending a separate decision:** one synthetic `kyc.verify.*` user and its account, created by an earlier `verify:live` run, and the schema `backup_20261113_pre_v2` (a pre-migration copy of the six tables) remain in the production database.
- Rate limiting is enforced on `/api/auth/login` and `/api/auth/register`; `GET /api/ledger/reconcile` and money routes do not yet enforce per-IP rate limits, and `lock_timeout` / `statement_timeout` are not yet pinned on database sessions.
