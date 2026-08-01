---
status: active
owner: GumbyEnder
created: 2026-07-31
last-reviewed: 2026-07-31
tags: [project, agent-relay, architecture, topology]
---

# Agent Relay — Topology & Multi-tenancy

**Parent:** [[04-Product-Vision]]  
**Status:** Design intent (not fully implemented). Current production is single-board durable Postgres.

---

## 1. Guiding rule

Topology exists to **scope boards and credentials**, not to invent a second product.

Every leaf still exposes:

```
Inbox → Ready → Running → Needs Human → Review → Done (+ Blocked)
poll · claim · heartbeat · escalate · deliver
```

---

## 2. Recommended hierarchy

```
Company
  └── Team
        └── User (human operator)
        └── Agent (first-class identity)
        └── Project
              └── Sub-project (optional board or filtered lane set)
                    └── Missions (cards)
```

| Entity | Role | Notes |
|--------|------|--------|
| **Company** | Billing / isolation boundary | API keys, SSO later, default themes |
| **Team** | Shared work + shared agent fleet | Agents can be team-scoped or project-scoped |
| **User** | Human operator | Sees Calls, can move/triage; not the same as agent claimer |
| **Agent** | Automated worker identity | `name`, harness, skills, status, heartbeats, API key |
| **Project** | One primary kanban surface | Has columns + mission set + integrations |
| **Sub-project** | Nested focus | Prefer **child board** or **label/lane filter** on parent — avoid infinite nesting |

### Design recommendation (opinionated)

- **Max depth for boards:** Company → Team → Project → (optional Sub-project board).  
- Sub-projects as **full boards** when isolation matters (different agents, different GitHub repos).  
- Sub-projects as **filters/tags** when it's the same fleet and same repo.  
- Agents belong to **Team** by default; can be granted to specific Projects.  
- Users belong to Teams; permissions later (for now: open operator UI).

---

## 3. Data model sketch (future)

```
companies (id, name, slug, settings)
teams (id, company_id, name, slug)
users (id, company_id, …)          -- later auth
team_members (team_id, user_id, role)
agents (id, team_id?, project_id?, name, harness, skills, api_key_hash, status)
projects (id, team_id, parent_project_id null|id, name, slug, settings)
missions (… existing fields …, project_id)
mission_history (… existing …, project_id denorm optional)
events (… existing …, project_id)
calls (… existing …, project_id)
integrations (id, project_id, kind: github|…, config)
```

**Invariant:** `claim` remains atomic **per mission** (and thus per project board). No cross-board double-claim of the same work item without an explicit link record.

---

## 4. Access model (agents, humans, harnesses)

| Surface | Auth (direction) | Purpose |
|---------|------------------|---------|
| **Operator UI** | Session later; open/same-origin now | Board, Live tab, Calls, themes |
| **Agent HTTP API** | Per-agent or project API key | Five verbs + poll |
| **MCP** | Same keys / OAuth-lite later | Tools = verbs |
| **Harness copy-paste** | None | Markdown mission brief offline |
| **Admin/Live ops** | Same as operator UI | First-class tab, not secret URL forever |
| **Webhooks in** | Signed secrets | GitHub, CI |
| **Webhooks out** | Optional | Notify harness on human reply |

### Principles

1. **Agents never use human passwords** — API keys / MCP tokens only.  
2. **Humans never need to speak JSON** — but can.  
3. **Harnesses are not users** — a harness is how an agent runs; the agent identity is what claims.  
4. **Least scope keys** — project-scoped keys beat company-wide god keys.  
5. **Audit everything** that changes column or claim (already started with `ar_mission_history`).

---

## 5. Multi-project navigation (UI)

User preference: **vertical or horizontal side tabs** for projects / multi-project views. Open to better patterns.

### Recommended UX

| Pattern | Use when |
|---------|----------|
| **Left vertical project rail** (default desktop) | Many projects; pin favorites; nested sub-projects as tree |
| **Top horizontal project tabs** | Few active projects (≤7); mobile-friendly strip |
| **Command palette** (`⌘K`) | Jump project / mission / agent by name |
| **Live tab** inside project | Ops stream + status history (today’s `/admin` integrated) |
| **Board tab** | Classic kanban |
| **Optional split** | Board left, Live right — power users |

**Do not** open a separate product for multi-project. Rail + tabs on the same shell.

---

## 6. Implementation phases (topology)

1. **Now:** single project board (production). Live view as `/admin` → integrate as tab.  
2. **v0.3:** `project_id` on all board rows; project switcher; keys scoped to project.  
3. **v0.4:** teams + agent membership; sub-project as child board or filter.  
4. **v0.5:** company boundary + multi-tenant auth.  

Never ship topology that breaks the five-verb cache-stable protocol for agents mid-mission.
