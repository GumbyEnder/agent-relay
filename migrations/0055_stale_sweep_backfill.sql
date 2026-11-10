-- 0055: drain the stranded-runner population (one-time backfill).
--
-- Ruling: frodo, 2026-11-10 04:23Z, topic work.
--
-- Context: the lazy sweep in board-store.poll() used to "release in place" —
-- it nulled claimed_by/claimed_at but left column_id='running' and
-- last_heartbeat untouched. Result: 22 missions sat in Running for weeks/months
-- with no owner, classified "stale" instead of "orphaned", and unreachable by
-- any human triage. The code fix (demote to inbox, clock =
-- greatest(hb, claimed_at, updated_at), `sustained` exemption) stops NEW
-- strandings; it cannot drain the ones already there, because they no longer
-- match the sweep predicate (claimed_by is null).
--
-- This migration is the drain, and it is deliberately not silent:
--   1. #165 is tagged `sustained` and exempted permanently (no id special-case
--      in the sweep — the tag is the exemption).
--   2. Every other stranded runner moves Running → Inbox (not `ready`:
--      `ready` means triaged and actionable; these are unowned imports and
--      putting them in four other products' queues is work injection).
--   3. One ar_mission_history row each + one ar_events row each.
--   4. One summary post per board so Volution Launch / Zeeva Admin / Hello World
--      game / bns Store can see what landed in their Inbox.
--
-- Measured on production 2026-11-10 (22 running, all claimed_by NULL, all
-- lane='open', so no column_lane_mismatch and no no_lane_history): the 22 split
-- 12 / 6 / 2 / 1 / 1 across Volution Launch, Zeeva Admin, Hello World game,
-- bns Store and BeeZilla. BeeZilla's single runner is #165, tagged below, so it
-- posts no summary — the four-board list above is exactly the set that moves,
-- not an abbreviation of five.
--
-- Idempotence: this file must be safe to replay (a later operator can restore a
-- backup and re-run it, and the live sweep may already have drained part of the
-- population). The tag step guards on the tag, the summary guards on its
-- deterministic ids, and the demotion CTE additionally refuses any card that
-- already carries this run's history note — a replay must never write a second
-- hist_bf_*/ev_bf_* pair per card and double-count it in the per-board count.
--
-- Nothing is deleted. Reversible by rollback/0055_stale_sweep_backfill.down.sql
-- (which reverts the demotion only and keeps the `sustained` tag).
--
-- Rehearsal assertion, read after migrate and BEFORE the server's first poll:
--   select tags from ar_missions where external_id =
--     'github:gumbyender/agent-relay#165';   -- must contain "sustained"
-- The tag step below is the brake. `npm start` runs scripts/migrate.mjs before
-- .output/server/index.mjs, so the first poll happens after this file commits.

-- 1. The long-lived epic is not agent work. Case-insensitive on the tag, like
-- the sweep predicate and the TS classifier (both lower-case tags), so a card
-- tagged `Sustained` does not get a second `sustained` appended.
UPDATE ar_missions
   SET tags = (CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END)
              || '["sustained"]'::jsonb,
       updated_at = now()
 WHERE external_id = 'github:gumbyender/agent-relay#165'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
     ) t
      WHERE lower(t) = 'sustained'
   );

INSERT INTO ar_events (id, mission_id, agent_id, project_id, kind, message, at, meta)
SELECT 'ev_bf_sustain_' || m.id, m.id, NULL, m.project_id, 'note',
       'Tagged `sustained`: long-lived product work, not an agent task. Exempt from the Running heartbeat policy (DEFAULT_STALE_POLICY.exemptTags), so it will never be classified stale or orphaned.',
       now(),
       jsonb_build_object('backfill', 'stale-sweep-2026-11-10', 'tag', 'sustained')
  FROM ar_missions m
 WHERE m.external_id = 'github:gumbyender/agent-relay#165'
ON CONFLICT (id) DO NOTHING;

-- 2+3. Demote every stranded runner, one history row (and one event) each.
WITH stranded AS (
  SELECT m.id, m.project_id, m.last_heartbeat, m.claimed_at
    FROM ar_missions m
   WHERE m.column_id = 'running'
     AND m.claimed_by IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(m.tags) = 'array' THEN m.tags ELSE '[]'::jsonb END
       ) t WHERE lower(t) = 'sustained'
     )
     AND greatest(m.last_heartbeat, m.claimed_at, m.updated_at)
         < now() - interval '6 hours'
     AND NOT EXISTS (
       SELECT 1 FROM ar_mission_history h2
        WHERE h2.mission_id = m.id
          AND h2.note = 'released-by-stale-sweep backfill 2026-11-10'
     )
), moved AS (
  UPDATE ar_missions m
     SET column_id = 'inbox',
         claimed_by = NULL,
         claimed_at = NULL,
         last_heartbeat = NULL,
         updated_at = now()
    FROM stranded s
   WHERE m.id = s.id
  RETURNING m.id, m.project_id, s.last_heartbeat, s.claimed_at
), hist AS (
  INSERT INTO ar_mission_history (
    id, mission_id, project_id, actor_id, actor_name, actor_kind,
    from_column, to_column, at, note, meta
  )
  SELECT 'hist_bf_' || id, id, project_id, NULL, 'stale-sweep-backfill', 'system',
         'running', 'inbox', now(),
         'released-by-stale-sweep backfill 2026-11-10',
         jsonb_build_object('lastHeartbeat', last_heartbeat, 'claimedAt', claimed_at)
    FROM moved
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO ar_events (id, mission_id, agent_id, project_id, kind, message, at, meta)
SELECT 'ev_bf_' || id, id, NULL, project_id, 'mission_released',
       'Demoted Running → Inbox by the 2026-11-10 stale-sweep backfill: the card had no owner and no live heartbeat.',
       now(),
       jsonb_build_object('backfill', 'stale-sweep-2026-11-10')
  FROM moved
ON CONFLICT (id) DO NOTHING;

-- 4. Per-board summary so each owner sees the population land, in their queue.
INSERT INTO ar_events (id, mission_id, agent_id, project_id, kind, message, at, meta)
SELECT 'ev_bf_board_' || h.project_id, NULL, NULL, h.project_id, 'note',
       'Stale-sweep backfill 2026-11-10: ' || count(*) ||
       ' card(s) were sitting in Running with no owner and no live heartbeat (the old sweep released them in place and left them there). They are now in Inbox — untriaged and still unassigned. Triage or archive them; nothing was deleted.',
       now(),
       jsonb_build_object('backfill', 'stale-sweep-2026-11-10', 'count', count(*))
  FROM ar_mission_history h
 WHERE h.actor_name = 'stale-sweep-backfill'
   AND h.note = 'released-by-stale-sweep backfill 2026-11-10'
   AND h.project_id IS NOT NULL
 GROUP BY h.project_id
ON CONFLICT (id) DO NOTHING;
