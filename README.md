# LedgerProof

Money movement with a ledger you can prove. Solo submission for the Snovasys Fresher Hiring Challenge 2026, problem "LedgerLine".

## Live

| | Address |
|---|---|
| App | https://ledgerproof-web.vercel.app |
| API | https://ledgerproof-api.vercel.app (for example `GET /api/me` answers 401 without a token) |

Sign in with the demo logins below (the login screen has a one-click button for each). The ledger on the live site is append-only and already contains the activity of the live attack checks (`npm run attack`), so you will see extra transfers and withdrawals that net to zero.

```
Browser app (web/, React + Vite)  ->  API (api/, Express + pg)  ->  PostgreSQL (db/schema.sql)
   role-based screens                    JWT, roles, ownership,        triggers and constraints
   idempotency demo                      idempotent money movement     that enforce the same rules
```

## How the books stay correct

- **Double entry.** Every transaction is a debit row and a credit row of equal amounts in `ledger_entries`. A deferred database trigger rejects any transaction whose debits and credits differ at COMMIT.
- **Integer paise.** Money is `bigint` paise in Postgres and a safe integer in JS. It is sent over HTTP as a string, and the browser app parses and formats it without floats.
- **Money has a source.** Deposits come from the single `SYSTEM_VAULT` account, the only account allowed below zero.
- **The database refuses overdrafts.** `accounts.balance_paise` is kept by a trigger on every ledger insert, and a `CHECK` refuses any user balance below zero. The balance cannot be edited directly.
- **Append-only history.** `ledger_entries`, `transactions`, `idempotency_keys` and `audit_log` reject UPDATE, DELETE and TRUNCATE.
- **No deadlocks between opposite transfers.** A transfer locks both accounts in ascending id order before reading the balance.
- **The same request never pays twice.** Each user's `Idempotency-Key` is a primary key written in the same transaction as the money movement. A retry gets the same 201 answer with an `Idempotent-Replayed: true` header.
- **Authorization.** The JWT carries only the user id. The role is read fresh from the database on every request. Every route names the roles allowed to call it, and account holders can touch only accounts they own. Denied and failed attempts are written to `audit_log` in their own transaction, so a rollback cannot erase them.
- **The books can be re-proved at any time.** `GET /api/ledger/reconcile` recomputes totals and every balance from the ledger rows and reports any difference.

Details: [DECISIONS.md](DECISIONS.md) explains each integrity decision. [THREATS.md](THREATS.md) maps each threat to its defenses and the test that proves it. [PROMPTS.md](PROMPTS.md) records how AI was used and where it was wrong.

## Demo logins

Created by `npm run seed`. They are for demonstration only. The login screen has a one-click button for each.

| Role | Email | Password | Starting balance |
|---|---|---|---|
| Admin | admin@ledgerline.com | Admin@123 | none |
| Account holder | alice@ledgerline.com | Alice@123 | ₹10,000 |
| Account holder | bob@ledgerline.com | Bob@123 | ₹5,000 |
| Auditor | auditor@ledgerline.com | Auditor@123 | none |

## Run locally

Needs Docker and Node.js 22.12 or later.

```
cp .env.example .env          # then put a random value in JWT_SECRET (the file shows how)
docker compose up -d
docker compose exec db createdb -U ledger ledgerproof
cd api && npm install && npm run seed && npm start
cd web && npm install && npm run dev          # in a second terminal
```

The API listens on `http://localhost:3000` and the app on `http://localhost:5173`. The seed creates the schema when the database is empty, and running it twice does not pay the opening deposits twice. There are no migrations yet: after pulling a schema change, recreate the local database (`docker compose exec db dropdb -U ledger ledgerproof`, then `createdb` and `npm run seed` again).

### Settings

| Variable | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | api | App database. Locally, for example `postgres://ledger:ledger@localhost:5432/ledgerproof`. Deployed, it must connect as the restricted role `ledgerproof_app` (the API refuses to serve otherwise). For Supabase, use the Transaction pooler string with user `ledgerproof_app.<project-ref>` and no `sslmode` setting: TLS is verified in code |
| `OWNER_DATABASE_URL` | api seed | Only for `npm run seed` on a deployed database: the schema owner's connection string. Unset falls back to `DATABASE_URL` |
| `TEST_DATABASE_URL` | api tests | Test database. The name must end in `_test`: the tests wipe it |
| `JWT_SECRET` | api | At least 32 random characters. The server refuses to start without it |
| `ALLOWED_ORIGINS` | api | Browser origins allowed to read API answers, comma-separated, exact (no trailing slash). Unset means none. For example `http://localhost:5173,https://your-app.example.com` |
| `PORT` | api | Defaults to 3000 |
| `VITE_API_URL` | web | Where the API runs. Defaults to `http://localhost:3000` |
| `API_URL` | `npm run attack` | The address of your own deployment, for the live attack checks. The script refuses to run without it |

## Deploy (Vercel + Supabase)

The same code runs on Vercel, as two projects from this one repository, with a Supabase database.

