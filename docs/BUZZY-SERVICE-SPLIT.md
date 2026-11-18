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

`BZ_SKIP_MIGRATIONS=1` is honoured for a service that must never touch schema.

**Decision (2026-11-17): migrations stay enabled on both services, and the advisory
lock serialises them.** Neither service is special, so either can boot first and a
deploy of a migration does not have to be sequenced by hand. What that buys in
simplicity it gives up in "one owner" clarity, so the answer to *"which service owns
schema?"* is the log line, not a convention: `[migrate] applied …` on whichever booted
first, `[migrate] up to date.` or `[migrate] waited Nms …` on the other. If that ever
becomes confusing, set `BZ_SKIP_MIGRATIONS=1` on `beezilla-web` — the consumer service
has no reason to own schema.

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

## Status 2026-11-17T19:44Z — service is up, traffic is NOT moved yet

`beezilla-web` exists, is linked to `GumbyEnder/agent-relay@main`, and is deployed at
`a5898f8` with the env slice below. Verified on its own Railway hostname
(`beezilla-web-production.up.railway.app`), which is the only place the cutover can be
tested safely:

| request | result |
|---|---|
| `/buzzy/talk` | 200 |
| `/api/buzzy/privacy` | 401 `signed_out` (real route, real Postgres) |
| `/api/agent/health` | 200 (railway.json's healthcheck) |
| `/boards` | 404 `{"code":"wrong_surface"}` |
| `/api/agent/boards`, `/admin`, `/api/agent/keys` | 404 |
| `/` on the railway hostname | 404 (the consumer front door is beezilla.net) |
| boot log | `[migrate] up to date.` — shared Postgres, advisory lock, nothing re-applied |

**Both services currently serve; beezilla.net still points at `agent-relay`**, so
consumer traffic is unchanged. The remaining step is the domain move, and it needs a DNS
edit because each Railway custom domain carries its own CNAME target:

- now: `beezilla.net` → `d7v851h1.up.railway.app`, `www` → `uvvrhnw8.up.railway.app`
- after the move Railway issues a new target per domain, so the registrar/Cloudflare
  records must be updated before traffic follows.

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
