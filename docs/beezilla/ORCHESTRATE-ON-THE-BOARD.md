# Orchestrate on the Idea Board, by talking

Owner, 2026-11-24:

> "There's a new orchestrate mode on Beezilla. The problem is it's skinned in white mode where everything else is dark mode. Skin it to the skin of everything else… we can actually just use it on the normal whiteboard and tell the AI what we want to orchestrate, and it can put the pieces together live in front of us… It's going to need to look at the board, say what's where, what would logically need to be placed where for this to make sense from a visual perspective, and then to actually do it technically as well… The key thing is you should just be able to talk to Beezilla, and that should be all you need to do to make an orchestration."

## What a person does

- On Talk, with or without the Idea Board open, say or type: *"Orchestrate a weekly newsletter: find this week's news, write it, I approve it, then email it every Monday."* (also: "build me a workflow that…", "set up an automation for…", "make an agent team that…", "draw a flowchart of…"). Things to make stay what they were: "generate a sales pipeline report", "create a process document", "set up a data pipeline in Python", "make the beat loop".
- The board opens if it was folded. A bar at the top says what BeeZilla sees and where it is putting things ("The board is empty, so I'm laying it out left to right…"), with **Stop**.
- Cards arrive one at a time, each joined to the one before it, and the view follows them. When it is done the new cards are selected and the whole build is framed.
- Change it the same way: *"add a spelling check before my approval"*, *"make the writing repeat until it's under 300 words"*, *"make the research run in parallel"*, *"replace the email step with a Slack message"*. These change phrases only count when the board the turn carries already has a flow (`boardHasFlow`). A card put between two others takes its place and what follows slides right.
- *"Open it in Orchestrate"* (or the selection bar's **Open in Orchestrate**) opens the flow in the Orchestrate editor: validator, Mermaid, JSON, YAML, run sheet, Save, versions. The editor's **Put on the Idea Board** does the reverse, card by card.
- **Ctrl/⌘+Z** takes back a whole build in one step (and ends a build still going). Folding the board away ends it too; another command while it builds ("zoom out") doesn't.

## The cards

A flow on the board uses the CR-3 node types (`src/lib/buzzy/orchestration.ts`). The board's own kinds stay what they were: a **skill** is an agent step and an **end result** (a document card with no file) is the end. The rest are new card kinds with their own edge colour, the same colour as in the Orchestrate editor:

| Board kind | Card label | CR-3 type |
|---|---|---|
| `start` | Start | start |
| `skill` | Skill | agent |
| `tool` | Tool | tool |
| `decision` | Decision | decision |
| `parallel` | At the same time | parallel |
| `loop` | Repeat | loop |
| `approval` | Approval | approval |
| `trigger` | When | trigger |
| `subflow` | Orchestration | subflow |
| `document` (no file) | End result | end |
| `note` | Note | note |

A line can say something (`label`, kept by `whiteboards.ts`): "yes"/"no" out of a decision, "approved"/"rejected" out of an approval, "repeat"/"done" out of a loop and "again" back into it. A line that says something is its own line one way, so "again" can go back into a loop that already leads to the step (plain lines stay one per pair, as before). A line that goes back runs under the cards.

A round trip through the Orchestrate editor loses nothing: a card's `orch` keeps its node id (bindings like `$n_research.findings` name it), its settings and declared output, and on the first card the orchestration's params, policy and description; a line keeps its ports (`fp`, `tp`) and condition (`cond`), so an approval line labelled "publish" stays on the port it was on.

## How the build works

1. **Look.** The board describes itself (`describeBoard`): one line per card with a short id (`c1`…), its kind, its words, its place and size, whether it is in view (and which way it is if not), the lines with what they say, which area holds what, the selection, and where there is room. About 30 tokens a card; a big board lists the nearest 80 and counts the rest. No screenshot: the words are cheaper and exact (the CanvasObs study below found structured observation is what makes an agent pick the right object).
2. **Say.** `POST /api/buzzy/board-orchestrate` (`boardOrchestrator.ts`) sends the rules, the board and the person's words to the chat model. Its first line is `say …`: what it sees and where the pieces go. The board shows it while it builds.
3. **Do.** Then one command per line: `add n1 step "Write the draft" | detail`, `link n1 n2 "yes"`, `unlink`, `edit`, `remove`, `done`. The server streams each line as soon as it is complete and checks it first: known ids only, the eleven types only, at most 24 cards; `edit` of a card already on the board only when the person's words asked for a change, and `remove` only when they asked to remove or replace something. The model never writes a coordinate. Stop ends the read of the model's answer.
4. **Place.** The page places each card (`placeInFlow`): after what leads into it, a branch's second answer under its first, a join level with the middle of what it joins, past the end of a loop after its "done". If its place is taken by what comes after it, those cards slide right (`makeRoom`). Line words that don't fit their ends are dropped (`tidyLineLabel`), and when a card was put between two joined cards the old direct line goes. The page refuses to change or remove anything but flow cards.

The turn's chat reply is one sentence ("Building it on your Idea Board now"), and the turn puts none of its usual process cards (Memory, Your board) on the board, so nothing lands in the middle of the build. A build is metered like a chat turn (one `inference` unit) and uses the person's own AI key when they saved one.

Cards BeeZilla builds are not marked as the person's own (`user`): the board text a turn carries (`compile()`) lists the flow last, as "the plan they had laid out here; follow it when they ask you to run it", not among their own instructions. A card's words came from the model, and card words on the board are data it may have read, so they must not become orders word for word. A card the person edits becomes theirs, as before.

## Why this way (research, 2026-11-24, 404 searches)

- **Slashspace Orchestrator mode** (the "/space" the owner named): "Give a chat a goal and it builds the canvas for you… the canvas is the answer: it adds and connects nodes, renames them and rewrites notes, then replies in a sentence or two." Each change is one undo step. Its view does not move; ours follows the build, as asked ("live in front of us").
- **tldraw agent starter kit** (MIT template): shapes in view in a simple format, clusters for what is out of view, "round numbers before sending them to the model". tldraw's own write-up: the agent needs "a spatial harness". We send words only, no screenshot.
- **CanvasObs** (arXiv 2610.27176): structured observation raised correct-target from 16.5% to 48.3%, but "correct placement remains a distinct bottleneck" — hence the model names *what* and *how it connects*, and code decides *where*.
- **Next AI Draw.io** (Apache-2.0): changes stream onto the canvas, the changed shapes are highlighted, one Ctrl+Z takes back an AI change; "small models tend to produce broken diagrams" when asked for long strict XML — hence a small line language that survives a broken line.
- **Flowise Agentflow generator** (Apache-2.0, archived 2026-08), **Sim copilot** (Apache-2.0), **n8n AI Workflow Builder** (fair-code): they generate whole JSON workflows with positions; we keep positions out of the model's hands.

## Testing

- `npx tsx scripts/test-board-orchestrate.ts` (in `test:ci` through `posttest:wallet`): the words that start a build, the line language, a streamed build, the board map, placement, board ⇄ spec against the CR-3 validator, and what the account keeps.
- `node scripts/probe-board-orchestrate.mjs <origin>` drives a real browser: build, change, open in Orchestrate, put back. It needs a server with a chat model. Locally, any OpenAI-style endpoint works; with Ollama's thinking models put a small proxy in front that adds `"reasoning_effort": "none"` and start the server with `BZ_CHAT_BASE_URL=http://127.0.0.1:<proxy>/v1 BZ_CHAT_KEY=local-test BZ_CHAT_MODEL=<model> BZ_EXTRACT_MODEL=<model>`.

Not verified: how fast and how well the deployment's own chat model does it (tested with a local 27B model, about 3–4 s a card after the model loads).
