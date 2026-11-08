# LedgerProof

Money movement with a ledger you can prove. Solo submission for the Snovasys Fresher Hiring Challenge 2026, problem "LedgerLine".

## How the books stay correct

- **Double entry.** Every transaction is a debit row and a credit row of equal amounts in `ledger_entries`. A deferred database trigger rejects any transaction whose debits and credits differ at COMMIT.
- **Integer paise.** Money is `bigint` paise in Postgres and a safe integer in JS. It is sent over HTTP as a string.
- **Money has a source.** Deposits come from the single `SYSTEM_VAULT` account, the only account allowed below zero.
- **The database refuses overdrafts.** `accounts.balance_paise` is kept by a trigger on every ledger insert, and a `CHECK` refuses any user balance below zero. The balance cannot be edited directly.
- **Append-only history.** `ledger_entries`, `transactions`, `idempotency_keys` and `audit_log` reject UPDATE, DELETE and TRUNCATE.
- **No deadlocks between opposite transfers.** A transfer locks both accounts in ascending id order before reading the balance.
- **The same request never pays twice.** The idempotency key is a primary key written in the same transaction as the money movement.
- **Authorization.** The JWT carries only the user id. The role is read fresh from the database on every request. Every route names the roles allowed to call it, and account holders can touch only accounts they own. Denied and failed attempts are written to `audit_log` in their own transaction, so a rollback cannot erase them.

Details: [DECISIONS.md](DECISIONS.md) explains each integrity decision. [THREATS.md](THREATS.md) maps each threat to its defenses and the test that proves it. [PROMPTS.md](PROMPTS.md) records how AI was used and where it was wrong.

## Demo logins

Created by `npm run seed`. They are for demonstration only.

| Role | Email | Password | Starting balance |
|---|---|---|---|
| Admin | admin@ledgerline.com | Admin@123 | none |
| Account holder | alice@ledgerline.com | Alice@123 | ₹10,000 |
| Account holder | bob@ledgerline.com | Bob@123 | ₹5,000 |
| Auditor | auditor@ledgerline.com | Auditor@123 | none |

## Run locally

Needs Docker and Node.js 22 or later. Copy `.env.example` to `.env` and set `JWT_SECRET` first.

```
docker compose up -d
docker compose exec db createdb -U ledger ledgerproof
cd api
npm install
npm run seed
npm start
```

The API listens on `http://localhost:3000`. The seed creates the schema when the database is empty. Running it twice does not pay the opening deposits twice.

## API

All routes except login need `Authorization: Bearer <token>`.

| Method and path | Roles | Notes |
|---|---|---|
| `POST /api/auth/login` | anyone | `{ email, password }` returns `{ token }` (1 hour) |
| `GET /api/me` | all | current user |
| `GET /api/accounts` | all | account holders see only their own |
| `GET /api/accounts/:id/statement` | all | account holders: own accounts only |
| `POST /api/transactions/transfer` | account holder | `{ fromAccountId, toAccountId, amountPaise }`; `Idempotency-Key` header required; source must be yours |
| `POST /api/transactions/deposit` | admin | `{ toAccountId, amountPaise }`; `Idempotency-Key` required; the vault pays |
| `POST /api/transactions/withdraw` | account holder | `{ fromAccountId, amountPaise }`; `Idempotency-Key` required; source must be yours; paid into the vault |
| `GET /api/ledger/reconcile` | admin, auditor | recomputes the books from the ledger: `{ balanced, totals, problems }` |
| `POST /api/accounts` | admin | `{ ownerId }` of an account holder |
| `POST /api/accounts/:id/freeze`, `/unfreeze` | admin | user accounts only |
| `GET /api/audit-logs` | admin, auditor | latest 200 entries |

Errors are `{ "error": { "code", "message" } }`.

## Tests

The tests run against `TEST_DATABASE_URL`, which must name a `*_test` database because the tests wipe it.

```
cd api
npm test
```

## Status

Built and tested:
- Ledger schema and its database-level guards.
- Deposits, withdrawals and transfers between accounts.
- The reconciliation endpoint.
- Login, role checks, ownership checks and the audit trail.

Not built yet:
- Per-user idempotency keys.
- The frontend.
- Deployment.

Known gaps are listed at the end of [THREATS.md](THREATS.md).
