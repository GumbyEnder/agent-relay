#!/usr/bin/env bash
# Idempotent local/prod start for Agent Relay (Node nitro build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8090}"
HOST="${HOST:-0.0.0.0}"
export HOST PORT

# Prefer local docker Postgres if DATABASE_URL unset
if [[ -z "${DATABASE_URL:-}" ]]; then
  if docker exec agent-relay-pg pg_isready -U relay >/dev/null 2>&1; then
    export DATABASE_URL="postgresql://relay:relay@127.0.0.1:55432/agent_relay"
  fi
fi

# Local human sign-in defaults (email/password via Better Auth in-app — no Grok broker).
# Override or unset in real prod; Railway should set these explicitly.
if [[ -z "${BETTER_AUTH_URL:-}" ]]; then
  export BETTER_AUTH_URL="http://127.0.0.1:${PORT}"
fi
if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
  export BETTER_AUTH_SECRET="local-dev-only-change-me-in-prod-$(openssl rand -hex 16 2>/dev/null || echo fixeddevsecret0123456789abcdef)"
fi
# First operator becomes admin when their email matches (comma-separated).
if [[ -z "${AGENT_RELAY_ADMIN_EMAILS:-}" ]]; then
  export AGENT_RELAY_ADMIN_EMAILS="${AGENT_RELAY_ADMIN_EMAILS:-}"
fi

if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/agent/health"; then
  echo "already up on :${PORT}"
  echo "  UI:  http://127.0.0.1:${PORT}/   login: http://127.0.0.1:${PORT}/login"
  exit 0
fi

if [[ ! -f .output/server/index.mjs ]]; then
  echo "building..."
  npm run build
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  node scripts/migrate.mjs || true
fi

# Free port if something stale holds it
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.3
fi

echo "starting Agent Relay on ${HOST}:${PORT} (cwd=$ROOT)"
echo "  BETTER_AUTH_URL=${BETTER_AUTH_URL}"
echo "  UI http://127.0.0.1:${PORT}/login  (create account → board)"
echo "  Agents: Agents tab → Create key → Authorization: Bearer ark_…"
exec node .output/server/index.mjs
