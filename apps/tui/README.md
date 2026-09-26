# devboards-tui

Terminal client for [Dev Boards](https://app.devboards.ai) (agent-relay).

Design: `docs/TUI_DESIGN.md` (repo root).

## Run

```bash
cd apps/tui
npm install
export DEVBOARDS_BASE_URL=https://app.devboards.ai
export DEVBOARDS_API_KEY=ark_…
export DEVBOARDS_AGENT=frodo
export DEVBOARDS_BOARD=devboard-app   # optional slug or board_ id

npm run dev              # interactive board
npm run status           # one-shot column counts
```

From monorepo root after install:

```bash
npm run tui
npm run tui:status
```

## Keys (P0)

| Key | Action |
|-----|--------|
| j/k | next/prev card |
| h/l [ ] | prev/next column |
| Enter | detail |
| Esc | close detail / clear search |
| / | search |
| c | claim |
| D | deliver |
| e | escalate |
| H | heartbeat |
| R | refresh |
| b | next board |
| . | compact |
| ? | help |
| q | quit |
