# Agent Relay HTTP API

**Protocol:** 0.2 · **App:** 0.3.x (see `GET /health` → `version`)  
**Base path:** `/api/agent`

Durable board store (Postgres or PGLite). Mutations are serialized so **claim is atomic** under concurrent requests.

## Auth

If `AGENT_RELAY_API_KEY` is set in the environment:

```
Authorization: Bearer <key>
# or
X-Agent-Key: <key>
```

If unset, the API is open (local demo).

When set, **same-origin browser requests** (operator UI) are allowed without the key; external agents must still send Bearer / X-Agent-Key.

## Endpoints

### `GET /health`

Service liveness + counts.

### `GET /missions?column=ready&limit=5&agent=forge&tags=docs,ops`

**poll** — claimable missions (default column `ready`, unclaimed only for ready/inbox).

### `GET /missions/:id`

Full mission record.

### `POST /missions/:id/claim`

```json
{ "agent": "forge" }
```

- **200** — claimed; column → `running`
- **409** — already claimed (`code: already_claimed`)

Agent may be **name** or **id**.

### `POST /missions/:id/unclaim`

```json
{ "agent": "forge" }
// or take over a stale claim:
{ "agent": "frodo", "force": true, "note": "claimant key retired" }
```

- **200** — claim released (mission keeps its column; `mission_unclaimed` event)
- **409** `not_claimer` — claimed by another agent and `force` not set
- Force-release requires a **review-skill** ark key or an operator session

### `POST /missions/:id/comment`

```json
{ "agent": "forge", "note": "found the root cause, patching" }
```

Dedicated comment/progress thread — does **not** touch `lastHeartbeat`, so stale-detection stays meaningful. Any agent with read access may comment. Events use kind `comment`. Alias: `comment` field accepted in place of `note`.

### Mission state machine

Every mission payload carries `allowedMoves` — the verbs legal from its current column:

| From | Verb | To | Who |
|------|------|----|-----|
| inbox / ready | `claim` | running | any agent |
| inbox / ready | `move` | running | operator |
| running | `heartbeat` | — | claimant |
| running | `deliver` | review | claimant |
| running | `escalate` | needs_human | claimant |
| running | `unclaim` | — (stays running) | claimant; `force` by reviewer/operator |
| running | `move` | ready, done | operator |
| review | `move` | done, ready | reviewer-skill key or operator |
| needs_human | `deliver` | review | claimant |
| needs_human | `move` | any | operator |
| done / blocked | — | terminal | — |

Note: `POST /move` from **inbox→ready** is NOT a reviewer move — hand cards to workers by claiming them, or move inbox→running as operator.

### Cursor pagination (`GET /missions`)

Responses carry `truncated` and `nextCursor` (opaque base64 keyset over the sort tuple; `null` when exhausted). Page through ALL matching missions:

```bash
curl -s 'localhost:8080/api/agent/missions?column=inbox&limit=50&cursor=<nextCursor>'
```

Malformed cursors → **400** `bad_cursor`.

### `POST /missions/:id/heartbeat`

```json
{ "agent": "forge", "note": "writing tests" }
```

### `POST /missions/:id/escalate`

```json
{ "agent": "relay", "question": "Extend idle timeout to 6h?" }
```

Creates a human call; column → `needs_human`.

### `POST /missions/:id/deliver`

```json
{
  "agent": "forge",
  "summary": "cookie flags fixed; tests green",
  "artifacts": ["src/auth/cookies.ts"]
}
```

Column → `review`; agent freed.

### `POST /v1`

Action bus matching `PROTOCOL.md`:

```json
{ "action": "poll", "column": "ready", "limit": 5, "agent": "forge" }
{ "action": "claim", "mission_id": "msn_…", "agent": "forge" }
{ "action": "heartbeat", "mission_id": "msn_…", "agent": "forge", "note": "…" }
{ "action": "escalate", "mission_id": "msn_…", "agent": "relay", "question": "…" }
{ "action": "deliver", "mission_id": "msn_…", "agent": "forge", "summary": "…", "artifacts": [] }
```

### Operator helpers

| Method | Path | Body |
|--------|------|------|
| GET | `/agents` | — |
| POST | `/agents` | `{ name, harness, role?, skills? }` |
| GET | `/calls?open=1` | — |
| POST | `/calls/:id/reply` | `{ reply }` |
| GET | `/export` | — |
| POST | `/reset` | — (restore seed demo) |

## curl examples

```bash
curl -s localhost:8080/api/agent/health | jq
curl -s 'localhost:8080/api/agent/missions?column=ready&limit=3' | jq
curl -s -X POST localhost:8080/api/agent/missions/msn_agent_protocol_doc/claim \
  -H 'content-type: application/json' \
  -d '{"agent":"lens"}' | jq
```
