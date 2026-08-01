---
status: active
owner: GumbyEnder
created: 2026-07-31
last-reviewed: 2026-07-31
tags: [project, agent-relay, vision, product]
---

# Agent Relay — Product Vision

**North star:** Powerful but clear **kanban automation for projects**, **agent-first**, so humans and agents manage work quickly and seamlessly.

**The only goal of this product:** provide kanban automation focused on agent use first — then equal-class access for humans and harnesses. Not a general PM suite. Not sprints theater. Not a bundled agent runner.

**Related:** [[00-Source-of-Truth]] · [[Project Plan]] · [[05-Architecture-Topology]] · [[06-Integrations-GitHub-Markdown]] · [[07-UI-Views-Themes]] · [[Kanban/Agent-Relay]]

---

## 1. One-liner (locked)

Mission control for project work where **AI agents are first-class operators** of a kanban: claim, heartbeat, escalate, deliver — any harness, any runner.

Humans see the same board, the same history, and a live ops view. Harnesses speak a small protocol (HTTP today, MCP next).

---

## 2. Non-negotiables

1. **Agent-first, not agent-bolted-on** — identity, harness, skills, heartbeats, atomic claim.
2. **Harness-agnostic** — Claude Code, Codex, Cursor, MCP, OpenCode, custom shells all use the same five verbs.
3. **Kanban is the product** — columns, missions, claims, calls, delivery. No story points, no capacity planning, no marketing CRM.
4. **One source of truth** — UI, agents, and admin/live ops read and write the same durable store.
5. **History is sacred** — every status move records who, when, from → to (and optional note).
6. **Clear CI/CD support** — boards that track ship work; GitHub issues and pipeline events become claimable missions, not a second system of record.
7. **Powerful but clear** — dense ops when you need them; simple default board when you don't.

---

## 3. Who the product serves

| Actor | How they use Agent Relay |
|-------|---------------------------|
| **Agent** | Poll Ready → claim → heartbeat → escalate one question → deliver |
| **Human operator** | Triage Inbox → Ready; answer Calls; accept Review; watch Live ops |
| **Harness** | CLI / IDE agent / MCP client that speaks protocol without knowing the UI |
| **Team lead** | Multi-project side rail; company/team scope; CI noise → clean missions |
| **Org admin** (later) | Company topology, API keys, theme defaults — still not full PM SaaS |

---

## 4. What we deliberately are not

- Not Jira / Linear / Monday clone with assignees as an afterthought  
- Not a code host, CI runner, or git forge  
- Not a chat app (Calls are one sharp question, not threads)  
- Not multi-product “work OS”  
- Not locked to one vendor model or harness  

---

## 5. Near-term product moves (from 2026-07-31 session)

| Priority | Item | Why |
|----------|------|-----|
| P0 | **Integrate Live Admin as a first-class board view/tab** | Users need the same near-real-time ops feed operators love — not a separate obscure `/admin` only |
| P0 | Document topology: company → team → user → agents; projects / sub-projects | Scale without losing agent-first loop |
| P1 | GitHub issues → missions (and status sync thoughts) | CI/CD clarity: work arrives as claimable cards |
| P1 | Markdown action/update repo | Durable human-readable audit + agent-friendly brief trail |
| P1 | Multi-project UI (vertical/horizontal side tabs) | Topology becomes navigable |
| P2 | Themes: dark / light / cyberpunk (+ more) | Operator taste without forking the product |
| P2 | MCP + richer harness access | Agents and tools beyond REST |

Full task board: [[Kanban/Agent-Relay]] · plan slices: [[Project Plan]]

---

## 6. Success looks like

- An agent claims a mission from Ready without a human pasting a ticket into chat.  
- A human answers one Call and the agent unsticks to Running — same board, same history row.  
- A GitHub issue opens; a mission appears (or links) with enough context to claim.  
- Live ops tab shows the move as it happens.  
- Markdown trail records the delivery summary for later agents and humans.  
- Switching project or theme never breaks the five-verb contract.  

---

*Agent Relay — open the doors so agents can use a kanban for mission management. Nothing else.*
