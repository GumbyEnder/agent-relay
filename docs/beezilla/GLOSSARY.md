# BeeZilla glossary

One meaning per word, in code, docs, UI and agent prompts. When a word below has an "avoid"
list, don't use those words for it. Add a term here in the same pull request that introduces it.

## The two products

| Term | Means | Avoid |
|---|---|---|
| **Dev Boards** | The agent-first kanban console (app.devboards.ai). The code and API still say "project" for a board | "Agent Relay" in UI copy (it is the repo's name) |
| **BeeZilla** | The consumer app under `/buzzy` (beezilla.net) | "Buzzy" in UI copy (it is the code's name) |
| **surface** | Which product a process serves: `all`, `buzzy` or `console` (`BZ_SURFACE`) | |

## Dev Boards

| Term | Means | Avoid |
|---|---|---|
| **board** | A Dev Boards kanban (`board_…`, `ar_projects`) | "project" in UI copy |
| **mission** | A card on a board that an agent claims and delivers (`msn_…`): objective, context, constraints, acceptance, artifacts | "task", "ticket" for this |
| **column** | Where a mission is: inbox, ready, running, needs_human, review, done, blocked | "status", "lane" |
| **lane** | A board's enforced workflow rules for moves between columns | "column" |
| **call** | One sharp question an agent escalates to a person; a mission waits in needs_human until it is answered | "chat", "thread" |
| **harness** | The tool an agent runs in (`claude_code`, `codex`, `hermes`, `cursor`…) | "model" (a harness runs a model) |
| **verbs** | The five things an agent does: poll, claim, heartbeat, escalate, deliver | |
| **`ark_` key** | An agent's API key, bound to a board | "token" |

## BeeZilla

| Term | Means | Avoid |
|---|---|---|
| **Talk** | The header of every `/buzzy` page: the face, Talk to BeeZilla, the search bar, the places row | "chat bar", "chat page" |
| **Idea Board** | Where BeeZilla's work is drawn as it happens; anything can be dragged onto it | "whiteboard", "canvas" (old names) |
| **places row** | Inspiration, History, Library, Memory, Experts, Recipes, Sketch, Music studio, What BeeZilla can do, Download, Honey, Publish | "menu", "nav" in UI copy |
| **job** | A piece of work BeeZilla keeps (`buzzy_jobs`): a conversation's project, a document, a coding project | "task" |
| **Library** | Where finished work lives, every version kept | "Work tab" |
| **recipe** | A saved, re-runnable chain of steps made on the Idea Board | "workflow", "template" in UI copy |
| **Honey Drops** | BeeZilla's credits; the place where they live is called **Honey** | "credits", "tokens" in UI copy |
| **modes** | Open (green), Advocate (yellow), Lockdown (red): what may leave BeeZilla and be shared | "privacy setting" alone |
| **Zilla agents** | The helpers down the left: BeeZilla, the Zillas the person adds, Code Monkey | "bots" in UI copy |
| **colony** | Zillas dragged together into a named, purposeful group | "team", "folder" |
| **Hive** | The row above BeeZilla where agents ask BeeZilla (and each other) for help | |
| **brain** | The one tree everything lives in: `brain/knowledge`, `brain/systems`, `brain/assets` | "drive", "files" |
| **budget** | The most a piece of work may cost, set by the person's own words or their answer to "How much should I spend on this, at most?"; it sizes the effort and is a hard ceiling | "quota", "limit" (those are the plan's) |
| **look first** | Searching what already exists — the person's earlier work and BeeZilla's archive, then the wider world — before building anything | "research phase" |

## Code Monkey's workshop (coding projects)

| Term | Means | Avoid |
|---|---|---|
| **Code Monkey** | BeeZilla's coding agent; its colour is #B8591F | |
| **workshop** | The panel that shows one coding project: result card, steps, proof | "IDE", "console" |
| **result card** | Why they want it, who it's for, what changes for them, done-when checks, limits, not doing, decisions made for them — a summary that points back to the person's own words | "spec", "PRD" in UI copy |
| **why** | What the person is really trying to achieve; agents optimise for it. Their idea of what to make is a starting point, not a specification | "requirements" |
| **walls** (code) / **limits** (UI) | Hard limits that change what's possible: time, money, who may see it, what must never happen. Never features or technology | "constraints" for features; "spec" |
| **versions** | Several genuinely different quick builds of a first step, compared before settling on one; how many depends on the budget | "variants", "mockups" |
| **step** (UI) / **slice** (code) | One thin, end-to-end piece the person can try, built as one mission | "phase", "ticket" |
| **done-when check** | A line someone can answer yes or no to | "acceptance criterion" in UI copy |
| **stakes** | play · product · critical — how much care and proof the work needs | "priority" |
| **one-way door** | A step that can't be undone: sending, paying, publishing, deleting, sign-in, reshaping data | "dangerous" |
| **proof** | What a person can look at: try-it link, screenshots, recordings, test results, the review | "logs" |
| **independent review** | A review by a model from a different company than the builder, with fresh context | "second pass" by the same model |
| **launch policy** | A project's standing permission to go public, with where it came from | |

## Process

| Term | Means |
|---|---|
| **CR ticket** | An owner-approved change request that GumbyEnder builds as a `CR-n` pull request |
| **owner** | The person who decides BeeZilla's direction; their words are quoted exactly in docs and decisions |
