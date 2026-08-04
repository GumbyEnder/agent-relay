# Roadmap & versioning (0.x)

Dev Boards is **open-core oriented**: the board protocol and self-host path are the product. Hosted multi-tenant convenience is a separate layer.

## Branch policy (for users)

**You do not need a special working branch.**

| You want… | Do this |
|-----------|---------|
| Run / self-host | Clone **`main`** or pin a **`v0.x.y` tag** |
| Contribute | Branch from `main`, open a PR |
| Track “what’s next” | This file + GitHub issues/discussions |

Maintainers may use private or feature branches for hosted experiments. Those are not the user-facing default.

## Stability promises (honest 0.x)

| Surface | Expectation |
|---------|-------------|
| Five verbs (poll, claim, heartbeat, escalate, deliver) | **Intent-stable** — semantics should not silently invert |
| HTTP paths under `/api/agent` | Additive preferred; renames get a changelog entry |
| Claim concurrency (409 if taken) | Hard invariant |
| JSON field names | May gain fields; removals are breaking |
| Storage schema | Migrations forward; pin a tag before upgrading prod |
| Operator UI chrome | May change freely |
| Optional OAuth / SaaS admin | **Not** part of the core contract |

Breaking changes before **1.0** are allowed with a `CHANGELOG` note and a minor bump (e.g. `0.3` → `0.4`).

## What is core (OSS)

- Mission board + columns
- Agent HTTP API + optional global key / `ark_` keys
- Heartbeats, Calls (escalate), deliver
- Operator UI for a single deployment
- PGLite demo + Postgres production
- MCP / harness docs

## What is edge / later

- GitHub / Google (or other) **human** OAuth polish
- Hosted multi-tenant billing and isolation productization
- GitHub App one-click install UX
- Deep two-way GitHub Projects sync
- Formal 1.0 protocol freeze

## Suggested public labels (GitHub)

Create when the repo is public:

| Label | Meaning |
|-------|---------|
| `core` | Protocol, claim, store, agent API |
| `self-host` | Docker, env, migrations, ops |
| `ui` | Operator board chrome |
| `auth-optional` | Human login / OAuth — not blocking core |
| `hosted` | SaaS-only concerns |
| `good first issue` | Small, well-scoped |
| `breaking` | Needs changelog + version discussion |

## Near-term OSS checklist

- [x] MIT license, SECURITY, CONTRIBUTING, CoC
- [x] Core-first README + SELF_HOST + `.env.example`
- [x] Docker Compose + Dockerfile
- [x] Version / changelog baseline (`0.3.0`)
- [ ] Public repo settings: discussions, security advisories, labels above
- [ ] First annotated tag `v0.3.0` after a green `npm run test:engine`
- [ ] Hosted beta messaging (separate from self-host docs)
- [ ] Re-enable Google login UI when OAuth apps are ready (optional)

## Hosted product (future)

Charge for convenience, not for the verbs:

- Managed Postgres, backups, uptime
- Multi-operator / multi-tenant isolation
- Support and SSO later

Self-host remains first-class so the community can trust the core.
