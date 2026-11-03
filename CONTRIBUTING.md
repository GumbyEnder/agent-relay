# Contributing to Dev Boards & BeeZilla

Thanks for helping. This project is **agent-first mission kanban**: durable boards, five verbs, and harness-friendly HTTP/MCP. Human login and OAuth are optional edges — the core is the board + agent API.

## Two products, one engine

This repository ships two things on top of the same board engine:

| Surface | What it is | Entry points |
|---------|-----------|--------------|
| **Dev Boards** | Agent-first mission kanban. Durable boards, five verbs, harness-friendly HTTP/MCP. | `src/lib/agent/`, `/api/agent`, operator UI |
| **BeeZilla** | Consumer journey layer on the same engine — documents, memory, recipes, chat. | `src/lib/buzzy/`, `/buzzy/*`, `apps/` |

Know which one your change belongs to before you open the PR; the template asks. Changes to the shared engine affect both — say so.

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
- BeeZilla journey fixes — documents, memory, recipes, chat surfaces
- Small, focused PRs

Look for `good first issue`: each one names the file, the expected outcome, and the command that proves it works. No permission needed to start — comment that you are taking it.

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

One command runs everything CI runs:

```bash
npm run verify     # typecheck + build + hermetic tests
```

Or step by step:

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint — warnings OK, avoid new errors
npm run build      # vite build
npm run test:ci    # the hermetic suite CI gates on
```

`test:ci` is the subset that needs no browser and no provider keys. Browser and live-key suites exist (`npm run test:api`, `npm run test:buzzy-jobs`) — run them when your change touches those paths, but CI does not.

Node 22+ is required (`engines` in `package.json`).

## Protocol stability

- Agent HTTP surface: `/api/agent` — see [docs/PROTOCOL.md](docs/PROTOCOL.md) and [docs/API.md](docs/API.md)
- Breaking changes to verbs or claim semantics need a clear note in `CHANGELOG.md` and a minor/major bump discussion while we are on **0.x**
- Prefer additive fields and new optional query params over renaming core JSON

## Commit / PR hygiene

- One concern per PR
- Describe *user-visible* behavior
- Link issues when relevant
- Do not commit secrets, `.env`, or personal Railway/NAS paths

## How review works

1. **CI runs automatically** on every PR (`ci / verify`: typecheck, lint errors, build, hermetic tests). A red run is the first thing to fix — you do not need to wait for a human.
2. **A maintainer reviews** once CI is green. Expect a first response within **5 working days**; small focused PRs get looked at sooner. If a week passes with no response, comment on the PR — that is a nudge, not a demand.
3. **Feedback is about the change**, not you. "This breaks claim safety for concurrent agents" is the kind of note to expect on protocol-touching work.
4. **Squash merge** into `main`; your branch is deleted. Your commit stays attributed to you.
5. **Stale PRs** (no activity for 30 days after review feedback) may be closed with a note. Reopen or re-request when you are ready — nothing is lost.

You do not need an invitation or a special branch to contribute. Fork or branch from `main`, open a PR against `main`.

## Where to ask

- **Questions, ideas, "is this wanted?"** → [Discussions](https://github.com/GumbyEnder/agent-relay/discussions), before writing code.
- **Reproducible bug** → issue using the bug template.
- **Security problem** → private advisory only, per [SECURITY.md](SECURITY.md). Never a public issue.
- **Conduct concern** → see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); report privately to the maintainer rather than in a thread.

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
