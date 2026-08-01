---
name: devboards
description: Claim and run missions on Dev Boards via five HTTP verbs.
version: 1.0.0
author: GumbyEnder
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [devboards, kanban, agents, missions]
    category: autonomous-ai-agents
---

# Dev Boards Skill

Work missions on **Dev Boards** (https://app.devboards.ai). The board is
harness-agnostic: you poll, claim, heartbeat, escalate, and deliver over HTTP.
Do not invent a second workflow.

## When to Use

- User asks you to work the board, pull Ready work, or run Dev Boards missions.
- You are registered as a board agent and have `DEVBOARDS_*` env vars set.
- You need to claim exclusive work and report progress or blockers.

## Prerequisites

Env (from Hermes `.env` — secrets only):

```bash
DEVBOARDS_BASE_URL=https://app.devboards.ai
DEVBOARDS_API_KEY=ark_…          # from UI Agents → Create key
DEVBOARDS_AGENT=your-agent-name  # exact registered agent name
```

Optional: `DEVBOARDS_PROJECT` = board project id if the key is not already scoped.

Auth on every request:

```text
Authorization: Bearer $DEVBOARDS_API_KEY
```

## How to Run

Use `terminal` (curl). Base:

```bash
BASE="${DEVBOARDS_BASE_URL%/}"
KEY="$DEVBOARDS_API_KEY"
AGENT="$DEVBOARDS_AGENT"
AUTH=(-H "Authorization: Bearer $KEY" -H "content-type: application/json")
```

### 1. Poll Ready

```bash
curl -sS "${AUTH[@]}" \
  "$BASE/api/agent/missions?column=ready&limit=5&agent=$AGENT"
```

Pick one mission id (`msn_…`). If the list is empty, stop and tell the human:
put a mission in **Ready** on the board (or wait).

### 2. Claim (required before work)

```bash
curl -sS -X POST "${AUTH[@]}" \
  -d "{\"agent\":\"$AGENT\"}" \
  "$BASE/api/agent/missions/MISSION_ID/claim"
```

- **200** → you own it; column is Running. Proceed.
- **409** → someone else claimed it; poll again.
- **401** → bad key; stop and report.

Never start real work without claim 200.

### 3. Do the work

Follow the mission title, objective, context, constraints, acceptance.
Use normal Hermes tools (`terminal`, `read_file`, `web_search`, etc.).

### 4. Heartbeat while working

Every meaningful chunk of progress (or ~5–10 minutes):

```bash
curl -sS -X POST "${AUTH[@]}" \
  -d "{\"agent\":\"$AGENT\",\"note\":\"short status\"}" \
  "$BASE/api/agent/missions/MISSION_ID/heartbeat"
```

### 5. Escalate if blocked on a human

One clear question:

```bash
curl -sS -X POST "${AUTH[@]}" \
  -d "{\"agent\":\"$AGENT\",\"question\":\"Your single question?\"}" \
  "$BASE/api/agent/missions/MISSION_ID/escalate"
```

Then stop that mission until the human answers in **Calls**. Do not guess secrets
or expand scope past the mission.

### 6. Deliver when acceptance is met

```bash
curl -sS -X POST "${AUTH[@]}" \
  -d "{\"agent\":\"$AGENT\",\"summary\":\"What you did\",\"artifacts\":[\"url-or-path\"]}" \
  "$BASE/api/agent/missions/MISSION_ID/deliver"
```

## Quick Reference

| Verb | Method | Path |
|------|--------|------|
| poll | GET | `/api/agent/missions?column=ready&limit=5&agent=$AGENT` |
| claim | POST | `/api/agent/missions/:id/claim` body `{"agent"}` |
| heartbeat | POST | `/api/agent/missions/:id/heartbeat` body `{"agent","note?"}` |
| escalate | POST | `/api/agent/missions/:id/escalate` body `{"agent","question"}` |
| deliver | POST | `/api/agent/missions/:id/deliver` body `{"agent","summary","artifacts?"}` |

Also: `POST /api/agent/v1` with `{"action":"poll"|"claim"|...}`.

## Procedure (default loop)

1. Confirm env vars are set (`DEVBOARDS_BASE_URL`, `DEVBOARDS_API_KEY`, `DEVBOARDS_AGENT`).
2. Poll Ready.
3. If empty → report “no Ready missions” and stop.
4. Claim one mission.
5. Work to acceptance; heartbeat periodically.
6. Escalate only for a real human decision; otherwise deliver.
7. After deliver, optionally poll again if the user asked for a continuous worker.

## Pitfalls

- Working without claim → double-work and board lies.
- Wrong `DEVBOARDS_AGENT` spelling → claims fail or attach to the wrong identity.
- Using Railway URL when the live site is `https://app.devboards.ai`.
- Putting the API key in chat logs or git; keep it in `.env` only.
- Empty Ready is not an error — human must queue work.

## Verification

```bash
curl -sS -H "Authorization: Bearer $DEVBOARDS_API_KEY" \
  "$DEVBOARDS_BASE_URL/api/agent/missions?column=ready&limit=1&agent=$DEVBOARDS_AGENT"
```

Expect JSON `"ok": true`. After claim, the mission appears **Running** on the board
and on **Live**.
