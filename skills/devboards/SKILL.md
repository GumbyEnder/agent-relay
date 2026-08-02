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

1. **Create** missions when the human asks you to file work (default **inbox**)  
2. Poll Ready  
3. Claim one mission (required before implementation)  
4. Do the mission with **only the tools you already have**  
5. Heartbeat while working  
6. Deliver summary — or escalate one clear question  

If Ready is empty and you were not asked to file work, stop and say so.

## HTTP (copy)

```bash
BASE="${DEVBOARDS_BASE_URL%/}"
KEY="$DEVBOARDS_API_KEY"
AGENT="$DEVBOARDS_AGENT"
BOARD="${DEVBOARDS_BOARD:-devboard-app}"   # board slug or id you can access

# File a ticket (agents are allowed — default column inbox)
curl -sS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"project\":\"$BOARD\",\"column\":\"inbox\",\"title\":\"…\",\"objective\":\"…\",\"priority\":\"p1\",\"tags\":[]}" \
  "$BASE/api/agent/missions"

curl -sS -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent/missions?column=ready&limit=5&agent=$AGENT&project=$BOARD"

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

- No claim 200 → no implementation work  
- You **may create** missions on boards you have access to (inbox/ready only)  
- You are not the board host; artifacts should be URLs/refs the human can open  
- Do not assume laptop paths or private git unless the human already shared that environment  
