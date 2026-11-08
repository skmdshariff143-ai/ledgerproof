# LedgerProof

@AGENTS.md

Solo Snovasys LedgerLine submission, due Thu 12 Nov 2026, 6:00 PM IST.

## Company rules (non-negotiable)
1. Original individual work only; never copy others' code, tutorials or repos.
2. Repo stays PRIVATE until the deadline; never change visibility.
3. No faked history: no force-push, amending/rebasing pushed commits, back-dating or squashing.
4. A feature works only if its test passes; docs describe only existing code; unfinished work goes in README "Status".
5. AI use is disclosed in README and PROMPTS.md. No Co-Authored-By or "Generated with Claude Code" in commits.
6. Never scan or send traffic to Snovasys or other candidates; attack scripts hit only my own deployment URL (env).
7. No secrets in git (only .env.example); no harmful content.
8. I must explain every line (especially authz): simple code; log integrity decisions in DECISIONS.md.

## Stack
Express + `pg` (raw parameterised SQL, no ORM) in `/api`; React + Vite in `/web`. Money = integer paise. Graded: README (live links, demo logins, honest Status), THREATS, DECISIONS, PROMPTS (≥5 dated entries, ≥2 on authz/audit).

## After each completed unit of work
1. `npm test` in `/api`; fix failures first. Never commit red tests (a deliberate one: "test: failing test for <threat>").
2. Run the `security-reviewer` subagent on the diff if it touches auth, money, idempotency, audit or SQL.
3. `git add` only this unit's files.
4. Commit `feat|fix|test|docs|chore|ci(scope): what changed`, no trailer.
5. Do not push: print `git push origin main` (plain push) for me to run, and wait.
6. Print the commit SHA and https://github.com/skmdshariff143-ai/ledgerproof/commit/<sha>.
7. Tell me: files changed, each integrity decision and the threat it blocks, what to check by hand.

When I correct you or a test exposes your mistake, draft a PROMPTS.md entry, show it, and commit it as `docs(prompts): <topic>` after I confirm. Never invent mistakes.

Do only the step asked; ask when unsure.
