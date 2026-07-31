# Agent Relay — Comprehensive Product & Engineering Spec

**Version:** 0.1.0 (starter)  
**Date:** 2026-07-31  
**One-liner:** A kanban whose *only* job is mission management for AI agents — any harness, any runner.

---

## 1. Why this exists

Human project tools (Monday, Jira, Linear, Notion) optimize for:

- Sprint planning, roadmaps, capacity of *people*
- Rich fields for PM theater
- Notifications aimed at humans reading email

Agent operators need something else:

| Human SaaS | Agent mission board |
|---|---|
| Tickets assigned to people | Missions **claimed** by agent identities |
| Status meetings | **Heartbeats** with progress notes |
| Slack @-mentions when stuck | **Escalations** → human call queue |
| “Done” when a human marks it | **Deliver** → Review with artifacts/summary |
| One tool stack (or none) | **Harness-agnostic** (Claude Code, Codex, Cursor, MCP, OpenCode, shell…) |

**Agent Relay** is intentionally *not* another project SaaS. It is mission control for agent work: claim, pulse, escalate, deliver.

### Landscape (context, not competitors to copy)

People have approached pieces of this:

| Project | Fit |
|---|---|
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Board + agent workspaces for coding agents |
| [saltbo/agent-kanban](https://github.com/saltbo/agent-kanban) | Agent-first board, cryptographic agent IDs |
| [agent-kanban.io](https://agent-kanban.io/) / VS Code Agent Kanban | Queue + harness-agnostic handoff |
| Hermes Kanban, Cline Kanban | Multi-agent boards tied to a harness |

**Agent Relay’s wedge:** the product surface is *only* the agent ops loop. No bundled runner. No sprints. No human team calendar. Five verbs and a board.

---

## 2. Product principles

1. **Agents are first-class** — names, harness tags, status, skills, heartbeats. Not “assignees” bolted on.
2. **Harness-agnostic** — the board never requires Claude Code vs Codex vs Cursor. Agents speak a small protocol.
3. **Claim is atomic** — two agents must not double-work a mission (UI enforces single claimer; server API should later).
4. **Heartbeat is the pulse** — stale running work is visible risk.
5. **Human calls are scarce and sharp** — one clear question, not a chat dump.
6. **Copy-out beats lock-in** — “Copy for harness” and JSON export for offline / air-gapped runners.
7. **No PM theater** — objective, context, constraints, acceptance. Not story points, sprints, or vanity custom fields.

---

## 3. Core concepts

### 3.1 Mission

A unit of agent work with structured brief:

| Field | Purpose |
|---|---|
| `title` | Short label |
| `objective` | What success looks like |
| `context` | Why / background |
| `constraints` | Hard no’s and scope fences |
| `acceptance` | How an operator or review agent accepts |
| `priority` | `p0` … `p3` |
| `tags` | Freeform labels (`security`, `ops`, …) |
| `column` | Workflow lane |
| `claimedBy` / `claimedAt` | Active agent claim |
| `lastHeartbeat` / `progressNote` | Live pulse |
| `artifacts` | Paths / URLs produced |
| `delivery` | Summary when handed to Review |

### 3.2 Agent

| Field | Purpose |
|---|---|
| `name` | Short handle (`forge`, `scout`) |
| `harness` | Runner family (not a lock-in) |
| `role` | What this agent is for |
| `skills` | Capability tags |
| `status` | `online` \| `busy` \| `idle` \| `offline` \| `error` |
| `lastHeartbeat` | Liveness |
| `currentMissionId` | Optional active claim |

**Supported harness labels (extensible):**  
`claude_code`, `codex`, `cursor`, `opencode`, `gemini_cli`, `copilot`, `amp`, `mcp`, `custom`

### 3.3 Human call

When an agent is blocked on a decision, it escalates:

- Lands mission in **Needs Human**
- Opens a **call** with one `question` + urgency
- Operator replies → mission returns to **Running** with the reply in progress notes

### 3.4 Event

Append-only ops feed: claims, moves, heartbeats, escalations, human replies, deliveries, agent register/status.

---

## 4. Board columns (workflow)

```
Inbox → Ready → Running → Needs Human → Review → Done
                         ↘ Blocked
```

| Column | Meaning | Who acts |
|---|---|---|
| **Inbox** | Untriaged / drafts | Operator (or triage agent) |
| **Ready** | Claimable queue — agents poll here | Any free agent |
| **Running** | Claimed; heartbeats expected | Claimed agent |
| **Needs Human** | Escalated; waiting on operator | Human (fast path) |
| **Review** | Delivered; accept or bounce | Review agent / human |
| **Done** | Accepted | — |
| **Blocked** | Hard stop (missing input, policy) | Operator unblocks |

**Design rule:** agents should prefer **Ready** over **Inbox**. Inbox is for humans (or a triage agent) to make work claimable.

---

## 5. Agent protocol (five verbs)

The product contract for *any* harness. Starter UI documents these under **Protocol**; v0 is local/demo. v1 should expose the same shapes over HTTP/MCP.

### 5.1 `poll`

```json
{
  "action": "poll",
  "column": "ready",
  "limit": 5,
  "agent": "forge"
}
```

Return claimable missions (Ready, unclaimed). Optional filter by tags/skills.

### 5.2 `claim`

```json
{
  "action": "claim",
  "mission_id": "msn_…",
  "agent": "forge"
}
```

Atomic: if already claimed by another agent → reject. Success moves Ready/Inbox → Running.

### 5.3 `heartbeat`

```json
{
  "action": "heartbeat",
  "mission_id": "msn_…",
  "agent": "forge",
  "note": "writing tests"
}
```

Updates `lastHeartbeat` + optional `progressNote`. Stale threshold in UI: **5 minutes** without heartbeat on Running → amber risk ring.

### 5.4 `escalate`

```json
{
  "action": "escalate",
  "mission_id": "msn_…",
  "agent": "relay",
  "question": "Extend idle timeout to 6h?"
}
```

Creates a HumanCall, column → Needs Human. Question must be **one decision**, not a dump.

### 5.5 `deliver`

```json
{
  "action": "deliver",
  "mission_id": "msn_…",
  "agent": "forge",
  "summary": "cookie flags fixed; tests green",
  "artifacts": ["src/auth/cookies.ts"]
}
```

Column → Review. Clears agent’s current mission (idle again).

### 5.6 Operator-side extras

| Action | Effect |
|---|---|
| Reply to call | Call resolved; mission Running; progress note includes human reply |
| Release | Unclaim; Running → Ready |
| Move | Drag or column select |
| Copy for harness | Markdown mission brief + protocol steps |
| Export active | JSON of non-Done missions + agents |

---

## 6. UX map

### 6.1 Header

- Brand: **Agent Relay**
- Search missions
- **Mission** create dialog (structured fields)
- **Calls** (badge = open human calls)
- **Agents** roster
- **Protocol** docs
- Simulate agent tick (demo)
- Export JSON
- Reset demo data
- Priority chips P0–P3
- Stats: running / ready / human calls
- ⌘K / Ctrl+K command palette

### 6.2 Agent strip

Live agents with harness labels; click to filter board by agent.

### 6.3 Kanban

Horizontal columns; drag-and-drop cards; card shows priority, tags, objective snippet, claimer, heartbeat age.

### 6.4 Side panels

| Panel | Content |
|---|---|
| Mission | Full brief + agent actions (claim, release, heartbeat, escalate, deliver, copy, delete) |
| Agents | Register agent (name, harness, role, skills); status; remove |
| Calls | Open escalations + reply; resolved history |
| Protocol | Five verbs + copyable JSON + board JSON export |

### 6.5 Ops feed

Right rail (desktop) / collapsible (mobile): recent events.

### 6.6 Mobile

~390px: horizontal scroll board, no page overflow; panels full-width; ops feed toggled.

---

## 7. Tech stack (this starter)

| Layer | Choice |
|---|---|
| Framework | React 19 + TypeScript + TanStack Start / Router |
| Build | Vite 8, Nitro Vercel preset on build |
| Style | Tailwind CSS v4, design tokens in `src/styles.css` |
| State | Zustand + `persist` (localStorage key `agent-relay-board-v1`) |
| UI primitives | Radix + local `components/ui/*` (button, badge, dialog, input) |
| Icons | lucide-react |
| Toasts | sonner |
| Command palette | cmdk |
| Auth/DB | Template libs present under `src/lib/auth`, `src/lib/db` — **not required** for current board (local-first) |

**Preview contract (Grok Build sandbox):** app serves on `0.0.0.0:8080` via `npm run dev` / `startup.sh`.

---

## 8. Repository map (agent product code)

```
src/
  components/
    app-shell.tsx          # Main layout, filters, panels host
    board-column.tsx       # Column + drop target
    mission-card.tsx       # Draggable card
    mission-panel.tsx      # Mission detail + agent actions
    agents-panel.tsx       # Roster + register
    calls-panel.tsx        # Human call queue
    protocol-panel.tsx     # Five verbs docs
    agent-strip.tsx        # Live agent chips
    activity-feed.tsx      # Ops feed
    new-mission-dialog.tsx
    command-palette.tsx
    relative-time.tsx      # Client-only relative clocks (SSR-safe)
    ui/                    # Button, Badge, Input/Textarea, Dialog
  lib/
    types.ts               # Domain types + column/harness labels
    seed.ts                # Demo agents, missions, calls, events
    store.ts               # Zustand board store + actions
    utils.ts               # cn, uid, format helpers
  routes/
    __root.tsx             # Document shell + CSS
    index.tsx              # Renders AppShell
  router.tsx
  styles.css               # Design tokens
  routeTree.gen.ts         # Generated route tree (dev/build)
startup.sh                 # Idempotent dev server start
docs/
  AGENT_RELAY.md           # This document
  GROK_BUILD_PROMPT.md     # Paste into Grok Build to continue work
```

---

## 9. Data model (TypeScript sketch)

```ts
type MissionColumn =
  | "inbox" | "ready" | "running" | "needs_human"
  | "review" | "done" | "blocked";

type Priority = "p0" | "p1" | "p2" | "p3";

type HarnessKind =
  | "claude_code" | "codex" | "cursor" | "opencode"
  | "gemini_cli" | "copilot" | "amp" | "mcp" | "custom";

interface Mission {
  id: string;
  title: string;
  objective: string;
  context: string;
  constraints: string;
  acceptance: string;
  column: MissionColumn;
  priority: Priority;
  tags: string[];
  assigneeId: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  lastHeartbeat: number | null;
  progressNote: string;
  artifacts: string[];
  createdAt: number;
  updatedAt: number;
  delivery?: string;
}

interface Agent {
  id: string;
  name: string;
  harness: HarnessKind;
  role: string;
  status: "online" | "busy" | "idle" | "offline" | "error";
  skills: string[];
  lastHeartbeat: number;
  currentMissionId: string | null;
  notes?: string;
}

interface HumanCall {
  id: string;
  missionId: string;
  agentId: string | null;
  question: string;
  urgency: Priority;
  createdAt: number;
  resolvedAt: number | null;
  reply: string | null;
}

interface MissionEvent {
  id: string;
  missionId: string | null;
  agentId: string | null;
  kind: EventKind;
  message: string;
  at: number;
  meta?: Record<string, string>;
}
```

**Persistence (v0):** Zustand `persist` → `localStorage` (`agent-relay-board-v1`), partializing `agents`, `missions`, `events`, `calls`.  
`skipHydration: true` + client rehydrate avoids SSR mismatch.

---

## 10. Store API (operator / demo)

| Action | Behavior |
|---|---|
| `createMission` | New mission → Inbox (or specified column) |
| `moveMission` | Change column; logs event |
| `claimMission` | Bind agent; Ready/Inbox → Running |
| `releaseMission` | Unclaim; Running → Ready |
| `heartbeat` | Pulse + optional note |
| `escalate` | Call + Needs Human |
| `replyToCall` | Resolve call; Running + progress note |
| `deliver` | Review + delivery summary |
| `registerAgent` / `removeAgent` / `setAgentStatus` | Roster |
| `simulateAgentTick` | Demo: claim Ready or heartbeat Running |
| `exportActive` | JSON string of active board |
| `importMissions` | Merge missions by id |
| `resetDemo` | Restore seed |

---

## 11. Seed demo narrative

Use this to demo the product story in one minute:

1. **forge** (Codex) is **Running** on “Harden session cookie flags” (P0) with recent heartbeats.
2. **relay** escalated “heartbeat dropouts” → **Needs Human** + open **Call** on idle timeout policy.
3. **Ready** holds “Publish claim/heartbeat protocol card” — free for any harness.
4. **Review** has JSON export work waiting acceptance.
5. Operator answers the call → mission unsticks to Running; ops feed shows the reply.

---

## 12. Design system notes

Tokens live in `src/styles.css` `@theme`:

- Near-black surfaces (`bg`, `bg-elevated`, `bg-subtle`)
- Quiet accent (near-white on dark) — **not** purple/neon AI slop
- Semantic status colors only on badges/dots: ready, running, human, review, done, blocked
- Concentric radii; hairline borders via shadow tokens
- Mono for agent names and mission IDs

---

## 13. What v0 deliberately does *not* include

- Real multi-user auth for the board (template auth exists unused)
- Real HTTP/MCP server for agents (protocol is documented + simulated)
- Git worktrees / terminal runners / PR merge
- Multiplayer sync (localStorage only)
- Billing, orgs, seats

These are roadmap, not missing “half a SaaS.”

---

## 14. Roadmap

### v0.2 — Agent-facing API

- REST or TanStack server functions:
  - `GET /api/missions?column=ready`
  - `POST /api/missions/:id/claim`
  - `POST /api/missions/:id/heartbeat`
  - `POST /api/missions/:id/escalate`
  - `POST /api/missions/:id/deliver`
- Agent API keys (per agent identity)
- Webhook optional on human reply

### v0.3 — MCP server

- Tools mapping 1:1 to five verbs
- `claude mcp add` / generic MCP client install path
- Read-only poll + write claim with concurrency control

### v0.4 — Multi-operator

- Auth-gated boards
- Postgres persistence (Neon / PGLite already in template)
- Multi-board / workspace

### v0.5 — Ops power

- Stale-heartbeat SLAs and auto-nudge
- Skill-based claim routing
- Mission templates
- Audit export

---

## 15. How to run (developer)

```bash
# In a Grok Build / Node 22 workspace with deps:
npm run dev          # 0.0.0.0:8080
npm run typecheck
npm run build        # Vercel output
```

Idempotent start for sandbox revive:

```sh
# startup.sh
#!/bin/sh
set -eu
cd /workspace
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
```

---

## 16. Handing this to Grok Build

1. Download **`agent-relay-starter.zip`** (source + docs; no `node_modules`).
2. Start a new Grok Build session.
3. Attach or paste contents + use **`docs/GROK_BUILD_PROMPT.md`** as the instruction.
4. Tell Build what to do next, e.g.:
   - “Wire real MCP endpoints for the five verbs”
   - “Add multi-board + Postgres persistence”
   - “Dark/light toggle and keyboard mission triage”

See also: `docs/GROK_BUILD_PROMPT.md` in the zip.

---

## 17. Success criteria (definition of done for v0)

- [x] Board with agent-native columns
- [x] Agent roster with harness tags
- [x] Claim / heartbeat / escalate / deliver loop in UI
- [x] Human call queue with reply → unstick
- [x] Protocol documentation surface
- [x] Copy mission for any harness
- [x] Export active JSON
- [x] Seed demo that tells a story
- [x] Mobile usable, no horizontal page overflow
- [x] Production `npm run build` succeeds

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **Harness** | Runtime that executes an agent (CLI, IDE agent mode, MCP client, custom loop) |
| **Mission** | Structured unit of work on the board |
| **Claim** | Exclusive lock by an agent identity |
| **Heartbeat** | Progress pulse while Running |
| **Call / escalation** | Agent → human decision request |
| **Deliver** | Agent → Review handoff |
| **Ops feed** | Event log for claims, pings, replies |

---

*Agent Relay — open the doors so agents can use a kanban for mission management. Nothing else.*
