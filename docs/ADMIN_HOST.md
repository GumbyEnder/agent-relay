# Platform Admin host (separate Railway service)

Operator board UI stays on **app.devboards.ai**.  
Platform Admin (users, usage, cross-tenant ops) runs on **admin.devboards.ai**.

## Why separate

- Admin is cross-tenant; keep it off the daily operator chrome.
- Independent deploy/scale and tighter cookie / CORS scope per host.
- Same codebase and Postgres — different `DEVBOARDS_SURFACE` + domain.

## Railway

1. Duplicate the `agent-relay` service (or create `agent-relay-admin` from the same GitHub repo + branch).
2. On the **admin** service set:
   - `DEVBOARDS_SURFACE=admin`
   - `BETTER_AUTH_URL=https://admin.devboards.ai`
   - `BETTER_AUTH_TRUSTED_ORIGINS` includes `https://admin.devboards.ai`
   - Same `DATABASE_URL`, `BETTER_AUTH_SECRET`, `AGENT_RELAY_ADMIN_EMAILS`
3. On the **app** service set:
   - `DEVBOARDS_SURFACE=app` (or omit — default is app)
   - `ADMIN_PUBLIC_URL=https://admin.devboards.ai`
   - `BETTER_AUTH_URL=https://app.devboards.ai`
4. Attach custom domain `admin.devboards.ai` → admin service.
5. DNS CNAME `admin` → Railway as instructed in the domain UI.

## Behavior

| Host | Surface | UI |
|------|---------|-----|
| app.* | `app` | Operator board / Live / Agents |
| admin.* | `admin` | Platform Admin shell only |

Hostname `admin.*` also forces admin surface if env is missing (dev convenience).

## Auth

Email/password (and future OAuth) use Better Auth on each host. Prefer signing in on the admin host for admin work. Seed admin: `devboards@devboards.ai` (role admin).

## APIs (admin role / `manage_roles`)

- `GET /api/agent/admin/users`
- `GET /api/agent/admin/usage?range=7d`
- `POST /api/agent/roles` `{ userId, role, email? }`
