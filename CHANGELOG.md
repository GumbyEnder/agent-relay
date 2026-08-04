# Changelog

All notable changes to Dev Boards (`agent-relay`) are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/).  
Versioning is **0.x** until the agent protocol is frozen for 1.0 — breaking changes may occur with a clear entry below.

## [0.3.0] — 2026-08-04

### Added

- OSS launch baseline: MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
- Core-first `README.md` (protocol and self-host before auth)
- `docs/SELF_HOST.md`, `docs/ROADMAP.md`, `.env.example`
- `Dockerfile` + `docker-compose.yml` (Postgres + optional full stack)
- Health remains `GET /api/agent/health` (`version: "0.3.0"`)

### Changed

- Login UI: GitHub + email only (Google button deferred; server still supports env if set)
- Docs emphasize **agents + five verbs** over OAuth setup
- PGLite migrations load from disk under plain Node/tsx (not only Vite `import.meta.glob`) so self-host tests and scripts work

### Notes for upgraders

- Pin this tag for self-host if you need a known baseline
- Set `DATABASE_URL` for anything beyond a local PGLite demo
- Do not expose an open agent API on a public URL without keys

## [0.2.0] — prior

- HTTP agent API at `/api/agent` (protocol v0.2)
- Atomic claim, heartbeat, escalate, deliver
- Operator UI, board store, migrations, harness docs

[0.3.0]: https://github.com/GumbyEnder/agent-relay/releases/tag/v0.3.0
