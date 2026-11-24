# Look on BeeZilla first, then the world

**Date:** 2026-11-23 · **Status:** decided

**Owner's words:** "BeeZilla should be looking into other projects on BeeZilla first." From their
write-up "The new way forward": "Don't reinvent the wheel … Search through all previous
conversations and reutilize relevant solutions. Don't be afraid to copy anything we've made in
the past or anything that's open source. Only create what needs to be created, borrow the rest."

**Decision:** Before anything is built:

1. **BeeZilla first** (free; nothing leaves BeeZilla): the person's own earlier projects, with
   what they delivered, and BeeZilla's archive (starting boards, their recipes, documents and
   Library). Other people's private work is never searched; projects people choose to share
   openly can join once sharing exists.
2. **Then the wider world, within the budget**: categorically different searches, de-duplicated,
   sized by [the budget](budget-before-going.md), preferring the last three months for
   anything about AI.
3. **Borrow before building**: reuse what fits, after checking its license allows it, and keep
   the credits. Only make what's missing. Later steps reuse what earlier ones found.

**In the code:** `lookFirst` in `src/lib/buzzy/codeMonkey.server.ts`, `search_inspiration`
(`src/lib/buzzy/inspirationSearch.ts`), the brief's "Look first" in `src/lib/buzzy/codeMonkey.ts`.
Guarded by `scripts/test-code-monkey-flow.ts` (finds the person's earlier project, never
another person's).

**For agents working on this repo** the same rule reads: look at this repo, its open pull
requests, `docs/decisions/` and our earlier work before writing anything new.
