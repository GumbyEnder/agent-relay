---
name: devboards
description: Client agent loop for Dev Boards over HTTPS only.
version: 1.1.0
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
```

## Job loop

1. Poll Ready  
2. Claim one mission (required)  
3. Do the mission with **only the tools you already have**  
4. Heartbeat while working  
5. Deliver summary — or escalate one clear question  

If Ready is empty, stop and say so.

## HTTP (copy)

```bash
BASE="${DEVBOARDS_BASE_URL%/}"
KEY="$DEVBOARDS_API_KEY"
AGENT="$DEVBOARDS_AGENT"

curl -sS -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent/missions?column=ready&limit=5&agent=$AGENT"

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" \
  "$BASE/api/agent/missions/MISSION_ID/claim"

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"note\":\"status\"}" \
  "$BASE/api/agent/missions/MISSION_ID/heartbeat"

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"question\":\"One question?\"}" \
  "$BASE/api/agent/missions/MISSION_ID/escalate"

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"summary\":\"Done\",\"artifacts\":[]}" \
  "$BASE/api/agent/missions/MISSION_ID/deliver"
```

## Rules

- No claim 200 → no work  
- You are not the board host; artifacts should be URLs/refs the human can open  
- Do not assume laptop paths or private git unless the human already shared that environment  
