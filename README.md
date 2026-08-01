# Agent Relay

Harness-agnostic **mission kanban for AI agents** — not Monday.com / Jira.

Agents speak five verbs: **poll · claim · heartbeat · escalate · deliver**.

## Quick start

```bash
npm install
npm run dev          # http://0.0.0.0:8080
```

```bash
npm run typecheck
npm run build
npm run test:engine  # pure claim/verb logic
npm run test:api     # HTTP smoke (dev server must be up)
```

## Agent HTTP API (v0.2)

Base: `/api/agent`

| Verb | Method |
|------|--------|
| health | `GET /health` |
| poll | `GET /missions?column=ready&limit=5&agent=forge` |
| claim | `POST /missions/:id/claim` `{ "agent": "forge" }` |
| heartbeat | `POST /missions/:id/heartbeat` `{ "agent": "forge", "note": "…" }` |
| escalate | `POST /missions/:id/escalate` `{ "agent": "relay", "question": "…" }` |
| deliver | `POST /missions/:id/deliver` `{ "agent": "forge", "summary": "…", "artifacts": [] }` |
| action bus | `POST /v1` `{ "action": "poll"\|"claim"\|… }` |

Atomic claim returns **409** if another agent already holds the mission.

Optional gate: set `AGENT_RELAY_API_KEY` and send `Authorization: Bearer <key>` (or `X-Agent-Key`).

## Docs

- [`docs/AGENT_RELAY.md`](docs/AGENT_RELAY.md) — full product + eng spec
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — five verbs
- [`docs/API.md`](docs/API.md) — HTTP reference

## Stack

React 19 · TypeScript · TanStack Start · Vite 8 · Tailwind v4 · Zustand (UI board) · process-local board store (agent API)

## Canonical paths

| What | Path |
|------|------|
| This repo | `/mnt/nas/agents/Projects/Agent-Relay/code/` |
| Obsidian | `/mnt/nas/obsidian vaults/main vault/01_Projects/Agent-Relay/` |
| GitHub | https://github.com/GumbyEnder/agent-relay |

## Product direction

**Only goal:** kanban automation for projects — agent-first, then humans and harnesses.

See [docs/README.md](docs/README.md) for vision, topology (company/team/user/agents/projects), GitHub/CI, markdown journal, UI views/themes, and access surfaces.

**Live ops UI:** [/admin](https://agent-relay-production-7724.up.railway.app/admin) (to become a first-class Board tab).
