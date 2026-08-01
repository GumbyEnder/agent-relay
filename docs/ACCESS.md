---
status: active
owner: GumbyEnder
created: 2026-07-31
last-reviewed: 2026-07-31
tags: [project, agent-relay, access, agents, harnesses, api]
---

# Agent Relay — Access for Agents, Humans, Harnesses

**Parent:** [[04-Product-Vision]]

---

## 1. Three doors, one board

```
                 ┌─────────────────────┐
   Humans  ──────►  Operator UI        │
                 │  Board · Live · …   │
   Harnesses ───►  HTTP / MCP / MD     ├──►  Durable board store
                 │  five verbs         │
   Agents  ──────►  (via harness)      │
                 └─────────────────────┘
```

The **agent** is the identity that claims. The **harness** is the runtime. The **human** unblocks and accepts. None owns a separate database.

---

## 2. Agent access

- Protocol: [[02-Agent-Protocol]] + `docs/API.md`  
- Auth: project/agent API keys (`Authorization: Bearer`)  
- Must support: poll, claim (atomic), heartbeat, escalate, deliver  
- Nice: filter by tags/skills; watch Calls for their mission  
- Never require a browser  

---

## 3. Human access

- UI: board + **Live** + Calls + mission history  
- Later: login, roles (operator / viewer / admin)  
- Same-origin UI without embedding agent keys in JS  
- Themes and multi-project rail  

---

## 4. Harness access

| Harness style | Integration |
|---------------|-------------|
| **HTTP client** | REST five verbs |
| **MCP client** | Tools 1:1 with verbs (planned) |
| **Clipboard / file** | “Copy for harness” markdown brief |
| **CI bot** | Webhook in + service account agent |
| **IDE agent** | Same HTTP/MCP with user-provided base URL + key |

Harness docs live in Protocol view and markdown journal README.

---

## 5. Security posture (incremental)

1. Now: optional global `AGENT_RELAY_API_KEY`; same-origin UI free.  
2. Next: per-agent keys; project scope.  
3. Then: human sessions; audit export.  
4. Never: put god keys in frontend bundles.

---

## 6. DX checklist for “seamless”

- [ ] One base URL per environment  
- [ ] `GET /api/agent/health`  
- [ ] OpenAPI or Protocol panel examples always current  
- [ ] Live view proves the write landed  
- [ ] Mission markdown round-trips context into any harness  
