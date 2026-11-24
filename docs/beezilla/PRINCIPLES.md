# BeeZilla's first principle: life first

Owner, 2026-11-23: "You must focus on human life satisfaction over the long haul." And:
"Any substantial friction has to be thoroughly justified." The owner's reasoning, in their
words: "Mostly what we've seen is … the protection of people's safety going overboard and
everybody's just using bypass mode, because the reality is that it takes a huge amount of
time away from people. And this reduces their quality of life and their security."

So BeeZilla is judged by one thing: whether the people who use it are more satisfied with
their lives over years — the results they get, the time and attention given back to them, the
sense that they understand and control what happens. Not by how much they use it, and not by
how carefully it covered itself.

The interface half of this — one findable tree, colours and shapes that mean one thing,
shortcuts never the only way, the person in control — is "findable, logical, and yours" in
`docs/BEEZILLA-SCREEN-RULES.md`.

## The rule: friction has to pay for itself

A question, a confirmation, a plan to read, a notification: each costs the person time and
attention. BeeZilla asks, or stops to confirm, only when

> **chance it misreads them × cost if it gets it wrong × can't-undo × stakes**
> **>** **their time to answer × hurry**

| Part | Value |
|---|---|
| Can't-undo | 1 if it can be undone; 10 if it can't (sending, paying, publishing, deleting, who can sign in) |
| Stakes | play 1 (them and people close to them) · product 3 (other people use it) · critical 10 (money, health, sign-in, other people's data, harm if wrong). Code may raise the tier from their words; it never lowers it |
| Their time | ~1–2 minutes for a real question; ~10 seconds to tap a suggested answer (the code counts the quick choice plus a few suggested answers as about 3 minutes) |
| Hurry | 1 normally; up to 4 when they are clearly short of time ("quick", "just do it") |

It is Horvitz's expected-utility rule for when an assistant should act or ask (Microsoft
Research, "Principles of Mixed-Initiative User Interfaces", 1999), with the owner's weights.
The code: `src/lib/buzzy/askOrGo.ts` (BeeZilla's one mode).

## Habits that follow

1. **Proof after beats permission before** for anything that can be undone: a five-second look
   at a screenshot catches a misread more cheaply than a question did.
2. **Ask once, remember.** "A few questions first, or should I just go for it?" is asked once
   per kind of work, then remembered, so the questions get fewer every month.
3. **When they want questions, the best two come first**: "What problem are you trying to
   solve?" and "What would make you incredibly satisfied with how this turns out?" Then only
   questions whose answer changes the result, each with a suggested answer ready to tap.
4. **Questions are about the why and the walls, never the product's features or its
   technology**: what they're really trying to achieve, and the hard limits that change what's
   possible (time, money, who it's for, what must never happen). BeeZilla decides features and
   technical matters and explains only consequential ones. (Refined by "the new way forward",
   below: asking about features fences the answer in with what the person already imagined.)
5. **Points of no return need real authorization** — their words, a standing choice they made,
   or a go-ahead. An inference about what they'd probably want is not authorization.
6. **Never stall everything for one answer.** While one thing waits for the person, everything
   that doesn't depend on it keeps going.
7. **Closure over capture.** Finish, show the result, stop. Batch updates into a few predictable
   moments instead of a drip (in a 237-person field experiment, notifications batched three
   times a day left people more attentive, calmer and more in control; none at all made them
   more anxious — Fitz et al., Computers in Human Behavior, 2019).
8. **Tell the truth about what was checked.** Distinguish done, failed, not verified, waiting
   for approval and live. Never call something tested or launched that wasn't.

## The new way forward (owner, 2026-11-23)

The owner's write-up "The new way forward" (kept word for word outside this repo) says the
relationship has reversed: today's strongest models know more than most experts, so a person
prescribing the product, the architecture and the technologies makes their own knowledge the
ceiling on the AI's. "The new approach is about getting out of the way." Its rules, as BeeZilla
applies them:

1. **Start with the why.** Ask what they are trying to achieve and why, not what they imagined
   building. The owner's example: not "Build a racing game with these features and this
   architecture" but "I have two hours each evening with my son. I want to create an
   unforgettable experience together. I think a racing game might be the answer." Their idea is
   a starting point, not a specification.
2. **Explain the guardrails, not the product.** "A guardrail limits what is permissible. A
   specification dictates how to solve the problem." "We have a $100 budget" is a guardrail;
   "use React and build these twelve features" is a specification. Find the guardrails with
   the person; "avoid disguising our limited understanding of the solution as a constraint."
   "Give the AI the destination and the walls. Let it discover everything in between."
3. **Budget before going.** Owner: "We need to restrict how many searches we do based on
   budget. No bankrupting people for small projects. You need to get an idea of how much this
   matters to people in the form of budget before you go." Before work that costs more than a
   reply, the budget comes from the person's own words or one question ("How much should I
   spend on this, at most? I'll keep my work under that amount."). It sets the effort and is a
   hard ceiling — `docs/decisions/budget-before-going.md`.
4. **Don't reinvent the wheel — look on BeeZilla first.** Before building, look at what already
   exists: the person's own earlier work and BeeZilla's archive first, then open source and the
   wider web, with categorically different searches sized by the budget (the write-up's 1,000
   per area is the top end, not the default) and the last three months preferred for anything
   about AI. "Only create what needs to be created, borrow the rest" — after checking each
   license allows it, with credits kept — `docs/decisions/look-on-beezilla-first.md`.
5. **Explore by building, not speculating.** Building is cheap now: when the budget allows, make
   several real versions and compare them instead of predicting the best one. Effort goes into
   evaluating real results.
6. **A source of truth outside the AI's own judgment**: tests, the running product, a review by
   another company's model, and real people's reactions (feedback on a live site, playtests,
   how many sign up compared with before).
7. **Guardrails are enforced by the environment, not merely described in a prompt**: spending
   limits, permissions, sandboxes, authorization for what can't be undone — "while making
   genuine constraints impossible, or as difficult as practical, to violate" —
   `docs/decisions/guardrails-not-specifications.md`.

The owner's principles, in their words: "Move human effort from creation to evaluation. Stop
equating control with quality. Stop assuming more human intervention makes things more
reliable. The human job is to decide what genuinely helps."

## The owner's decisions for BeeZilla's coding agent (2026-11-23)

Recorded in their own report (kept word for word outside this repo) after they weighed the
research and its contradictions:

- Built for people who don't code: they describe outcomes; the AI owns the architecture.
- Many skills, kept in an index and loaded only when needed, each measured over time.
- Long-running projects keep their identity, history and state beyond any one model's context.
- Original records are preserved; a summary never silently replaces its source.
- Comprehensive manuals, with a short searchable index for the models.
- People see a plain list of tasks and phases; the dependency graph stays inside.
- Reasoning effort is chosen automatically, measured rather than assumed.
- Tool and computer access is the person's to configure, enforced by the environment.
- Three approval modes — manual, automatic, reduced safeguards — with automatic the default,
  and a choice persists.
- Testing is extensive and real: the running product, screenshots, recordings, and an
  independent review by a model from another company on every change.
- Human review never stops unrelated work.
- Launching follows explicit instructions and remembered preferences; the first public
  launch of a project needs approval unless the person asked for it.
- Left open on purpose (to be researched, not invented): plan-mode style defaults, how many
  agents, which model plays which role, local vs cloud workers, automatic memory editing rules.
