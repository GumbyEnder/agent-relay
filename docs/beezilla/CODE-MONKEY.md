# Code Monkey's workshop — BeeZilla's coding environment

Status: first version, 2026-11-23. Owner's brief: "create the perfect coding environment
when people click Code Monkey", built for mid-2027 when AI costs about 4× less, and judged
by one principle — the person's satisfaction with their life over the long haul, so every
bit of friction has to pay for itself (docs/beezilla/PRINCIPLES.md).

## What the research said (late 2026, ~3,000 searches, numbers checked at source)

1. **Describe the result, not the plan.** Top engineers give a short brief — what, the
   guardrails, "done when" checks that pass or fail — and review proof afterwards. Boris
   Cherny (Claude Code): plan mode "was useful, and is no longer useful"
   ([HN, 2026-09-25](https://news.ycombinator.com/item?id=49850929)). Planning survives as a
   short conversation about the result when work is big, unclear or irreversible.
2. **Proof is the product.** Done means a check passed. An independent reviewer improves
   accuracy 3.9–9.5 points for 1.00–1.25× the cost ([arXiv 2610.34577](https://arxiv.org/abs/2610.34577)).
3. **Friction only at points of no return.** People approve ~93% of permission prompts
   ([Anthropic](https://www.anthropic.com/research/how-we-contain-claude)); fencing agents in
   cut prompts 84% ([Anthropic](https://www.anthropic.com/research/claude-code-sandboxing)).
4. **Every correction becomes a check** (lint rule, test, type), not a note in a prompt.
5. **Strong judge, cheap workers, spend savings on verification.** The cost of a fixed level
   of AI ability falls ~13× a year ([Epoch AI, 2026-09](https://epoch.ai/publications/the-plunging-price-of-thought)).

The workshop is those five, made into code — adjusted by the owner's decisions below.

## Owner's decisions (2026-11-23)

After weighing the same research and its contradictions, the owner settled these for
BeeZilla's coding agent (the owner's own report is kept, word for word, outside the repo):

- **Built for people who don't code.** They describe the outcome; Code Monkey makes the
  technical decisions and explains only consequential ones in plain words. Questions to
  the person are about what it should do, look like, who it's for — never about code.
- **Every step is reviewed by a model from a different company** than the one that built
  it, with fresh context, against the evidence. If no such reviewer is available, the step
  is reported "not independently reviewed" — never "passed".
- **Verification means the running product**: tests, then the real app used like a person
  would, with screenshots or a short recording. A claim of "done" is not evidence.
- **People see a plain checklist of steps**; the dependency graph stays internal.
- **Original words are kept as typed**; summaries (the result card) point back to them and
  never replace them.
- **Human review never stalls the project**: while one step waits for the owner, the
  independent steps keep going.
- **Launching follows the owner's instructions and history**: the first public launch needs
  their OK unless they asked for it in so many words; once a project has been allowed to go
  live, that becomes its launch policy for later releases. One unrelated past launch is not
  blanket permission.
- Still open, and not to be invented here: approval modes (manual / automatic / reduced
  safeguards), automatic reasoning-effort choice, the skill library, agent counts.

## The new way forward (owner, 2026-11-23)

The owner's write-up "The new way forward" (kept outside the repo with their report) sets
how BeeZilla's agents work. They added two conditions: **look at other projects on
BeeZilla first**, and **restrict how many searches we do based on budget — no bankrupting
people for small projects; get an idea of how much this matters to people, as a budget,
before you go.** In the workshop that means:

- **Start with the why.** The card keeps *why* they want it (`why`) apart from their first
  idea of *what* to make (`making`). Agents optimise for the why; the idea is a starting
  point, not a specification. If the person didn't say why, the model infers it and lists
  it under assumptions instead of asking.
- **Guardrails, not specifications.** `walls` are hard limits that change what's possible:
  time, who may see it, what must never happen. Features and technology are never walls.
  The only questions the owner gets are about the why and the walls.
- **Budget before going** (`src/lib/buzzy/budget.ts`). `start_code_project` requires
  `budgetDollars`, and the server accepts it only if the amount appears in the owner's own
  words: their request, or their answer to the one question *"How much should I spend on
  this, at most? I'll keep my work under that amount."*. Answers are sized to the stakes
  (play $2 / **$5** / $20, product $20 / **$50** / $200, critical $100 / **$200** / $1,000;
  the middle one suggested). One mode (PR #371) asks the same question with the same
  words. A price of the thing being made ("lemonade costs $2.50") is never taken as the
  budget unless the model says it is and the owner said it.
- **The budget sets the effort** (`effortFor`): searches = 20% of the budget ÷ the cost of
  one search (about a cent, including reading it), in ⌈searches ÷ 50⌉ categorically
  different areas (at most 10, at most 1,000 searches each); versions of the first step to
  compare = 20% of the budget ÷ the cost of one quick version (about $3), from 1 to 50. So
  $5 buys 100 searches in 2 areas; $50 buys 1,000 in 10 areas and 3 versions; $500 reaches
  the write-up's full 1,000 searches in each of 10 areas. Unit costs are env settings
  (`BZ_SEARCH_CENTS`, `BZ_VERSION_CENTS`) so the effort grows as prices fall.
- **The budget is a ceiling, enforced by the server, not the prompt.** Every delivery's
  cost is counted once: the agent's own `estimated_usd`, else its tokens at a default price
  (`BZ_CODE_IN_CENTS_PER_MTOK`, `BZ_CODE_OUT_CENTS_PER_MTOK`), else a floor
  (`BZ_CODE_STEP_FLOOR_CENTS`, 50¢) so an agent that reports nothing can't run free. Close
  to the ceiling (money.ts `budgetVerdict`: the last 10%, at least 50¢) and at it, nothing
  new starts — no next step, review, redo or go-ahead — until the owner taps **Add $X
  more** in the workshop. Accepting finished work costs nothing and always goes through.
  Only the owner can raise a budget.
- **Look on BeeZilla first, then the world** (`lookFirst`). Before anything is built, the
  owner's own earlier coding projects (with the links their finished steps delivered) and
  BeeZilla's archive (`search_inspiration`: starting boards, their recipes, documents and
  Library) are searched — free, nothing leaves BeeZilla. Other people's projects are never
  searched; once BeeZilla has a way to share projects openly, shared ones can join. What
  fits goes into every first step's brief, followed by the wider-world search allowance
  and "borrow before you build": reuse what fits, check each license allows it, keep the
  credits, and only make what's missing. Later steps reuse what earlier ones found.
- **Explore by building.** When the budget buys two or more versions, the first step makes
  that many genuinely different quick versions (one of them the owner's own idea), keeps
  the one that best serves the why, says why, and links the rest so the owner can switch.
- **A source of truth outside the AI's own judgment**: tests, the running app, a model from
  another company, and the owner's own "looks right" — already the workshop's review
  policy below.

## How a project starts

A Talk turn that asks for software to be made or changed (`isCodeRequest` in
`src/lib/buzzy/codeMonkey.ts`) is offered one extra tool, `start_code_project`
(`gate: "code"` in `toolRegistry.ts`; withheld in Lockdown because the agents that build
it talk to model providers). A turn that builds a flow on the Idea Board is never Code
Monkey's, even when it names a website, a tracker or an app ("build me a workflow that
checks my website every morning"): the board decides first, with its own rules, and
builds it card by card (the final plan's `orchestrate` step from `planAppActions` in
`pilot.ts`; `isCodeTurn` here). So the two never both act on one turn. Opening the
Orchestrate editor builds nothing and doesn't count. The model fills a **result card**
and **slices**; code then:

- **Settles the stakes** — `play` (you and people close to you), `product` (other people
  use it), `critical` (money, health, sign-in, other people's data, harm if wrong). The
  model proposes; `stakesFloor` can only raise it, never lower it.
- **Refuses checks that can't fail** ("looks professional") and **layer-only slices**
  ("Set up the database"), and checks the `after` links form no circle.
- **Decides each slice's door**: `one-way` when it sends messages to people, moves money,
  publishes, deletes or overwrites data, or changes who can sign in; otherwise `two-way`.
  The model's `oneWayHint` can add caution, never remove it.

- **Settles the budget** from the owner's own words (above); without one, nothing is
  created and the model is told to ask the budget question. The turn that answers it
  ("$5", "the middle one") is offered the tool again, and the owner's words for the
  request run from the message that asked for software to that answer.
- **Looks on BeeZilla first** (`lookFirst`) and hands what fits to the agents.

Then `startCodeProject` (`codeMonkey.server.ts`) creates a BeeZilla job (template `code`),
a Dev Boards board, a builder agent and a reviewer agent, and one mission per slice. Talk
shows a card under the reply that opens the workshop.

## The review policy (`reviewPolicy`)

Every step: independent review by another company's model first.

| | can be undone | can't be undone |
|---|---|---|
| **play** | done once reviewed, with proof | reviewed, then authorized, then the step runs |
| **product** | done once reviewed, with proof | reviewed, then authorized, then the step runs |
| **critical** | reviewed, then the owner looks | reviewed, then authorized, then the step runs |

Stakes show as 1–3 "care bars", never the brain's circle/square/triangle/hexagon shapes.
Proof grows with the stakes: play = tests, a try-it link, screenshots; product adds a short
recording of a person's path through it; critical adds a security check and an undo note.
Delivered without proof → sent back, never Done.

A one-way step is built and tested but its irreversible part is held back until its review
passes. It then runs only with authorization: the owner's own words in the request
(`authorizedByWords` — launching and messaging only; money, deletion, sign-in and data
changes always get their own go-ahead), the project's launch policy, or the owner's
"Go ahead" in the workshop. The step returns to the builder once with "go ahead", and that
delivery completes it.

## Lifecycle of a slice (all moves are idempotent; reading the project moves it along)

`ready` (or `blocked` until every `after` slice is done) → `running` → `review` →
an independent **review mission** (`Review: …`, for a different agent) → `done`, or the
owner's turn. A review delivery is read as `VERDICT PASS` / `VERDICT FAIL` (any `FAIL`
line fails it); a failure comments the findings on the slice and sends it back to Ready.

What the person sees: **Waiting · Working · Needs you · Checking · Done**, each with its
own shape as well as colour. "Needs you" is only ever: a question an agent escalated, or a
slice the policy says the owner must look at.

## The agents

They work missions like any Dev Boards harness (skills/devboards/SKILL.md): poll Ready,
claim, heartbeat, escalate one question, deliver with artifacts.

- Builder `code-monkey-<id>`, harness `BZ_CODE_HARNESS` (default `claude_code`).
- Reviewer `code-review-<id>`, harness `BZ_CODE_REVIEW_HARNESS` (default `codex`).
- Each harness's company comes from `providerOf` (claude_code → anthropic, codex → openai,
  gemini_cli → google…); run-any-model harnesses such as hermes need it named with
  `BZ_CODE_PROVIDER` / `BZ_CODE_REVIEW_PROVIDER`. Only two known, different companies count
  as independent; the project records which it was.

Each mission's brief is written the way top engineers brief a capable coworker
(`missionBrief`): objective with how the owner tries it, context (who it's for, why,
stakes, what it builds on), constraints (not doing, decisions already made, door rule,
"turn repeated fixes into tests or lint checks"), acceptance (each done check + the proof
to attach). No role-play, no capital-letter rules.

## API

`/api/buzzy/code` (`codeMonkey.nitro.ts`, signed in):

- `GET` → the person's coding projects; `GET ?job=<id>` → card, slices, proof, questions.
  **A GET is a read only**: it never releases a slice, opens a review mission, moves a
  mission or counts spend. An open workshop tab polls, and a review mission is spend — a
  GET that advanced the project would make an idle tab cost money.
- `POST {action:"tick", jobId}` — the poll. Moves the project along where its rules allow
  (release the next step, open the independent review, accept per policy, count each
  delivery once) and answers with the same project shape as `GET ?job=`. This is the only
  door to that movement; `readCodeProject` answers GET, `advanceCodeProject` answers ticks.
- `POST {action:"start", card, slices, words, budgetDollars}` — what the Talk tool calls.
- `POST {action:"answer", jobId, callId, text}` — reply to an agent's question.
- `POST {action:"looks-right"|"not-yet", jobId, slice, text?}` — the owner's look ("Go ahead"
  on a one-way step; on a launch it also sets the project's launch policy). Refused with
  `budget_used_up` when it would start paid work past the budget.
- `POST {action:"add-budget", jobId, dollars}` — the owner's top-up ($1 to $100,000); the
  only way a budget grows.

## Screen

`public/buzzy/code-monkey.js` + `.css`, loaded on every page by nav.js. Opens from the Talk
card, a `#code` / `#code=<job>` link, or `BeeZillaCodeMonkey.open(jobId)`. Closes only with
its X or Esc; every card drags to the Idea Board; "Change" on a decision puts a sentence in
the Talk box (Talk stays the one place to talk).

## Tests

- `scripts/test-code-monkey.ts` — the policy (stakes floors, doors, vague checks, slices,
  brief text) and the budget: reading amounts from the owner's words, the question and its
  answers, the effort equation, counting each delivery once, the ceiling's verdicts.
- `scripts/test-code-monkey-flow.ts` — end to end on the real board store (PGlite): release
  order, a review for every step, a question reaching the owner, no proof → sent back, a
  failed then passed review, a one-way door with go-ahead, a launch authorized by the
  owner's own words, a go-ahead becoming the launch policy, "not independently reviewed"
  when no other company is set up, the owner's words kept as typed, privacy between accounts;
  no budget → nothing created, an invented amount refused, prices of the thing being made
  not taken as the budget, an answer recorded as theirs; the ceiling (counted once, review
  held near the limit, redo refused, the owner's top-up resumes it, finished work still
  accepted, the next step held at the limit); looking first finds the owner's earlier
  project with its links and never another person's.
- `scripts/test-code-monkey-get-readonly.ts` — the GET contract, through the real route
  handler: with a delivery waiting on the board, `GET ?job=` twice opens no review mission,
  creates no mission, moves nothing, counts no spend and leaves the next step parked;
  `GET` (list) changes nothing; `POST {action:"tick"}` then opens that review; a stranger's
  GET and tick are 404s.
- `scripts/test-tool-registry.ts` — the `code` gate.

The code-monkey suites are named explicitly in `test:ci` (no `posttest:buzzy-jobs` hook).

## Not done yet

- Clicking Code Monkey in the agents strip (the agents-sidebar PRs) should call
  `BeeZillaCodeMonkey.open()`; a one-line follow-up once both are merged.
- One mode's stakes reading (askOrGo.ts `assessRequest`) isn't handed to the card yet;
  the card still settles its own stakes from the owner's words (`settleStakes`).
- Where the built software runs for the owner to try (preview hosting) is whatever the
  builder harness reports as its try-it link; a BeeZilla-hosted preview is a later step.
- The search allowance is a number in the brief; an outside agent's own searches are only
  counted through the cost its delivery reports, and the ceiling stops it at the next step.
  Counting each search exactly would need agents to search through BeeZilla's own gateway
  (`/api/search`) with a per-project allowance.
- Looking first covers the owner's own work and BeeZilla's starting boards. Other people's
  projects can join once BeeZilla has a way to share a project openly (and its license).
- Since one mode landed (PR #371, 2026-11-25), it asks the budget question first, as tap
  buttons, for work it hands to agents (askOrGo.ts `isCodeWork`, which `isCodeRequest`
  now includes), and Code Monkey reads the tapped amount as the owner's answer. An ask
  only Code Monkey's own words catch ("write a Python script to clean my CSV") still
  gets the question from the model, in words, after `start_code_project` is refused.
- Telling a flow from software is done with words, and the board decides first. An ask
  worded as a flow builds a flow even when it names software ("build me a workflow
  management web app"); asking for the software itself ("build me a web app for
  managing workflows") reaches Code Monkey. Three rounds of sharper word rules in review
  (2026-11-25) each moved other asks to the wrong side, so the board's own rules stay as
  they are; a better split needs the model to judge it, not more patterns.
- A turn BeeZilla answers out loud through the audio model (voice streaming, or Speak
  Replies on a typed turn) gets no tools, so a coding ask or a budget answer on that turn
  doesn't reach the workshop yet; turns answered through the text model do (a spoken Work
  turn with an open draft gate is one). Found in review on 2026-11-25; it was so from the
  start.
- Code Monkey's guide reaches the model as a note after the person's message (server.ts
  `afterNotes`, the place production models obey, measured 2026-11-17). A model that
  refuses a system message there (local Qwen: "system message must be at the beginning";
  some people's own AI keys) fails the whole turn, as with BeeZilla's other notes there.
  Folding those notes into the person's message for such models (as ORCHESTRATE_USER_LINE
  does) would fix all of them at once.
