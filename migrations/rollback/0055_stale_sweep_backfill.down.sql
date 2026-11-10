-- Rollback of 0055. Restores the pre-backfill state exactly: cards back in
-- Running with no owner, their old heartbeat/claim clocks restored from the
-- history meta, the backfill's history + events removed, and #165 untagged.
-- (This restores the defect too. It exists for a clean revert, not a safe state.)

-- Undo the demotion.
UPDATE ar_missions m
   SET column_id = 'running',
       claimed_by = NULL,
       claimed_at = (h.meta->>'claimedAt')::timestamptz,
       last_heartbeat = (h.meta->>'lastHeartbeat')::timestamptz,
       updated_at = now()
  FROM ar_mission_history h
 WHERE h.mission_id = m.id
   AND h.actor_name = 'stale-sweep-backfill'
   AND h.note = 'released-by-stale-sweep backfill 2026-11-10'
   AND m.column_id = 'inbox';

DELETE FROM ar_events
 WHERE (meta->>'backfill') = 'stale-sweep-2026-11-10';

DELETE FROM ar_mission_history
 WHERE actor_name = 'stale-sweep-backfill'
   AND note = 'released-by-stale-sweep backfill 2026-11-10';

UPDATE ar_missions
   SET tags = (SELECT coalesce(jsonb_agg(t), '[]'::jsonb)
                 FROM jsonb_array_elements_text(tags) AS t
                WHERE t <> 'sustained')
 WHERE external_id = 'github:gumbyender/agent-relay#165'
   AND tags @> '["sustained"]'::jsonb;
