-- Rollback of 0055. Restores the demotion: cards back in Running with no owner
-- and their old heartbeat/claim clocks restored from the history meta, plus the
-- backfill's own history + events removed. (This restores the defect too. It
-- exists for a clean revert of the DEMOTION, not a safe state.)
--
-- It does NOT untag #165. The `sustained` tag is a standing policy fact (long-
-- lived product work is not an agent task, DEFAULT_STALE_POLICY.exemptTags),
-- not backfill state. Stripping it here was coherent only while the sweep still
-- filtered on `claimed_by is not null`; post-Amendment-A the sweep's predicate
-- is (running, not sustained, greatest(hb, claimed_at, updated_at) < cutoff), so
-- an untagged #165 is drained to Inbox at the next poll after its clock lapses
-- — and this script just restored it with a 23-day heartbeat. Keep the tag;
-- revert the move.
--
-- WARNING: the restored rows go back to Running with old heartbeat/claim clocks
-- and updated_at = now(). On the post-Amendment-A code, updated_at is part of
-- the sweep's clock, so they are safe for staleHours (6h by default) and then
-- re-drained. Rolling the CODE back does not help: every earlier version of the
-- sweep used max(hb, claimed_at) with a to_timestamp(0) fallback, which matches
-- these rows immediately. The only way for a reverted card to stay in Running
-- is the new code with STALE_CLAIM_RELEASE_HOURS=0; otherwise treat this as a
-- 6h revert and say so in the incident note.

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
 WHERE (meta->>'backfill') = 'stale-sweep-2026-11-10'
   -- but keep the tag's own explanation: the tag survives this rollback, so the
   -- note that says why it exists survives with it (meta->>'tag' = 'sustained').
   AND coalesce(meta->>'tag', '') <> 'sustained';

DELETE FROM ar_mission_history
 WHERE actor_name = 'stale-sweep-backfill'
   AND note = 'released-by-stale-sweep backfill 2026-11-10';

-- No tag removal. #165 keeps `sustained` — see the header.
