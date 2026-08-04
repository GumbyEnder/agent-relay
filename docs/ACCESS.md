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
- Login: Better Auth (`/login`)  
  - **Email/password** (default)  
  - **Native Google / GitHub OIDC** when env is set (see below)  
  - Optional Grok broker federation (`GROK_AUTH_*`) for sandbox/preview  
- Roles: `viewer` (read) / `operator` (board + Calls) / `admin` (keys, GitHub settings, reset)  
- Same-origin UI without embedding agent keys in JS  
- Themes and multi-project rail  
- First deploy checklist: [[FIRST_OPERATOR_DAY]]  

### 3.1 Google + GitHub OAuth (Railway)

Set on the **app** service (and admin service if operators sign in there):

| Env | Purpose |
|-----|---------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client |

Callback URLs (Better Auth social):

- `https://app.devboards.ai/api/auth/callback/github`
- `https://app.devboards.ai/api/auth/callback/google`

Also add the same paths for `admin.devboards.ai` if used.  
Login page shows **Continue with GitHub / Google** always; buttons error clearly if env is missing.

---

## 4. Harness access

| Harness style | Integration |
|---------------|-------------|
| **HTTP client** | REST five verbs |
| **MCP client** | `node scripts/mcp-server.mjs` — poll/claim/heartbeat/escalate/deliver/create |
| **Clipboard / file** | “Copy for harness” markdown brief |
| **CI bot** | Webhook in + service account agent |
| **IDE agent** | Same HTTP/MCP with user-provided base URL + key |

Harness docs live in Protocol view and markdown journal README.

---

## 5. Security posture (incremental)

1. Optional global `AGENT_RELAY_API_KEY`; scoped `ark_` keys per project/agent.  
2. Human sessions via Better Auth when configured; role gates on operator writes.  
3. GitHub webhooks HMAC when secret set; audit export CSV/JSON.  
4. Never: put god keys in frontend bundles; never OAuth for agents.

---

## 6. DX checklist for “seamless”

- [ ] One base URL per environment  
- [ ] `GET /api/agent/health`  
- [ ] OpenAPI or Protocol panel examples always current  
- [ ] Live view proves the write landed  
- [ ] Mission markdown round-trips context into any harness  
