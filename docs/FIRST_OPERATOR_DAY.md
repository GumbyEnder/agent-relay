---
status: active
owner: GumbyEnder
created: 2026-08-01
tags: [project, agent-relay, ops, railway, auth, github]
---

# First operator day — Railway / production checklist

**Parent:** [[ACCESS]] · [[AUTH_AND_ROADMAP]]

This is the short path from zero to a multi-operator board with agents and GitHub ingest.

---

## 1. Required environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | **Yes** (prod) | Postgres connection string (Railway Postgres plugin) |
| `PORT` / `HOST` | Usually set by platform | Listen bind; start uses `0.0.0.0` |
| `AGENT_RELAY_API_KEY` | Recommended | Global fallback Bearer for agents if no scoped keys yet |
| `BETTER_AUTH_SECRET` | **Yes** when human auth on | Session signing secret (long random) |
| `BETTER_AUTH_URL` | **Yes** to enforce human login | Public origin, e.g. `https://your-app.up.railway.app`. Setting this turns on session gates (with broker client). Without it, local/demo stays open as admin. |
| `GROK_AUTH_ISSUER` | With federated login | Auth broker base (template default / deployer inject) |
| `GROK_AUTH_CLIENT_ID` / `GROK_AUTH_CLIENT_SECRET` | With federated login | Per-app OAuth client at the broker |
| `VITE_AUTH_ENABLED` | Optional | Default on. Set `false` only for trusted local/demo open UI |
| `AGENT_RELAY_HUMAN_AUTH` | Optional | `1`/`0` force human session gates on/off (defaults to auth configured) |
| `AGENT_RELAY_ADMIN_EMAILS` | Recommended | Comma-separated emails → `admin` |
| `AGENT_RELAY_OPERATOR_EMAILS` | Optional | → `operator` |
| `AGENT_RELAY_VIEWER_EMAILS` | Optional | → `viewer` |
| `AGENT_RELAY_DEFAULT_ROLE` | Optional | Default signed-in role (`operator` if unset) |
| `GITHUB_WEBHOOK_SECRET` | Optional global | Fallback HMAC secret if project setting empty |
| `AGENT_RELAY_STALE_HEARTBEAT_MS` | Optional | Stale Running threshold (default `300000` = 5m) |

**Secrets go in the platform env UI — never in the frontend bundle.**  
Agent keys are created in the UI and shown once; store them in harness secrets.

---

## 2. Deploy start path

```text
npm run build
npm run start   # migrate.mjs then nitro server
```

- `scripts/migrate.mjs` applies `migrations/*.sql` when `DATABASE_URL` is set.  
- Health: `GET /` and `GET /api/agent/health` (includes `stale` summary).  
- Local helper: `./startup.sh` (picks docker Postgres on `:55432` if present).

---

## 3. Human operators (email/password — no external broker)

1. Set `BETTER_AUTH_URL` (public app URL) + `BETTER_AUTH_SECRET` (random).  
2. Set `AGENT_RELAY_ADMIN_EMAILS=you@example.com`.  
3. Open `/login` → **Create account** with that email + password.  
4. Roles: **viewer** / **operator** / **admin** (admin from email list or `POST /api/agent/roles`).  
5. Agents **never** use this login — only `Authorization: Bearer ark_…` or global key.

See **[GETTING_STARTED.md](./GETTING_STARTED.md)** for the shortest path.

Without `BETTER_AUTH_URL`, local UI stays open as admin (dev). Do **not** leave a public Railway URL without `BETTER_AUTH_URL`.

---

## 4. Connect GitHub → missions

1. Agents tab → **GitHub connect** for the project.  
2. Set `owner/repo` and a webhook secret; save.  
3. In GitHub: repo **Webhooks** (or GitHub App) → payload URL  
   `https://<host>/api/agent/webhooks/github?project=<projectId>`  
   content-type `application/json`, secret = same value, events: issues (+ PR/check_run for artifacts).  
4. Open an issue → one mission, `external_id` = `github:owner/repo#n` (idempotent re-delivery).  
5. Unsigned payloads are **rejected** when a secret is configured.

Manual test without GitHub:

```bash
curl -sS -X POST "$BASE/api/agent/ingest/github" \
  -H 'content-type: application/json' \
  -d '{"projectId":"proj_default","repository":{"full_name":"Acme/app"},"issue":{"number":1,"title":"Smoke","body":"hi","html_url":"https://github.com/Acme/app/issues/1","labels":[{"name":"ready-for-agent"}]}}'
```

---

## 5. First agent key + poll

1. Admin → Agents → **Create key** (project or per-agent). Copy secret once.  
2. Poll:

```bash
curl -sS -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent/missions?column=ready&limit=5&agent=forge&skills=code,tests"
```

3. Invalid `ark_…` → `401`. Valid → Ready missions (skill/tag filters apply).

---

## 6. Ops reliability

- **Stale heartbeats:** Running missions without heartbeat within threshold appear in `GET /api/agent/health` → `stale` and `GET /api/agent/stale`.  
- **Live:** tab still polls; optional push: `GET /api/agent/events/stream?project=…` (SSE).  
- **Export:** UI history CSV or `GET /api/agent/export?history=1&format=csv`.  
- **Reply webhook:** project setting URL fires on Call resolve.

---

## 7. Smoke checklist (first day)

- [ ] `GET /api/agent/health` → `ok`, `store: durable`  
- [ ] Sign in as admin; board loads; viewer cannot create keys  
- [ ] Create scoped key; agent poll 200; bad key 401  
- [ ] GitHub secret set; unsigned webhook 401; signed/ingest creates one mission  
- [ ] Reply to Call (if open) or confirm webhook payload builder still wired  
- [ ] Export history JSON/CSV ≥ 2 rows  

---

*Keep the five-verb contract stable. Humans get sessions; agents get keys.*
