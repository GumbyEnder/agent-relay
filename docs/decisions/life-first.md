# Life first: friction has to pay for itself

**Date:** 2026-11-23 · **Status:** decided

**Owner's words:** "You must focus on human life satisfaction over the long haul." "Any
substantial friction has to be thoroughly justified." "Mostly what we've seen is … the
protection of people's safety going overboard and everybody's just using bypass mode, because
the reality is that it takes a huge amount of time away from people."

**Decision:** BeeZilla is judged by people's long-term satisfaction with their lives, not by
engagement. A question, confirmation, plan or notification is shown only when its expected
benefit beats the person's time — the rule and weights in `docs/beezilla/PRINCIPLES.md`.

**In the code:** the ask-or-go rule (`src/lib/buzzy/askOrGo.ts`, unit-tested); one-way doors
in Code Monkey's workshop (`src/lib/buzzy/codeMonkey.ts`).
