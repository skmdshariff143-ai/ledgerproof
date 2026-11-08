# AGENTS.md

Shared rules for any AI coding agent working in this repo. Project rules live in CLAUDE.md.

- Backend lives in `/api` (Node.js). Run tests with `npm test` in `/api`.
- Database access: raw parameterised SQL with `pg`. Never build SQL by string concatenation.
- Money is stored as integer paise. Never use floats for money.
- Keep code simple and readable. The owner must be able to explain every line.
- No secrets in git. Only `.env.example` is committed.
- Docs describe only code that exists and is tested.
