# Budget before going

**Date:** 2026-11-23 · **Status:** decided

**Owner's words:** "We need to restrict how many searches we do based on budget. No bankrupting
people for small projects. You need to get an idea of how much this matters to people in the
form of budget before you go." From their write-up "The new way forward": "'We have a $100
budget' is a guardrail."

**Decision:** Before BeeZilla starts work that costs more than an ordinary reply (today: Code
Monkey projects), it settles a budget, and the budget does three things:

1. **It comes only from the person.** Their own words ("keep it under $5", "$20 max") or their
   answer to one question, the same words everywhere: *"How much should I spend on this, at
   most? I'll keep my work under that amount."* The answers are sized to the stakes, the middle
   one suggested: play $2 / $5 / $20, product $20 / $50 / $200, critical $100 / $200 / $1,000.
   It is the one question that is asked even when they say "just go": money spent can't be
   taken back. A model can't invent a budget, and a price of the thing being made ("lemonade
   costs $2.50") is never taken as one.
2. **It sets the effort.** searches = 20% of the budget ÷ the cost of one search, in up to 10
   categorically different areas; versions to compare = 20% of the budget ÷ the cost of one
   quick version, from 1 to 50. $5 buys about 100 searches; $500 reaches the write-up's 1,000
   searches in each of 10 areas.
3. **It is a ceiling, enforced by the server.** Each delivery's cost is counted once (its own
   estimate, else its tokens, else a small floor so nothing runs free). Near and at the ceiling
   nothing new starts until the person taps "Add $X more"; finished work is still accepted.
   Only the person can raise it.

**In the code:** `src/lib/buzzy/budget.ts` (question, reading amounts, the effort equation,
counting), `src/lib/buzzy/codeMonkey.server.ts` (refuses to start without it, holds new work at
the ceiling), `src/lib/buzzy/money.ts` (`budgetVerdict`), one mode's question
(`src/lib/buzzy/oneMode.ts`). Guarded by `scripts/test-code-monkey.ts` and
`scripts/test-code-monkey-flow.ts`.

**Supersedes:** nothing. Refines [one mode](one-mode.md): the budget question is the one that
survives "just go".
