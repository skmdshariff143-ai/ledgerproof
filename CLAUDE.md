# LedgerProof — project rules for Claude Code

@AGENTS.md

## Who I am and what this is
Solo submission by Shareef for the Snovasys Fresher Hiring Challenge 2026 (VVIT), problem "LedgerLine".
Deadline: Thu 12 Nov 2026, 6:00 PM IST. Goal: money moves so the books always balance and the same request never pays twice.

## Company rules (non-negotiable — breaking these gets me rejected)
1. Individual work only. Never copy code from other candidates, tutorials, or repositories found online. Write original code.
2. The repository stays PRIVATE until the deadline. Never run any command that changes repo visibility.
3. Never fake history: no force-push, no amend/rebase of pushed commits, no back-dated commits, no squashing history.
4. Never claim a feature works unless its test passes. README/THREATS/docs must describe only code that exists. Unfinished work is listed honestly in README "Status".
5. AI use is allowed and must be visible: every AI-assisted commit carries a Co-Authored-By trailer. Never hide it.
6. Never attack, scan, or send traffic to Snovasys systems or any other candidate's deployment. Attack scripts target ONLY my own deployment URL from env.
7. No harmful content in the repo. No secrets in git (.env is ignored; only .env.example is committed).
8. I must be able to explain and modify every line, especially authorization. Keep code simple and readable; no clever abstractions; explain every integrity decision in DECISIONS.md.

## Required files (graded)
- PROMPTS.md — ≥ 5 dated entries, ≥ 2 about authorization / access control / audit trail. Each: what was asked, what the AI produced, what was wrong, what was done instead, how verified, commit link. Written AS WE GO, never back-filled.
- THREATS.md — every threat mapped to the API defense, DB defense, and the exact test that proves it.
- DECISIONS.md — one short paragraph per integrity decision.
- README.md — live links, demo logins per role, run locally in ≤ 6 commands, tests, honest Status section.

## Grading to optimise for (100)
35 integrity & security of the DEPLOYED system · 15 threat thinking (THREATS.md + tests) · 15 functionality · 15 AI use (PROMPTS.md) · 10 code quality · 10 docs/deploy/demo.
Working integrity beats screen count.

## Git workflow — commit and push every update
After EVERY completed unit of work (one feature, one fix, one doc update):
1. Run `npm test` in /api. If anything fails, fix it first. Never commit red tests (exception: a commit that intentionally adds a failing test before its fix must say "test: failing test for <threat>").
2. Run the `security-reviewer` subagent on the diff if it touches auth, money, idempotency, audit, or SQL.
3. `git add` only the files for this unit (never `git add -A` blindly; check `git status`). Never commit .env, node_modules, or secrets.
4. Commit with a conventional message: `feat|fix|test|docs|chore|ci(scope): what changed` and the trailer:
   Co-Authored-By: Claude <noreply@anthropic.com>
5. `git push origin main` (plain push only).
6. Print the commit SHA and URL https://github.com/skmdshariff143-ai/ledgerproof/commit/<sha> so I can link it in PROMPTS.md.
7. Stop and give me: files changed, integrity decisions + threat each blocks, what I must check by hand.

## PROMPTS.md logging
Whenever I correct you, a subagent catches a real bug in your code, or a test you wrote exposes your own mistake: draft a PROMPTS.md entry with today's date and the commit link, show it to me, and commit it separately as `docs(prompts): <topic>` after I confirm it is accurate. Never invent or stage mistakes.

## Working style
- Do only the step I ask for. Don't add features. Ask when unsure instead of guessing.
- Use context7 for library docs before using any API you're not certain of.
- Prefer small diffs. Raw parameterised SQL with `pg`. Money = integer paise.
