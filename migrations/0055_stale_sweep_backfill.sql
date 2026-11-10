-- 0055: drain the stranded-runner population (one-time backfill).
--
-- Ruling: frodo, 2026-11-10 04:23Z, topic work.
--
-- Context: the lazy sweep in board-store.poll() used to "release in place" —
-- it nulled claimed_by/claimed_at but left column_id='running' and
-- last_heartbeat untouched. Result: 22 missions sat in Running for weeks/months
-- with no owner, classified "stale" instead of "orphaned", and unreachable by
-- any human triage. The code fix (demote to inbox, clock = max(hb, claimed_at),
-- `sustained` exemption) stops NEW strandings; it cannot drain the ones already
-- there, because they no longer match the sweep predicate (claimed_by is null).
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
-- Nothing is deleted. Reversible by rollback/0055_stale_sweep_backfill.down.sql.

-- 1. The long-lived epic is not agent work.
UPDATE ar_missions
   SET tags = CASE
                WHEN tags @> '["sustained"]'::jsonb THEN tags
                ELSE tags || '["sustained"]'::jsonb
              END,
       updated_at = now()
 WHERE external_id = 'github:gumbyender/agent-relay#165'
   AND NOT (tags @> '["sustained"]'::jsonb);

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
     AND NOT (m.tags @> '["sustained"]'::jsonb)
     AND coalesce(greatest(m.last_heartbeat, m.claimed_at), to_timestamp(0))
         < now() - interval '6 hours'
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
