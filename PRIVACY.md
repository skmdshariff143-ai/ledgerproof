# Privacy notice (DRAFT, not approved)

Status: draft written for a hiring-challenge demo. It has not been reviewed by a lawyer and is not
published on the site. The owner must review it, name a contact, and decide the open points at the
end before it is linked from the app.

Balance Vault is a demonstration ledger. It moves no real money. Do not enter real personal or
financial information.

## What the app stores

| Data | Where | Why |
|---|---|---|
| Email address | `users` table | Sign-in identity |
| Password, as a salted scrypt hash (never the password itself) | `users` table | Sign-in |
| Role and account status | `users`, `accounts` tables | Access control and KYC state |
| Demo account numbers, balances, transactions and ledger entries | `accounts`, `transactions`, `ledger_entries` tables | The ledger itself |
| Idempotency keys and a hash of each request | `idempotency_keys` table | Safe retries |
| Audit trail: who did what, when, the target, the outcome and the caller's IP address | `audit_log` table | Tamper-evident record |
| Identifier and expiry of logged-out sign-in tokens | `revoked_tokens` table | Making logout effective |
| Request counters keyed by IP address | `rate_limit_buckets` table | Rate limiting |
| Sign-in token | The browser's `sessionStorage`, cleared when the tab closes | Keeping you signed in |

The app sets no cookies and loads no analytics, advertising or third-party scripts.

## Who processes it

- Vercel hosts the web page and the API and keeps its own request logs.
- Supabase hosts the PostgreSQL database (region `ap-south-1`).

## Retention and deletion

The ledger and the audit trail are append-only by design: the application cannot edit or delete
those rows. There is no self-service deletion. Expired rate-limit and revoked-token rows are
overwritten or removed as part of normal operation.

## Open points for the owner

- Contact address for privacy requests.
- Whether and when demo data, including IP addresses in `audit_log`, is deleted (for example by
  dropping the demo database after the evaluation).
- Which law applies and whether a formal notice is required for a demo with no real users.
