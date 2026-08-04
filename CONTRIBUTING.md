# Contributing to Dev Boards

Thanks for helping. This project is **agent-first mission kanban**: durable boards, five verbs, and harness-friendly HTTP/MCP. Human login and OAuth are optional edges — the core is the board + agent API.

## Branch strategy (maintainers & contributors)

| Branch | Purpose |
|--------|---------|
| **`main`** | Public default. What self-hosters and CI should track. Keep it runnable. |
| **feature / fix branches** | Short-lived work. Open a PR into `main`. |
| **No required “working branch”** | End users clone or pin a **tag** (`v0.3.0`). They do not need a special branch. |

Optional later: a `develop` integration branch if `main` must stay calmer. Not required for launch.

**Hosted / SaaS-only experiments** can live in private forks or clearly labeled branches; do not break core protocol on `main` for cloud-only features.

## What we want

- Bug fixes with a clear repro
- Protocol / API clarity and tests (`npm run test:engine`)
- Self-host docs and Docker/compose improvements
- Harness adapters and client examples (Hermes, MCP, curl)
- Small, focused PRs

## What to avoid (for now)

- New required auth providers in the happy path
- Cloud-only multi-tenant features that break single-node self-host
- Drive-by dependency upgrades without a reason
- Expanding scope beyond “agents move work on a board”

## Dev setup

```bash
git clone https://github.com/GumbyEnder/agent-relay.git
cd agent-relay
npm install
npm run dev          # http://127.0.0.1:8080 — PGLite if no DATABASE_URL
```

With Postgres (recommended for anything serious):

```bash
docker compose up -d db
export DATABASE_URL=postgresql://relay:relay@127.0.0.1:5432/agent_relay
npm run db:migrate
npm run dev
```

See [docs/SELF_HOST.md](docs/SELF_HOST.md) and [.env.example](.env.example).

## Checks before a PR

```bash
npm run typecheck
npm run test:engine
# optional: npm run build && npm start && npm run test:api
```

## Protocol stability

- Agent HTTP surface: `/api/agent` — see [docs/PROTOCOL.md](docs/PROTOCOL.md) and [docs/API.md](docs/API.md)
- Breaking changes to verbs or claim semantics need a clear note in `CHANGELOG.md` and a minor/major bump discussion while we are on **0.x**
- Prefer additive fields and new optional query params over renaming core JSON

## Commit / PR hygiene

- One concern per PR
- Describe *user-visible* behavior
- Link issues when relevant
- Do not commit secrets, `.env`, or personal Railway/NAS paths

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
