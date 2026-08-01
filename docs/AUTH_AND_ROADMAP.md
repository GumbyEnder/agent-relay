# Auth recommendations & remaining functionality

## Recommended auth (pragmatic ladder)

Agent Relay has **two audiences** that should not share the same credential type.

| Audience | Recommended auth | Why |
|----------|------------------|-----|
| **Agents / harnesses** | **Per-project or per-agent API keys** (`Authorization: Bearer`) | Machine-friendly, rotatable, no browser cookies, fits five-verb HTTP/MCP |
| **Human operators** | **OIDC / OAuth** (GitHub, Google, or org IdP) via Better Auth (already in template) | Familiar login, sessions, no keys in the frontend |
| **GitHub webhooks** | **HMAC webhook secret** + optional GitHub App install | Request authenticity without user login |
| **Local / demo** | Open UI + optional global `AGENT_RELAY_API_KEY` (current) | Fast onboarding |

### What we should *not* do first

- **Don’t** put long-lived god API keys in the browser bundle  
- **Don’t** force agents through OAuth browser redirects  
- **Don’t** invent a custom password DB before OIDC  

### Suggested phases

1. **Now (dev):** open same-origin UI; optional global agent key (shipped).  
2. **Next:** project-scoped agent keys; human session optional behind flag.  
3. **Then:** Better Auth OIDC (GitHub App login pairs well with issue ingest); map users → teams/projects.  
4. **Later:** RBAC — `viewer` / `operator` / `admin`; agent keys never get admin.  

**Hermes / multi-product note:** if this sits next to Hermes fleet auth, reuse the same OIDC issuer when possible so operators have one identity.

### Auth decision (default recommendation)

> **Humans = OIDC (Better Auth). Agents = scoped API keys. Webhooks = signed secrets.**

That matches the product: agents poll/claim without a seat license dance; humans get a real session for multi-project UI.

---

## Other functionality still needed (priority)

Aligned with “kanban automation, agent-first only.”

### P0 — core product loop

| Item | Why |
|------|-----|
| **GitHub App install UX** | Ingest path exists; operators need one-click install + repo mapping |
| **Per-agent API keys UI** | Harnesses need copy-paste credentials without sharing a global key |
| **Mission filters on Live** | Live tab is dense; filter by agent/project/kind |
| **Sub-project or label filters** | Topology without full multi-tenant yet |

### P1 — CI/CD clarity

| Item | Why |
|------|-----|
| **PR / check-run → mission artifacts** | Ship trail on the card |
| **Journal → `.relay/` git sync** | Projection already; write-back optional |
| **Webhook out on human reply** | Unstick agents sleeping on escalate |
| **MCP five tools** | IDE agents without custom HTTP |

### P1 — operator quality

| Item | Why |
|------|-----|
| **Keyboard ops** | j/k columns, c claim, e escalate — power users |
| **Compact density toggle** | More cards on screen |
| **Notification badges** | Open Calls across projects |
| **Audit export** (CSV/JSON of history) | Compliance / postmortems |

### P2 — scale / polish

| Item | Why |
|------|-----|
| Team/company tenancy | Multi-customer |
| SSE for Live | Replace 1.2s poll |
| Skill-based claim routing | Right agent, right work |
| Stale heartbeat SLAs | Ops reliability |
| Mobile layout pass | On-call from phone |

### Explicit non-goals (still)

- Full PM (sprints, story points, roadmaps)  
- Bundled agent runner  
- Two-way GitHub Projects kanban  
- Chat threads as Calls  

---

## Theme inventory (current)

| Id | Feel |
|----|------|
| `dark` | Default restrained near-black |
| `light` | Day ops |
| `cyberpunk` | Ice cyan + magenta ring |
| `matrix` | Digital rain green mono |
| `crt_green` | Green phosphor + scanlines |
| `crt_amber` | Amber phosphor + scanlines |

Status column colors remain distinct in every pack. CRT overlays respect `prefers-reduced-motion`.
