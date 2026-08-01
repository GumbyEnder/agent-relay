# Getting started — you + your agents

No Grok broker. No Better Auth “account.” No Railway auth product.

## What you need

1. **Postgres** (local Docker or Railway Postgres) → `DATABASE_URL`
2. **This app** running (`./startup.sh` or Railway)
3. **Your browser** for the human UI
4. **API keys** for each agent/harness

---

## A. Run locally (human sign-in)

```bash
cd ~/agents/agent-relay

# Postgres (once)
docker start agent-relay-pg 2>/dev/null || \
  docker run -d --name agent-relay-pg \
    -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay -e POSTGRES_DB=agent_relay \
    -p 55432:5432 postgres:16-alpine

export DATABASE_URL="postgresql://relay:relay@127.0.0.1:55432/agent_relay"
# Make yourself admin after you pick an email:
export AGENT_RELAY_ADMIN_EMAILS="you@example.com"

npm run build
./startup.sh
```

1. Open **http://127.0.0.1:8090/login**
2. **Create account** (email + password, 8+ chars)
3. You’re on the board as **admin** (if your email is in `AGENT_RELAY_ADMIN_EMAILS`; otherwise default role is operator — set the env and restart to promote)
4. Explore Board / Live / Calls / Agents

Sign-in is **email/password stored in your Postgres**. Nothing external.

---

## B. Plug in agents

1. UI → **Agents** tab → **Create key** (copy the `ark_…` secret once)
2. From any harness:

```bash
export AR_URL="http://127.0.0.1:8090"
export AR_KEY="ark_…"   # the secret you copied

curl -sS -H "Authorization: Bearer $AR_KEY" \
  "$AR_URL/api/agent/missions?column=ready&limit=5&agent=my-bot"
```

Five verbs: poll → claim → heartbeat → escalate → deliver  
(see `docs/PROTOCOL.md` / Protocol tab in the UI)

MCP: `npm run mcp` (stdio tools map 1:1 to the verbs).

---

## C. Railway (same idea)

| Env | Value |
|-----|--------|
| `DATABASE_URL` | From Railway Postgres plugin |
| `BETTER_AUTH_URL` | `https://your-service.up.railway.app` |
| `BETTER_AUTH_SECRET` | Long random string |
| `AGENT_RELAY_ADMIN_EMAILS` | Your email |
| `AGENT_RELAY_API_KEY` | Optional global agent key |

Deploy → open `/login` → create account → create agent keys.

---

## What you can ignore

- **Grok auth broker / deployer** — leftover template path; not required
- **Better Auth SaaS** — doesn’t exist; it’s a library in the app
- **Railway “Auth” marketplace** — not used

---

## Roles (short)

| Role | Can |
|------|-----|
| viewer | Read board / Live |
| operator | Move cards, reply to Calls |
| admin | Keys, GitHub settings, reset |

Default signed-in role: `operator` (`AGENT_RELAY_DEFAULT_ROLE`). Admins via `AGENT_RELAY_ADMIN_EMAILS`.
