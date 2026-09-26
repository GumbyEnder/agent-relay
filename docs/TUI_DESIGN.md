---
status: design-accepted-draft
date: 2026-08-05
mission: msn_x9c2xihkmbnq
board: DevBoard APP (board_i80oou4gp0ri)
authors: Frodo (coordinator) + coder-b70 / Qwen3.6-35B-A3B (local dual-B70)
repo: https://github.com/GumbyEnder/agent-relay
---

# Dev Boards TUI — Design Spec (v0)

**Pairing outcome:** Local Qwen reviewed product/protocol context and proposed a dense agent-first TUI. Frodo reconciled that with the live agent-relay codebase (five-verb API, app-shell views, keyboard-ops, ark_ vs operator auth). This doc is the implementation north star for MVP.

> Note: When this work started, DevBoard APP inbox had no pre-existing TUI card (only reviewer-move + OAuth needs_human). Mission **msn_x9c2xihkmbnq** was filed + claimed to track this design.

---

## A. Product understanding

1. Dev Boards is a **mission kanban for agents**, not a general PM suite.
2. Agents operate via **poll → claim → heartbeat → escalate → deliver** over HTTPS (`ark_` keys).
3. Humans triage Inbox→Ready, answer **Calls**, accept **Review**, mint keys — primarily in the web UI today.
4. Columns are the process: `inbox | ready | running | needs_human | review | done | blocked`.
5. Claim is **atomic** (409 if taken); history/journal is sacred.
6. Browser UI already has Board / Live / Calls / Agents / Protocol / Analytics / Journal + keyboard chords.
7. TUI must be a **thin client of the same store** — no parallel protocol or shadow board.
8. Many “operator” verbs (`move`, `calls/reply`, unrestricted create) are **session-gated**; TUI must not fake them for `ark_` keys.
9. Ingest (`POST /ingest/github`) is the reliable agent-key **create → inbox** path.
10. Success: an operator on SSH/Hermes can run the board loop without opening a browser for the 80% path.

---

## B. Personas & modes

| Mode | Who | Goal | Auth |
|------|-----|------|------|
| **Agent-runner** | Hermes/coder agent at keyboard or pane | Batch Ready → claim → work notes → deliver/escalate | `ark_` + `DEVBOARDS_AGENT` |
| **Operator** | Human | Triage, Calls reply, move columns, review scan | Prefer operator session **or** elevated key; degrade gracefully if only `ark_` |
| **Observer** | Human/agent | Column counts, stale map, live-ish feed | `ark_` read/poll sufficient |

Toggle: `~` cycles Agent-runner ↔ Operator. Observer is the default layout when nothing is selected.

---

## C. MVP must-have functions (testable)

1. **Board canvas** — all columns with cards: title, priority, claimedBy, tags snippet, STALE badge.
2. **Poll/refresh** — auto interval + manual `R`; show last poll time + errors.
3. **Select + open** — j/k within column, h/l or [/] across columns; Enter detail pane.
4. **Claim** — `c` on Ready/Inbox → POST claim; handle 200/409.
5. **Heartbeat** — `h` or auto-timer while focused Running mission with note prompt optional.
6. **Deliver** — `D` (shift-d) summary prompt → review.
7. **Escalate** — `e` single-question prompt → needs_human + call.
8. **Detail pane** — objective/context/constraints/acceptance/artifacts/history tail.
9. **Stale running** — badge when `lastHeartbeat` older than threshold (default 5m).
10. **Calls list** — view open calls; **reply only if operator auth available** (else show question + “reply in web”).
11. **Search filter** — `/` title/tags/id substring.
12. **Env config** — `DEVBOARDS_BASE_URL`, `DEVBOARDS_API_KEY`, `DEVBOARDS_AGENT`, `DEVBOARDS_BOARD`.
13. **Board switch** — `b` cycle known boards from GET `/boards`.
14. **One-shot status** — `devboards-tui --status` one-line counts + exit 0/1 if stale>0.
15. **Honest capability banner** — if key cannot move/reply, UI disables those chords and shows why.

### Nice-to-have still in MVP if cheap
- Create mission via ingest (title + objective) — `n` — agent-key safe.

---

## D. Non-goals (v1)

- WebSocket/live push (poll only)
- Full Analytics / Protocol docs browser / theme marketplace
- Agent registration & key minting (web only)
- Replacing Hermes itself as the coding agent
- Multiplayer cursors / CRDT
- Pixel-perfect clone of every web panel
- Bundling a model runtime

---

## E. Screen map

```
┌─ status bar: board · agent · mode · poll age · stale N · err ─────────────┐
│ COL: Inbox │ Ready │ Running │ Needs │ Review │ Done │ Blocked              │
│  cards...  │       │  *sel*  │       │        │      │                      │
├─ detail / calls / log (toggle) ─────────────────────────────────────────────┤
│ objective…  heartbeats…  artifacts…                                         │
└─ chord help · last API result ──────────────────────────────────────────────┘
```

| Screen | Primary actions |
|--------|-----------------|
| **Board** | navigate, claim, deliver, escalate, filter |
| **Detail** | scroll brief, copy id/url, heartbeat note |
| **Calls** | list open, reply if allowed |
| **Status** | CLI one-shot |

