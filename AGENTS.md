# AGENTS.md — read this first

For every AI working in this repo (Claude Code, Codex, Hermes, Cursor…). It holds only what
you can't see in the code, plus where the full manuals are. Read the manual a line points to
before you work in that area.

## What this repo is

Two products, one repo, one Postgres: **Dev Boards** (the agent-first kanban console,
app.devboards.ai) and **BeeZilla** (the consumer app under `/buzzy`, beezilla.net). Which job a
process has is `BZ_SURFACE` — `docs/BUZZY-SERVICE-SPLIT.md`. BeeZilla writes into the console
only through allowlisted imports (`npm run test:boundary`).

## First principles (BeeZilla)

- **Life first.** BeeZilla is judged by the person's satisfaction with their life over years,
  not their attention today; every question, approval or plan it shows must pay for itself.
  The rule and its numbers: `docs/beezilla/PRINCIPLES.md`.
- **Findable, logical, and theirs.** One tree with an address for everything, colours and
  shapes that mean one thing everywhere, shortcuts never the only way: `docs/BEEZILLA-SCREEN-RULES.md`.
- **Words mean one thing.** Use the terms in `docs/beezilla/GLOSSARY.md`; add new ones there.
- **Settled decisions stay settled.** `docs/decisions/` records them with the owner's words.
  Don't re-argue one; write a new decision that supersedes it.
- **The new way forward** (owner, 2026-11-23): start from why, not the solution; ask only about
  the why and hard limits, never features or technology; settle a budget before any work that
  costs more than a reply, size the effort to it and stop at it; look on BeeZilla first, then
  the world, and borrow before building; explore by building versions when the budget allows;
  enforce limits in code. `docs/beezilla/PRINCIPLES.md` and three decisions in `docs/decisions/`.

## How a change lands

1. Branch from the latest `upstream/main` (GumbyEnder/agent-relay), in your own git worktree —
   other sessions use the main checkout. Pushes go to the fork (`origin`).
2. A push is refused if your branch carries an upstream commit that edits `.github/workflows`
   that the fork lacks: base on that commit's parent instead (`docs/beezilla/LOCAL-TESTING.md`).
3. Every change is a pull request to GumbyEnder/agent-relay `main`; CODEOWNERS means GumbyEnder
   approves and merges. "Pushed" is not "live": Railway deploys `main`.
4. GumbyEnder builds from owner-approved **CR tickets** (`CR-n` PRs) and closes overlapping PRs.
   Before changing a `/buzzy` page, check `gh pr list --repo GumbyEnder/agent-relay --state all --search CR-`.
   Don't stack a PR on an unmerged one unless you must, and say so in the body.
5. PR bodies: itemized, before/after, the gates you ran.

## Gates to run before a PR

`npm run typecheck`, `NODE_ENV=production npm run build`, `npm run test:boundary`, the test
scripts for what you touched (`scripts/test-*.ts|mjs`, run with `npx tsx` or `node`), and a
real-browser probe for screen changes (`scripts/probe-*.mjs`). The full `npm run test:ci` takes
about 15 minutes after a build. New tests join CI through an npm lifecycle hook on a script
already in the chain — never reuse a hook another open PR uses (list in the testing manual).

## Testing BeeZilla signed in

`npm run dev` does not serve `/buzzy` pages; only a production build does, with PGlite's files
copied next to the bundle, a trusted origin and the dev magic-link inbox. Full recipe, the
stand-in model, the windowless browser and every known trap: `docs/beezilla/LOCAL-TESTING.md`.

## How to work here

- **Look first, borrow before building.** Before writing anything new, search this repo, its open
  pull requests (`gh pr list --repo GumbyEnder/agent-relay --state all --search …`),
  `docs/decisions/` and our earlier work, then open source. Reuse what fits (check the license,
  keep the credit) and only build what's missing.
- **Start from the why.** Know what the owner is trying to achieve before choosing how; their
  first idea is a starting point, not a specification.
- **Proof, not claims.** "Done" means a check passed: tests, plus the real app used the way a
  person would, with screenshots for anything on screen. Say what you did not verify.
- **Every correction becomes a check; every limit is enforced.** When the owner corrects
  something, add a guard test or lint rule that fails loudly (e.g.
  `scripts/test-no-outside-close.mjs`), not a note in a prompt. A limit that matters (a budget, a
  permission, a point of no return) is enforced by code, never only described to a model.
- **Reviews come from another company's model**, with fresh context, against the evidence
  (owner's decision 2026-11-23 — `docs/decisions/every-step-reviewed-by-another-company.md`).
- **Keep original words.** Quote the owner exactly in docs and decisions; a summary points to
  its source and never replaces it.
- **Secrets stay out.** Never read or print `.env*` files or keys (`.claude/settings.json` denies
  it); production credentials never go into an agent's context.
- **Don't stop the whole project for one question.** If one thing needs the owner, keep doing
  everything that doesn't depend on it.

## Manuals

| Area | Read |
|---|---|
| BeeZilla capability layers, the tool registry, gates | `docs/BEEZILLA-CAPABILITIES.md` |
| Screen rules and the design philosophy | `docs/BEEZILLA-SCREEN-RULES.md` |
| Life first, the friction rule, owner's harness decisions | `docs/beezilla/PRINCIPLES.md` |
| Code Monkey's workshop (coding projects) | `docs/beezilla/CODE-MONKEY.md` |
| Local signed-in testing, probes, CI hooks | `docs/beezilla/LOCAL-TESTING.md` |
| Words | `docs/beezilla/GLOSSARY.md` |
| Decisions | `docs/decisions/README.md` |
| Agent protocol (Dev Boards) | `docs/PROTOCOL.md`, `docs/HARNESS_SKILLS.md`, `skills/devboards/SKILL.md` |
| Product vision (Dev Boards) | `docs/PRODUCT_VISION.md` |
