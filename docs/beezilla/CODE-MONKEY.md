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

## How a project starts

A Talk turn that asks for software to be made or changed (`isCodeRequest` in
`src/lib/buzzy/codeMonkey.ts`) is offered one extra tool, `start_code_project`
(`gate: "code"` in `toolRegistry.ts`; withheld in Lockdown because the agents that build
it talk to model providers). The model fills a **result card** and **slices**; code then:

- **Settles the stakes** — `play` (you and people close to you), `product` (other people
  use it), `critical` (money, health, sign-in, other people's data, harm if wrong). The
  model proposes; `stakesFloor` can only raise it, never lower it.
- **Refuses checks that can't fail** ("looks professional") and **layer-only slices**
  ("Set up the database"), and checks the `after` links form no circle.
- **Decides each slice's door**: `one-way` when it sends messages to people, moves money,
  publishes, deletes or overwrites data, or changes who can sign in; otherwise `two-way`.
  The model's `oneWayHint` can add caution, never remove it.

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
- `POST {action:"start", card, slices}` — what the Talk tool calls.
- `POST {action:"answer", jobId, callId, text}` — reply to an agent's question.
- `POST {action:"looks-right"|"not-yet", jobId, slice, text?}` — the owner's look ("Go ahead"
  on a one-way step; on a launch it also sets the project's launch policy).

## Screen

`public/buzzy/code-monkey.js` + `.css`, loaded on every page by nav.js. Opens from the Talk
card, a `#code` / `#code=<job>` link, or `BeeZillaCodeMonkey.open(jobId)`. Closes only with
its X or Esc; every card drags to the Idea Board; "Change" on a decision puts a sentence in
the Talk box (Talk stays the one place to talk).

## Tests

- `scripts/test-code-monkey.ts` — the policy (stakes floors, doors, vague checks, slices,
  brief text).
- `scripts/test-code-monkey-flow.ts` — end to end on the real board store (PGlite): release
  order, a review for every step, a question reaching the owner, no proof → sent back, a
  failed then passed review, a one-way door with go-ahead, a launch authorized by the
  owner's own words, a go-ahead becoming the launch policy, "not independently reviewed"
  when no other company is set up, the owner's words kept as typed, privacy between accounts.
- `scripts/test-tool-registry.ts` — the `code` gate.

Both new scripts run in CI through the `posttest:buzzy-jobs` hook.

## Not done yet

- Clicking Code Monkey in the agents strip (the agents-sidebar PRs) should call
  `BeeZillaCodeMonkey.open()`; a one-line follow-up once both are merged.
- The ask-or-go rule (when to ask before starting) is BeeZilla-wide and lives with the
  one-mode change; the workshop takes the stakes tier as input and will use that rule
  once both land.
- Where the built software runs for the owner to try (preview hosting) is whatever the
  builder harness reports as its try-it link; a BeeZilla-hosted preview is a later step.
