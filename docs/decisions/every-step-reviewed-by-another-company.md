# Every step is reviewed by another company's model

**Date:** 2026-11-23 · **Status:** decided (owner's product report for the coding agent)

**Decision:** Every AI code review uses a model from a different company than the one that
wrote the code, with fresh context, judging the evidence (tests, the running app, screenshots,
recordings) against the spec — not the builder's claims. Two instances from the same company
don't count. If no independent reviewer is available, the work is reported "not
independently reviewed", never "passed".

**Why:** it reduces correlated mistakes; it is not a substitute for evidence from running the
product (independent review measured +4 to +10 points of accuracy for 0–25% more cost,
arXiv 2610.34577).

**In the code:** `providerOf` / `reviewIsIndependent` and the review missions in
`src/lib/buzzy/codeMonkey*.ts`; `scripts/test-code-monkey-flow.ts` checks the "not
independently reviewed" path.
