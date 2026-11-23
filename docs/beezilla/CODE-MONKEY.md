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

The workshop is those five, made into code.

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

| | can be undone | can't be undone |
|---|---|---|
| **play** | done when proof is attached | independent review, then the owner says go |
| **product** | independent review, then done | independent review, then the owner says go |
| **critical** | independent review, then the owner looks | independent review, then the owner says go |

A one-way slice is built and tested but its irreversible step is held back; "Go ahead"
returns it to the builder once, and that delivery completes it.

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
- Reviewer `code-review-<id>`, harness `BZ_CODE_REVIEW_HARNESS` (default `codex`) — a
  different provider from the builder, which is what makes the review independent.

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
- `POST {action:"looks-right"|"not-yet", jobId, slice, text?}` — the owner's look.

## Screen

`public/buzzy/code-monkey.js` + `.css`, loaded on every page by nav.js. Opens from the Talk
card, a `#code` / `#code=<job>` link, or `BeeZillaCodeMonkey.open(jobId)`. Closes only with
its X or Esc; every card drags to the Idea Board; "Change" on a decision puts a sentence in
the Talk box (Talk stays the one place to talk).

## Tests

- `scripts/test-code-monkey.ts` — the policy (stakes floors, doors, vague checks, slices,
  brief text).
- `scripts/test-code-monkey-flow.ts` — end to end on the real board store (PGlite): play
  auto-accept and release order, a question reaching the owner, a failed then passed
  independent review, a one-way door with go-ahead, and privacy between accounts.
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
