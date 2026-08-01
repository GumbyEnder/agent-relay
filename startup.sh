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

if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/agent/health"; then
  echo "already up on :${PORT}"
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
exec node .output/server/index.mjs
