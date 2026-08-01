---
status: active
owner: GumbyEnder
created: 2026-07-31
last-reviewed: 2026-07-31
tags: [project, agent-relay, ui, themes, ux]
---

# Agent Relay — UI Views & Themes

**Parent:** [[04-Product-Vision]]  
**Current:** Dark board at `/` · Live admin at `/admin` (to be integrated as tab)

---

## 1. Shell concept

One **app shell** per session:

```
┌──────────┬────────────────────────────────────────────┐
│ Projects │  [Board] [Live] [Calls] [Agents] [Protocol] │
│  rail    │                                            │
│          │           active view                      │
│ Company  │                                            │
│  Team    │                                            │
│  ▸ Proj  │                                            │
│    sub   │                                            │
└──────────┴────────────────────────────────────────────┘
```

- **Left rail (vertical):** company/team/projects (collapsible; horizontal tabs alternative on small screens).  
- **Top view tabs:** Board · **Live** · Calls · Agents · Protocol (extensible).  
- **⌘K:** jump anything.  

---

## 2. Views (numerous, purposeful)

| View | Job | Notes |
|------|-----|--------|
| **Board** | Classic kanban columns | Default; drag/drop; claim actions |
| **Live** | Near-real-time ops + status history | Promote today’s `/admin` here — **user-facing** |
| **Calls** | Human queue only | Scarce, sharp questions |
| **Agents** | Roster, harness, status, keys (later) | First-class agents |
| **Protocol** | Five verbs docs + copy JSON | Onboarding harnesses |
| **Mission** | Side panel / full page brief + history | Deep dive |
| **Projects** | Multi-project overview cards | Counts by column, open calls |
| **Journal** (later) | Browse markdown trail | Read-only projection |
| **Integrations** (later) | GitHub app status | Project settings |

### Live view (must integrate)

Users should not hunt `/admin`. **Live** is how you *feel* the board moving:

- Ops stream (events)  
- Status moves (actor, from → to, when)  
- Open calls  
- Agent presence  
- Column stats  
- ~1s poll or SSE later  

**TODO:** integrate as tab on kanban shell (tracked on [[Kanban/Agent-Relay]]).

---

## 3. Multi-project UI options

| Option | Pros | Cons |
|--------|------|------|
| **Vertical left tabs/rail** | Scales; nested projects; pin | Horizontal space |
| **Horizontal top tabs** | Familiar; simple | Crowds with many projects |
| **Hybrid** | Rail for tree, top for recent | Slightly more chrome |
| **Spotlight only** | Minimal | Weak situational awareness |

**Recommendation:** Hybrid — **vertical rail for topology**, **top tabs for views inside the selected project**, optional “recents” horizontal chips.

---

## 4. Themes

Ship **theme packs** as data (CSS variables), not forks.

| Theme | Intent |
|-------|--------|
| **Dark** (default) | Current restrained near-black |
| **Light** | Daytime ops; same structure |
| **Cyberpunk** | Neon accents, mono-heavy — still readable, not slop purple rain |
| **Mono** | Grayscale, print-friendly density |
| **High contrast** | A11y |

### Rules

- Themes change **tokens** (`--color-bg`, status colors, radii, fonts).  
- No theme may hide status meaning (Ready/Running/Human must stay distinguishable).  
- Prefer `data-theme="cyberpunk"` on `<html>`.  
- User preference in `localStorage` + later account setting.  
- Agent-facing API and markdown journal stay theme-agnostic.

### Cyberpunk note

“Cyberpunk mode” should feel intentional: dim panels, sharp borders, one accent (e.g. ice cyan or amber), terminal-like mono for IDs — **not** generic AI purple gradient.

---

## 5. Density & responsiveness

- **Comfortable** default; **Compact** toggle for operators.  
- Mobile: Board horizontal scroll; Live as primary alternate tab; rail becomes bottom sheet or select.  
- Keep `/admin` as redirect to `?view=live` or `/live` for bookmarks.

---

## 6. Implementation order

1. View tab state in shell (`board | live | calls | agents | protocol`).  
2. Mount existing AdminPortal as **Live** tab (share components).  
3. Project rail stub (single project selected).  
4. Theme switcher + light + cyberpunk tokens.  
5. Multi-project data when topology lands.
