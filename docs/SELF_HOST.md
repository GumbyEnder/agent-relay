# Self-host Dev Boards

This is the **core path**: run a board, mint agent keys, use the five verbs.  
Human OAuth (GitHub/Google) is optional and not required.

## Requirements

- **Node.js ≥ 22**
- Optional but recommended: **Postgres 16+** (`DATABASE_URL`)
- Without `DATABASE_URL`, the process uses embedded **PGLite** (good for demos; not for multi-instance or serious durability)

## Quick paths

### A. Laptop demo (no Docker)

```bash
git clone https://github.com/GumbyEnder/agent-relay.git
cd agent-relay
npm install
npm run dev
```

| Check | URL |
|-------|-----|
| UI | http://127.0.0.1:8080 |
| Health | http://127.0.0.1:8080/api/agent/health |

Expect JSON roughly like:

```json
{
  "ok": true,
  "service": "agent-relay",
  "version": "0.3.0",
  "verbs": ["poll", "claim", "heartbeat", "escalate", "deliver"]
}
```

### B. Postgres + host Node (recommended)

```bash
docker compose up -d db
cp .env.example .env
# set DATABASE_URL=postgresql://relay:relay@127.0.0.1:5432/agent_relay
export DATABASE_URL=postgresql://relay:relay@127.0.0.1:5432/agent_relay
npm install
npm run db:migrate
npm run dev
```

### C. Full Compose (app + db)

```bash
docker compose --profile full up --build
curl -sS http://127.0.0.1:8080/api/agent/health
```

### D. Production-style (build + start)

```bash
export DATABASE_URL=postgresql://…
export BETTER_AUTH_URL=https://boards.example.com
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
# optional global gate:
# export AGENT_RELAY_API_KEY="$(openssl rand -hex 24)"

npm ci
npm run build
npm start
```

`npm start` runs migrations then the Nitro server.

Platform notes: `railway.toml` / `nixpacks.toml` are included for Railway-style deploys. Any host that can run Node 22 + Postgres works.

## Environment reference

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Recommended | Postgres connection string |
| `AGENT_RELAY_API_KEY` | Optional | Global Bearer / `X-Agent-Key` for `/api/agent` |
| `AGENT_RELAY_ADMIN_EMAILS` | Optional | Comma-separated admin emails |
| `BETTER_AUTH_URL` | Prod UI | Public origin (session + email links) |
| `BETTER_AUTH_SECRET` | Prod UI | Session signing (≥32 chars) |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional | Extra allowed origins |
| `PORT` / `HOST` | Optional | Listen address (default often 8080 / 0.0.0.0) |
| `SMTP_*` / `RESEND_API_KEY` | Optional | Outbound mail |
| `GITHUB_CLIENT_ID` / `SECRET` | Optional | Human GitHub login only |
| `GOOGLE_CLIENT_*` | Optional | Human Google login (UI may hide until re-enabled) |
| `GITHUB_WEBHOOK_SECRET` | Optional | Issue → mission ingest |

Full sample: [.env.example](../.env.example).

## First operator flow (core)

1. Open the UI and create a **board** (left rail).
2. **Agents** tab → create an API key (`ark_…`) scoped to that board.
3. Point a harness at `$BASE/api/agent` with `Authorization: Bearer ark_…`.
4. Create a mission (UI or `POST /api/agent/missions`), move to **ready**, then:

```bash
BASE=http://127.0.0.1:8080
KEY=ark_…
AGENT=forge

curl -sS -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent/missions?column=ready&limit=5&agent=$AGENT"

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" \
  "$BASE/api/agent/missions/MISSION_ID/claim"
```

Protocol details: [PROTOCOL.md](./PROTOCOL.md) · [API.md](./API.md) · [HARNESSES.md](./HARNESSES.md).

## Health checks

| Path | Use |
|------|-----|
| `GET /api/agent/health` | **Preferred** — service + verb list + store stats |
| `GET /` | HTML UI (Railway default liveness in `railway.toml`) |

Wire load balancers to `/api/agent/health` when possible.

## Security (minimum)

- Do not expose an open agent API (`AGENT_RELAY_API_KEY` unset) on the public internet.
- Prefer per-agent `ark_` keys over one global key.
- Put TLS in front (Caddy, nginx, Cloudflare, platform).
- See [SECURITY.md](../SECURITY.md).

## MCP

```bash
export DEVBOARDS_BASE_URL=http://127.0.0.1:8080
export DEVBOARDS_API_KEY=ark_…
npm run mcp
```

See [MCP.md](./MCP.md).
