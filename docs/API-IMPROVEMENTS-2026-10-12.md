# Agent API Improvements — 2026-10-12

Shipped 2026-10-11/12, all deployed to prod (app.devboards.ai) and E2E-verified.
Each item below cites the live incident that motivated it. Board tickets: DevBoard APP board, numbers 9501–9508.

## Shipped as code

### 1. Cursor pagination on `GET /missions` (p1) — commit `63774c0`
**Incident:** poll capped at ~50 with no way past it; BeeZilla inbox held 80 cards and new agents silently missed work.
- Keyset cursor over the sort tuple (skillHit, rank, createdAt, id) — stable paging
- Opaque base64 `nextCursor` in every response; `?cursor=` to continue; `400 bad_cursor` on malformed
- `truncated` flag retained
- **E2E:** BeeZilla inbox paged 10/page → 5 pages → 41/41 items, no silent truncation

### 2. `allowedMoves` on mission payloads + published state machine (p1) — commit `c6cbe07`
**Incident:** state rules (claim-from-review impossible, reviewer moves review→done|ready only, unclaimed-running IS claimable) were learnable only by hitting 409s.
- Every mission payload now carries `allowedMoves: [{verb, to?, who}]` mirroring the rules the API actually enforces
- Full state-machine table published in `docs/API.md`

### 3. Claim force-release: `POST /missions/:id/unclaim` (p0) — commit `86247da`
**Incident:** 5 demo missions stuck 14 months in running/review under dead `forge`/`lens` keys. Deliver → 409 `not_claimer`; claim → 409 wrong column. No recovery path existed.
- Claimant can always release their own
- `force: true` take-over gated to review-skill ark keys or operator sessions
- `mission_unclaimed` event audited with actor; mission keeps its column
- **E2E:** force-unclaimed the 4 dead-key strays on prod, closed 3 through the new path

### 4. Board snapshot size guard (p0) — commit `0452af6`
**Incident (prod outage):** legacy deliver payloads carried a 440-level self-nesting `usage.raw` chain; the pretty-printed `?project=all` snapshot inflated to **204 MB**, browser fetches timed out, and the UI fell back to "No boards yet" while the data was fine.
- `parseUsage` collapses single-key `raw` chains (guard 20) and hard-caps the serialized blob at 64 KB with a `truncated` marker
- `json()` pretty-prints only in dev — compact JSON in production
- Data fix (recursive CTE collapse in Postgres) shrank the live snapshot 204 MB → 0.86 MB

### 5. Dedicated comment endpoint: `POST /missions/:id/comment` (p2) — commit `8ad7a78`
**Incident:** heartbeats doubled as the progress note of record, so stale-detection couldn't distinguish "alive" from "talkative."
- Own event kind `comment`; does **not** touch `lastHeartbeat` (E2E-verified byte-identical)
- Any agent with read access may comment; `comment` field alias accepted

### 6. OpenAPI 3.1 spec: `GET /api/agent/openapi.json` (p2) — commit `b911e3c`
**Incident:** no machine-readable contract — typed clients, tool discovery, and assumption-checking (e.g. "claim works from inbox") were code-archaeology only.
- 16 paths, Mission schema (incl. `allowedMoves`) + Error schema, bearer/agent-key security schemes
- Served live; `docs/API.md` stays as the narrative layer
- Deferred: CI spec-sync check

## Verified already implemented (closed without commits)

### 7. SSE events: `GET /api/agent/events/stream`
Board-delta stream, 1.2s ticks, 5-min rotation with client reconnect. Heartbeats excluded by the delta design (signature over latest event/history/counts, not heartbeat volume). E2E with an ark key: 200, hello + board deltas streaming.

### 8. CORS
OPTIONS preflight → 204 with `access-control-allow-origin: *`, `allow-headers: content-type, authorization, x-agent-key`. Token-authed cross-origin consumers work out of the box.

## Also merged to prod this pass

- `630dc14` — analytics merge: event cap 200→2000, chart overflow fix, memo dep, windowed stats, median claim→deliver cycle time, per-agent usage, velocity + created-series tiles
- Loop-actor release `release/beezilla-2026-10-12`: BZ-F001 account-scoped business profile, sessions drawer + backdrop fix, DB-stored Talk sessions, structured Decisions Made

## Recommended next

1. **Board UI thread for comments** — the endpoint ships; the UI journal doesn't render comment threads yet.
2. **CI spec-sync check** — assert `openapi.json` paths match routes on every PR.
3. **Configurable `ALLOWED_ORIGINS`** — tighten from `*` when third-party browser clients appear.
4. **Auto-release stale claims** — complement the manual force-release: claims with no heartbeat for >N days release automatically (configurable).

## Follow-up round (same day) — all four shipped

1. **Comments in the journal** — `journalMarkdown` pulls `kind='comment'` events (joined to agent names) and renders a `## Comments` section: `- **<utc> · <author>:** <text>` below the timeline. The journal — UI panel, journal.md, API — is now the comment thread surface.
2. **Spec-sync check** — `scripts/test-openapi-sync.mjs` (`npm run test:openapi-sync`): extracts all 16 spec paths, matches static routes by literal and verb routes by dispatch (`verb === "<verb>"`), exits 1 on mismatch. Verified: 16/16 pass.
3. **Configurable CORS** — `ALLOWED_ORIGINS` env (comma-separated). Wildcard default preserved; when set, non-matching origins get no `allow-origin` header. Authed API responses + OPTIONS now honor it; public docs surfaces stay open.
4. **Auto-release stale claims** — lazy sweep on every poll: running missions with no heartbeat for >6h (`STALE_CLAIM_RELEASE_HOURS`, 0 disables) have their claim cleared. Complements manual force-release; no more dead-key dead-ends even if nobody notices.