1. **Database.** Create a Supabase project. As its owner, run `db/schema.sql` and then `db/roles.sql`. Give the app role a login: `ALTER ROLE ledgerproof_app WITH LOGIN PASSWORD '<a long random password>';`
2. **Demo data.** Load the demo users once as the owner: from `api`, set `OWNER_DATABASE_URL` for that single command and run `npm run seed`.
3. **API project** (root directory `api`). Environment variables: `DATABASE_URL` (see Settings), `JWT_SECRET` (64 hex characters) and `ALLOWED_ORIGINS` (the web app's address). `src/index.js` must be the only entry file Vercel finds, which is why the app itself lives in `src/create-app.js`.
4. **Web project** (root directory `web`). Set `VITE_API_URL` to the API's address, and the same address in `connect-src` of `web/vercel.json`, which also sets the security headers.
5. Turn off Vercel Authentication on both projects, so the public addresses open without a Vercel login.
6. **Check it.** From `api`, run `API_URL=<your API address> npm run attack`. It signs in as the demo users and tries the attacks listed in THREATS.md against the live API: forged tokens, reading someone else's data, a replayed payment, 20 simultaneous withdrawals. It moves a little demo money and puts it back.

Free Supabase projects pause after about a week without use. Open the site shortly before it needs to work.

## The app

- **Account holder:** balance, withdraw, transfer by account number, and a filterable double-entry statement with running balance. Every money form creates a fresh UUID v4 `Idempotency-Key`; tick "Simulate network retry" to send the request twice at once and watch the server pay once.
- **Auditor:** a live banner reading `Total Debits == Total Credits (BALANCED ✓)` from the reconcile endpoint, the append-only ledger, and the filterable audit log with denied attempts highlighted.
- **Admin:** system vault balance, deposits, freeze and unfreeze, create account, and a read-only user list.

Hiding a screen is only convenience; the server enforces every rule.

## API

All routes except login need `Authorization: Bearer <token>`. Money amounts are integer paise.

| Method and path | Roles | Notes |
|---|---|---|
| `POST /api/auth/login` | anyone | `{ email, password }` returns `{ token }` (1 hour) |
| `GET /api/me` | all | current user |
| `GET /api/accounts` | all | account holders see only their own |
| `GET /api/accounts/:id/statement` | all | account holders: own accounts only |
| `POST /api/transactions/transfer` | account holder | `{ fromAccountId, toAccountId or toAccountNumber, amountPaise }`; `Idempotency-Key` header required; source must be yours |
| `POST /api/transactions/deposit` | admin | `{ toAccountId, amountPaise }`; `Idempotency-Key` required; the vault pays |
| `POST /api/transactions/withdraw` | account holder | `{ fromAccountId, amountPaise }`; `Idempotency-Key` required; source must be yours; paid into the vault |
| `GET /api/ledger/reconcile` | admin, auditor | recomputes the books from the ledger: `{ balanced, totals, problems }` |
| `GET /api/ledger/entries` | admin, auditor | latest 200 ledger rows |
| `GET /api/audit-logs` | admin, auditor | latest 200 audit entries |
| `GET /api/users` | admin | id, email and role only |
| `POST /api/accounts` | admin | `{ ownerId }` of an account holder |
| `POST /api/accounts/:id/freeze`, `/unfreeze` | admin | user accounts only |

Errors are `{ "error": { "code", "message" } }`.

## Tests

The API tests run against `TEST_DATABASE_URL` (see Settings), which the tests wipe.

```
cd api && npm test
cd web && npm test && npm run build
```

| File | What it proves |
|---|---|
| `api/test/schema.test.js` | Database guards: balanced entries, append-only tables, no negative user balance, no direct balance edits, one vault, immutable owners |
| `api/test/transfer.test.js` | `transfer()`: overdraft, bad input, idempotency, deadlock-free locking, isolation level |
| `api/test/auth.test.js` | Login, forged tokens, roles, ownership (IDOR), audit rows for denials and failures |
| `api/test/money.test.js` | Deposits, withdrawals, reconciliation (including catching a tampered balance) |
| `api/test/idempotency.test.js` | Per-user keys, exact replay (sequential and concurrent), key reuse conflicts |
| `api/test/concurrency.test.js` | 20 simultaneous withdrawals let exactly 5 succeed; opposite transfers at the same moment do not deadlock |
| `api/test/browser.test.js` | CORS allow-list, user list, ledger explorer, paying by account number |
| `api/test/origins.test.js` | A bad `ALLOWED_ORIGINS` value stops the server |
| `api/test/roles.test.js` | The restricted database role cannot tamper with balances, roles or history; a temp table cannot hide an unbalanced transaction; the API refuses a privileged role; Supabase's REST roles have no access |
| `api/test/proxy.test.js` | A client cannot forge the address recorded in the audit log |
| `api/test/db-config.test.js` | Supabase connections always verify TLS against the pinned root CA, whatever the URL says |
| `api/test/threats.test.js` | Every test named in THREATS.md exists, and every `THREAT` test is listed there |
| `web/src/money.test.js` | Rupee text to paise and back, with no floats |

## How AI was used

This project was built with Claude Code (Anthropic's coding assistant), working from rules in `CLAUDE.md` and `AGENTS.md`. A separate security-review agent audited the diff of each money or authorization change. I read, ran and own the code. [PROMPTS.md](PROMPTS.md) records the specific mistakes the AI made, how they were found, and how each was fixed.

## Status

Built and tested:
- Ledger schema and its database-level guards.
- Deposits, withdrawals and transfers (by id or account number).
- Reconciliation, ledger explorer and audit log.
- Per-user idempotency keys with exact replay.
- Login, role checks, ownership checks and the audit trail.
- The browser app for all three roles, with security headers and a strict Content-Security-Policy.
- The API connects as a restricted database role with verified TLS.
- Deployment on Vercel and Supabase. On 2026-11-09 the 16 live attack checks passed against the deployed API (forged tokens, reading another user's data, a replayed payment, 20 simultaneous withdrawals letting exactly 5 succeed, a balanced reconcile), and the app was checked by hand in a browser as the account holder, auditor and admin.

Not done:
- The live site runs on free tiers: the first request after a quiet period is slow (serverless start), and Supabase pauses a free project after about a week without use.
- The browser app has no end-to-end tests: it was checked by hand in a browser as all four demo users, and only its money helpers have automated tests.
- There is no login rate limit yet.

All known gaps are listed at the end of [THREATS.md](THREATS.md).
