# BeeZilla on its own service (stage 2 of the split)

Two products, one repo, one Postgres — for now two **services**. The console keeps
serving everything; the BeeZilla service serves only the consumer surface. The code
is already prepared for this: `BZ_SURFACE` says which job a process has.

| `BZ_SURFACE` | service | serves |
|---|---|---|
| `all` (default) | — | today's shape: one service, hostnames decide |
| `buzzy` | `beezilla-web` | `/buzzy/*`, `/api/buzzy/*`, `/api/auth/*`, capability endpoints, `/api/agent/health` **only**. A console path 404s. |
| `console` | `agent-relay` | everything else; `/buzzy/*` pages 301 to the product domain |

The decision is a pure function in `src/lib/product-surface.ts`, driven through 30
routes by `scripts/test-surface-routing.ts` (first thing after the boundary check in
`test:ci`). Nothing about this routing is verified by deploying and looking.

## Why the healthcheck matters

`railway.json` probes `/api/agent/health` on **every** service. That path lives in the
console's agent API, so the consumer service deliberately exempts it: refusing it would
mean a healthy BeeZilla service reports unhealthy and Railway rolls the deploy back.
It answers liveness, not board data. `HEALTH_PATHS` in `product-surface.ts`.

## Migrations: one owner, and a lock either way

`scripts/migrate.mjs` now takes a **Postgres advisory lock** before reading
`_migrations`. Two services booting together against one database would otherwise both
see a pending file and race — one wins, the other dies on a duplicate table and the
deploy is rolled back. The second process now blocks, then finds everything applied.

`BZ_SKIP_MIGRATIONS=1` is honoured for a service that must never touch schema. Either
set it on the consumer service, or leave migrations enabled on both and let the lock
serialise them — **pick one and write it down**, because "which service owns schema"
has to be answerable from the logs.

## Env slice for `beezilla-web`

Identical values to `agent-relay` unless noted. Copy them, do not retype them.

**Identity — must match the console exactly**

- `DATABASE_URL` — the same Postgres. Sessions live here.
- `BETTER_AUTH_SECRET` — same value, or a cookie set on one service is unreadable on
  the other.
- `BETTER_AUTH_URL=https://beezilla.net`
- `BETTER_AUTH_TRUSTED_ORIGINS=https://beezilla.net,https://www.beezilla.net`
- `BETTER_AUTH_ALLOWED_HOSTS=beezilla.net,www.beezilla.net`

**Product surface**

- `BZ_SURFACE=buzzy`
- `BZ_CONSUMER_HOSTS=beezilla.net,www.beezilla.net`
- `BZ_RUNTIME=cloud`
- (`BZ_MOVE_BUZZY` is **not** needed here — that flag only gates the console's 301.)

**BeeZilla capabilities** — `BZ_CHAT_KEY`, `BZ_CHAT_BASE_URL`, `BZ_CHAT_MODEL`,
`BZ_CHAT_MODELS`, `BZ_VOICE_MODEL`, `BZ_BRAVE_KEY`, `BZ_HYPERBROWSER_KEY`,
`BZ_ELEVEN_KEY`, `BZ_MESHY_KEY`, `BZ_HONCHO_URL`, `BZ_HONCHO_KEY`,
`BZ_HONCHO_WORKSPACE`, `BZ_OPS_KEY`, `BZ_MUSIC_GATEWAY_URL`, `BZ_INFERENCE_BASE_URL`

> `BZ_INFERENCE_SIGNING_KEY` **must be the same string on both services.** Capability
> tokens are minted here and verified by the console's gateways; a different key means
> every inference and music call 401s with a message that looks like an auth bug.

**Build-time (Dockerfile `prebuild`)**

- `BZ_PRIVATE_DEPLOY_KEY` (base64), `BZ_REQUIRE_PRIVATE=1`

**Mail**

- `RESEND_API_KEY` (or `SMTP_*`), `MAIL_FROM`, `MAIL_FROM_BEEZILLA`

**Not needed on this service** — `AGENT_RELAY_API_KEY`, `AGENT_RELAY_ADMIN_EMAILS`,
`AGENT_RELAY_LANE_AUTHORITY_EMAILS`, `AGENT_RELAY_DEV_MAIL`, `AGENT_RELAY_DEFAULT_ROLE`,
`ADMIN_PUBLIC_URL`, `DEVBOARDS_SURFACE`, `LANES_ENFORCE`. Leaving them off is the point
of the split; a console secret on the consumer service is exactly what stage 2 removes.

**Platform-provided** — `PORT`, `HOST=0.0.0.0`, `NITRO_HOST=0.0.0.0`, `NODE_ENV=production`.

## Cutover

```bash
export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH
cd ~/agents/agent-relay-recipes

# 1. service from the same repo, same Dockerfile
railway add --service beezilla-web --repo GumbyEnder/agent-relay --branch main

# 2. env slice (loop over the list above; never re-key a secret by hand)
railway variables --service beezilla-web --set "BZ_SURFACE=buzzy" ...

# 3. deploy and verify ON THE RAILWAY HOSTNAME FIRST — before any DNS moves
railway deployment list --service beezilla-web --json
curl -s -o /dev/null -w '%{http_code}\n' https://beezilla-web-production.up.railway.app/buzzy/talk   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://beezilla-web-production.up.railway.app/api/agent/health # 200
curl -s -o /dev/null -w '%{http_code}\n' https://beezilla-web-production.up.railway.app/boards         # 404

# 4. move the domain (this is the cutover; DNS may need the new target)
railway domain --service beezilla-web        # add beezilla.net + www.beezilla.net
railway domain --service agent-relay --remove beezilla.net ...
```

Verify after the move, with the same three URLs on the real host, plus a console path
on the consumer domain (`https://beezilla.net/boards` → 302 to `/buzzy/talk`) and a
Buzzy page on the console domain (`https://app.devboards.ai/buzzy/talk` → 301 to
beezilla.net).

## Rollback

Delete the custom domains from `beezilla-web`, re-attach them to `agent-relay` (which
still runs with `BZ_SURFACE=all` and serves both products), and stop the new service.
The database never changed hands, so there is nothing to restore.

## Not in scope for stage 2

The repo is still one repository, one Dockerfile and one Postgres; `src/lib/buzzy/public.ts`
is the single door the console may call through, and stage 3 copies that directory out.
Identity is the gate on stage 3 — one `users` row per account, ~491 user references
inside BeeZilla.
