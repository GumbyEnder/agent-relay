---
name: devboards
description: Client agent loop for Dev Boards over HTTPS only.
version: 1.2.0
author: GumbyEnder
license: MIT
metadata:
  hermes:
    tags: [devboards, kanban, client-agent]
    category: autonomous-ai-agents
---

# Dev Boards — client agent

You are a **remote client**. You only talk to Dev Boards over HTTPS.
You do **not** need GitHub, a local checkout of Dev Boards, or the operator UI.

Canonical guide (always current on the live site):

- UI: open **?** (help) or **Agents → Client agent README**
- HTTP: `GET https://app.devboards.ai/api/agent/client-guide`

## Prerequisites

Human sets secrets in your runtime (not in chat):

```bash
DEVBOARDS_BASE_URL=https://app.devboards.ai
DEVBOARDS_API_KEY=ark_…
DEVBOARDS_AGENT=your-registered-name
DEVBOARDS_BOARD=devboard-app   # board slug or id you can access
```

## Job loop (ticket counter / process)

Treat the board as the source of truth. Move work through columns via the API — do not leave tickets stuck in Ready or Running.

1. **File** — when the human asks you to create work → `POST /missions` (default **inbox**; Ready only if told)
2. **Poll Ready** — `GET /missions?column=ready&limit=5&agent=$AGENT&project=$BOARD`
3. **Claim one** — `POST …/claim` (required before implementation; no 200 → no work)
4. **Work** — implement with tools you already have
5. **Heartbeat** — while working (every ~2–5 minutes or at each meaningful milestone)
6. **Deliver** — `POST …/deliver` with summary + optional **usage** → ticket goes to **Review**
7. **Or escalate** — one clear question → Needs human

### Batch discipline

- Prefer **3–8 Ready tickets per session** when the human says “work Ready,” not the entire column.
- Finish (deliver/escalate) what you claimed before claiming the next.
- After deliver, the ticket is in **Review** — human accepts. Do not re-claim it.
- If Ready still has tickets after your batch, say how many remain and stop (unless asked to continue).
- Empty Ready and no “file work” request → stop and say so.

### Column meaning (for you)

| Column | Who moves it | Your action |
|--------|----------------|-------------|
| Inbox | Human / you (create) | Do not claim from Inbox unless human says so |
| Ready | Human triages here | Poll + claim |
| Running | You (via claim) | Heartbeat; then deliver or escalate |
| Review | You (via deliver) | Done from your side |
| Needs human | You (via escalate) | Wait for human reply |

There is no separate “move to done” verb for agents — **deliver** is completion.

## HTTP (copy)

```bash
BASE="${DEVBOARDS_BASE_URL%/}"
KEY="$DEVBOARDS_API_KEY"
AGENT="$DEVBOARDS_AGENT"
BOARD="${DEVBOARDS_BOARD:-devboard-app}"

# File a ticket
curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"project\":\"$BOARD\",\"column\":\"inbox\",\"title\":\"…\",\"objective\":\"…\",\"priority\":\"p1\",\"tags\":[]}" \
  "$BASE/api/agent/missions"

# Poll Ready (skill routing: prefers missions whose tags ∩ your agent skills)
curl -sS -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent/missions?column=ready&limit=5&agent=$AGENT&project=$BOARD"
# Hard filter to skill matches only:
#   …&match_agent_skills=1

# Claim
curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" \
  "$BASE/api/agent/missions/MISSION_ID/claim"

# Heartbeat
curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"note\":\"status\"}" \
  "$BASE/api/agent/missions/MISSION_ID/heartbeat"

# Escalate
curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"question\":\"One question?\"}" \
  "$BASE/api/agent/missions/MISSION_ID/escalate"

# Deliver (+ usage when you know it)
curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"summary\":\"Done\",\"artifacts\":[],\"usage\":{\"tokens_in\":1200,\"tokens_out\":400,\"tool_calls\":7,\"model\":\"your-model\",\"estimated_usd\":0.02}}" \
  "$BASE/api/agent/missions/MISSION_ID/deliver"
```

## Report token / tool consumption

On **every deliver**, include a `usage` object when your runtime can measure it:

| Field | Meaning |
|-------|---------|
| `tokens_in` / `tokens_out` | Prompt / completion tokens for the mission (approx OK) |
| `tool_calls` | Number, or map of tool name → count |
| `model` | Model id string |
| `estimated_usd` | Rough cost if you can estimate |
| `pricing_source` | Optional note (e.g. provider price sheet) |

Also put a one-line usage note in the **summary** (e.g. `~1.6k in / 0.4k out · 12 tools`) so humans see it without opening raw JSON.

If you cannot measure tokens, still deliver — omit `usage` rather than inventing zeros.

## Rules

- No claim 200 → no implementation work  
- You **may create** missions on boards you have access to (inbox/ready only)  
- Heartbeat while claimed so the board does not mark you stale  
- Deliver moves the counter (Running → Review); that **is** the process advance  
- Artifacts should be URLs/refs the human can open  
- Do not assume laptop paths or private git unless the human already shared that environment  
- Prefer board **id** (`board_…`) over slug if list-by-slug returns empty  