---

## F. Keyboard model

Align with web `keyboard-ops.ts` where it helps; terminal-native where it doesn’t.

| Chord | Action |
|-------|--------|
| j / k | next/prev card in column |
| h / l or [/] | prev/next column |
| 1–7 | jump column |
| Enter | open detail |
| Esc | close pane / clear search |
| / | search |
| c | claim |
| D | deliver |
| e | escalate |
| H | heartbeat now |
| r | move→ready **if allowed** |
| g | move→running **if allowed** |
| n | new mission (ingest) |
| R | refresh |
| b | next board |
| ~ | toggle agent-runner / operator |
| . | compact density |
| ? | help overlay |
| q | quit |

---

## G. Look & feel

- **Density first:** default compact 1–2 line cards; `.` expands to 3-line.
- **Theme:** dark near-black bg, muted borders, high-contrast titles; **no dependency on fancy unicode** (ASCII fallback).
- **Color semantics:** ready=cyan, running=green, needs_human=magenta, review=blue, blocked/stale=red/amber, done=dim.
- **Priority:** p0/p1 prefix tokens (`P0`, `P1`) not emoji-only.
- **Empty states:** one line “Ready empty — poll ok” vs “API 401”.
- **Errors:** sticky last error in status bar until next success.

---

## H. Refresh model

| Mode | Interval |
|------|----------|
| Operator board | 30s (env override) |
| Agent-runner | 10–15s on Ready focus |
| Manual | always `R` |

No WS in v1. Optional later: SSE if product adds it.

---

## I. Auth & config

```bash
DEVBOARDS_BASE_URL=https://app.devboards.ai
DEVBOARDS_API_KEY=ark_…
DEVBOARDS_AGENT=frodo
DEVBOARDS_BOARD=devboard-app   # slug or board_…
DEVBOARDS_POLL_INTERVAL=30
DEVBOARDS_STALE_MS=300000
DEVBOARDS_MODE=operator        # operator | agent
```

Optional later: `DEVBOARDS_OPERATOR_COOKIE` / device login — **not MVP**.

Capability probe on start: try GET boards + GET calls; if calls 401, mark operator features off.

---

## J. Stack recommendation

| Option | Fit |
|--------|-----|
| **Ink + React + TypeScript** | **Primary pick** — matches Hermes TUI stack, lives beside `agent-relay` monorepo as `packages/devboards-tui` or `apps/tui`, shared types from `src/lib/types.ts` |
| Textual + Python | Strong alt if shipping as Hermes skill/script only; team has Textual patterns |
| Bubble Tea / ratatui | Excellent TUIs, weaker fit for this TS product tree |

**Decision: TypeScript + Ink (React 19)** with `fetch`/undici client wrapping `/api/agent`.  
Publish as `npx devboards-tui` / `pnpm dlx` later; local `npm run tui` in repo for dev.

Qwen preferred Textual for Hermes adjacency; Frodo overrides to **Ink** for type-sharing with agent-relay and Hermes TUI consistency. Revisit only if Ink perf on huge boards fails dogfood.

---

## K. Phases

### P0 — usable board loop (1 short sprint)
- Ink app shell, columns, poll, claim, deliver, escalate, detail, env config, status CLI
- Capability banner; tests with mock API

### P1 — operator power
- Calls list + reply when session/key allows
- Heartbeat helper + stale badges
- Board switch; create via ingest
- Agent-runner batch strip (Ready count, next claim hint)

### P2 — polish
- Journal tail, compact analytics strip, config file, watch mode, themes

---

## L. Open questions (human)

1. **Operator auth in TUI:** cookie/session login in v1, or ship `ark_`-only and keep Calls reply in browser?
2. **Move permissions:** confirm production policy for agent `move` (today often signed_out) — TUI should match reality.
3. **Default stale threshold:** 5m global OK?
4. **Package home:** inside `agent-relay` monorepo vs standalone `devboards-tui` repo?
5. **Name:** `devboards-tui` vs `dbtui` vs `boards`?

Frodo defaults if unanswered: (1) ark_-only MVP, (2) disable move on 401, (3) 5m, (4) monorepo `apps/tui`, (5) `devboards-tui`.

---

## M. Implementation sketch (for next mission)

```
apps/tui/
  package.json          # ink, react, commander
  src/client.ts         # typed agent API
  src/app.tsx           # board layout
  src/components/…
  src/cli.ts            # --status, --board
```

Reuse mission field names from `src/lib/types.ts`. Do not import server-only modules.

---

## Artifacts

| Path | Role |
|------|------|
| This file (vault) | Operator SoT |
| `agent-relay/docs/TUI_DESIGN.md` | In-repo copy |
| Mission `msn_x9c2xihkmbnq` | DevBoard APP tracking |
| Qwen raw notes | `/tmp/qwen-tui-design.md` (session) |

---

## Acceptance for this design mission

- [x] Product understanding recorded  
- [x] MVP functions listed and testable  
- [x] Screen + keyboard + look defined  
- [x] Stack chosen (Ink/TS) with rationale  
- [x] Phases + open questions  
- [x] Durable paths for next implementer  

**Next mission (implement):** “P0 Ink TUI board loop against agent API”.
