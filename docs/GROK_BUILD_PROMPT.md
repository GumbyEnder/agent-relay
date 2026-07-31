# Grok Build handoff prompt — Agent Relay

Copy everything below the line into a new Grok Build chat (attach `agent-relay-starter.zip` if the product supports file attach; otherwise paste key files).

---

## Build request

Continue **Agent Relay**: a kanban **100% focused on AI agents** for mission management — any harness (Claude Code, Codex, Cursor, MCP, OpenCode, custom). Not Monday.com / Jira / human PM SaaS.

### Product rules (non-negotiable)

- Agents are first-class (identity, harness, status, skills, heartbeats).
- Harness-agnostic: no bundled agent runner.
- Five verbs: **poll, claim, heartbeat, escalate, deliver**.
- Columns: Inbox → Ready → Running → Needs Human → Review → Done (+ Blocked).
- Human call queue: one clear question, reply unsticks agent to Running.
- Local-first is OK for demos; prefer real HTTP/MCP when adding agent APIs.
- UI: dark, restrained, no purple/neon AI slop. Follow design-ui skill if present.
- Serve on `0.0.0.0:8080`, maintain `startup.sh`, verify browser render + `npm run build`.

### What’s already in the starter

- Working TanStack Start + React + Tailwind v4 + Zustand board
- Seeded demo (forge running P0, open human call, ready missions)
- UI for claim/heartbeat/escalate/deliver, agent roster, protocol panel, ⌘K
- Docs: `docs/AGENT_RELAY.md` (full spec)

### Suggested next work (pick what I ask for)

1. Real agent API (server functions or REST) implementing the five verbs with atomic claim.
2. MCP server tools for the same verbs.
3. Postgres persistence + multi-operator auth.
4. Multi-board workspaces.
5. Webhooks when a human replies to a call.
6. Polish / mobile / keyboard ops.

### Stack

React 19, TypeScript, Vite 8, TanStack Start/Router, Tailwind v4, Zustand, Radix, lucide, sonner, cmdk. Template includes auth/db helpers under `src/lib` — use if needed, don’t force login for local board demos unless building multi-user.

### Read first

- `docs/AGENT_RELAY.md` — comprehensive product + eng spec
- `src/lib/types.ts`, `src/lib/store.ts`, `src/components/app-shell.tsx`

Ship demo-quality increments; keep the preview alive; speak in product terms.
