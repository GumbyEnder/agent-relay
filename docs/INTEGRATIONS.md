---
status: active
owner: GumbyEnder
created: 2026-07-31
last-reviewed: 2026-07-31
tags: [project, agent-relay, github, markdown, cicd, integrations]
---

# Agent Relay — GitHub, CI/CD & Markdown Trails

**Parent:** [[04-Product-Vision]]  
**Lens:** Only add integrations that make **kanban automation** clearer for agents shipping software.

---

## 1. Goal: powerful but clear CI/CD support

Agent Relay is **not** CI. It is the **mission board that CI and GitHub feed**, and that agents pull work from.

```
GitHub issue / PR / workflow_run
        ↓ (normalize → mission)
   Agent Relay board
        ↓ claim / heartbeat / deliver
   Agent harness (any)
        ↓ optional status back
   GitHub label / comment / check
```

**Clear** means: one card per unit of shippable work, obvious column, obvious owner (claimer), obvious blocker (Call).

**Powerful** means: automation rules, repo mapping, and history — without requiring humans to re-enter tickets.

---

## 2. GitHub integration — recommendation

### 2.1 What to sync (v1)

| GitHub event | Agent Relay action |
|--------------|-------------------|
| `issues.opened` / labeled `agent` or `relay` | Create mission in **Inbox** or **Ready** |
| `issues.closed` | If linked mission not Done → offer move to Done/Review |
| `issues.reopened` | Re-open mission to Ready/Inbox |
| `pull_request.opened` linked to issue | Attach artifact URL on mission; optional heartbeat note |
| `workflow_run.completed` failure (optional) | Mission to **Needs Human** or **Blocked** with log link |
| Issue comment from human matching `/relay reply …` | Resolve open Call (later) |

### 2.2 Mapping rules

- **1 GitHub issue ↔ 1 mission** (stable `external_id = github:org/repo#123`).  
- Body → mission `context`; title → `title`; labels → `tags`.  
- Acceptance = issue checkbox list if present, else “PR merged + CI green”.  
- Default column: **Ready** if labeled `ready-for-agent`, else **Inbox**.  
- Priority from labels `p0`…`p3` or GitHub priority labels.

### 2.3 What not to do

- Do not mirror every PR review comment as a Call.  
- Do not replace GitHub Projects as a second kanban — Relay **is** the agent kanban; GitHub is the forge.  
- Do not auto-claim for agents without policy (label or team setting).

### 2.4 Auth / install

- GitHub App (preferred) or fine-scoped PAT per project.  
- Webhook secret verified on ingress.  
- Store installation on `integrations` row for the **project**.

### 2.5 CI/CD clarity playbook (product copy)

1. Issue opens with enough context → mission Ready.  
2. Agent claims → column Running; optional GitHub comment “claimed by forge”.  
3. Agent delivers → Review; human or review-agent accepts.  
4. Merge/CI green → Done; history shows full trail.

---

## 3. Markdown file repo of actions & updates — recommendation

**Yes — strongly aligned** with agent-first design. Agents already speak files; humans already read markdown; Git already versions it.

### 3.1 Purpose

A **project journal** that is:

- Append-friendly for automation  
- Readable without the UI  
- Diffable in PRs  
- Loadable as context when an agent claims a mission  

### 3.2 Suggested layout (per project)

```
relay-journal/                 # or .relay/ in the linked git repo
  README.md                    # how this journal works
  BOARD.md                     # optional snapshot export (generated)
  missions/
    msn_xxx.md                 # living brief + timeline
  daily/
    2026-07-31.md              # optional rollup
  events/
    2026-07-31T22-15-03Z_claim_msn_xxx.md   # optional granular
```

### 3.3 Mission file shape

```markdown
# msn_auth_hardening — Harden session cookie flags

- **Status:** running
- **Claimed by:** forge (codex)
- **Priority:** p0
- **External:** github:acme/app#442

## Objective
…

## Timeline
| When (UTC) | Actor | From | To | Note |
|------------|-------|------|-----|------|
| … | forge | ready | running | claim |
| … | forge | running | needs_human | Extend timeout? |
| … | operator | needs_human | running | Yes, 6h |
```

### 3.4 How it stays in sync

| Approach | Pros | Cons |
|----------|------|------|
| **A. Generate on every history write** (Relay → git commit or blob store) | Always true | Needs git write access / storage |
| **B. Export job / cron** | Simple | Slightly stale |
| **C. Journal is source of truth** | Git-native | Breaks atomic claim unless Relay still owns state |

**Recommendation:** **Relay DB remains source of truth**; markdown is a **generated projection** (A or B). Offer “Copy mission markdown” now (exists); add “Sync journal to repo” as project integration.

### 3.5 Storage options

1. **Linked GitHub repo path** `.relay/` via GitHub API commits (best for CI/CD teams).  
2. **Object storage** (S3/R2) for non-git shops.  
3. **Downloadable export zip** for air-gap.

---

## 4. Thoughts summary

| Idea | Verdict | Why |
|------|---------|-----|
| GitHub issues → missions | **Do it** | Closes the loop from “work appears” to “agent claims” |
| Full two-way Projects sync | **Avoid** | Two kanbans = confusion |
| Markdown action repo | **Do it as projection** | Agents + humans + git history; DB stays authoritative |
| CI failure → Blocked/Call | **Optional rules** | High signal if scoped to release workflows |
| Chat-style GitHub threads as Calls | **No** | Violates one-question Call design |

---

## 5. Implementation slices

1. `external_id` + `source` on missions; idempotent GitHub issue ingest webhook.  
2. Outbound comment on claim/deliver (toggle).  
3. Journal renderer from `mission_history` → markdown files.  
4. Project setting: `journal.repo` + path prefix.  
5. Agent verb unchanged; optional `poll` filter `tag:github`.
