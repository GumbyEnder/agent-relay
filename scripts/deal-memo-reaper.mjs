#!/usr/bin/env node
/**
 * Boot sweep for CR-9 deal-memo runs.
 *
 * The runner is in-process and detached. If the container is redeployed while a
 * memo is being made, the promise is gone and no code runs again — the row would
 * otherwise sit at `running` forever and the card would show a spinner on a run
 * that is never coming back.
 *
 * This script is the only writer of `interrupted`. It runs before the server
 * binds, so a poll can never observe a stale `running` row after a restart.
 *
 * TWO GUARDS, both deliberate:
 *  - `BZ_DEAL_MEMO_LANE=1` — only the service that hosts the lane sweeps. The
 *    console and the consumer host share one database; a restart of the sibling
 *    must not kill a live run.
 *  - `owner_host` (and a 2-hour ceiling) — a row is swept when its owner is this
 *    service, or when it is simply too old to be alive. Never every row.
 *
 * Exit code is always 0: a boot must not be blocked by bookkeeping. A failure is
 * logged loudly enough to be found.
 */
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("[deal-memo-reaper] DATABASE_URL not set — skipping (local PGLite has no redeploys to survive).");
  process.exit(0);
}
if ((process.env.BZ_DEAL_MEMO_LANE ?? "").trim() !== "1") {
  console.log("[deal-memo-reaper] BZ_DEAL_MEMO_LANE is not 1 — this service does not host the lane; skipping.");
  process.exit(0);
}

const host = (process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME || "").trim();
const staleHours = 2;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobs = await client.query(
      `UPDATE buzzy_deal_memo_jobs
          SET state = 'interrupted',
              message = 'interrupted, nothing charged',
              charged_cents = 0,
              charged_drops = 0,
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE state IN ('queued', 'running')
          AND (owner_host = $1 OR created_at < now() - ($2 || ' hours')::interval)
        RETURNING job_id`,
      [host, String(staleHours)],
    );
    const jobIds = jobs.rows.map((r) => r.job_id);
    let stages = 0;
    if (jobIds.length) {
      const st = await client.query(
        `UPDATE buzzy_deal_memo_stages
            SET state = 'interrupted',
                note = COALESCE(note, 'the process ended before this step finished'),
                finished_at = COALESCE(finished_at, now())
          WHERE state IN ('pending', 'running')
            AND job_id = ANY($1::text[])
          RETURNING id`,
        [jobIds],
      );
      stages = st.rowCount ?? 0;
    }
    await client.query("COMMIT");
    if (jobIds.length) {
      console.log(`[deal-memo-reaper] interrupted ${jobIds.length} run(s), ${stages} stage row(s) on ${host || "unknown host"}`);
    } else {
      console.log(`[deal-memo-reaper] nothing to interrupt on ${host || "unknown host"}`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[deal-memo-reaper] failed:", e instanceof Error ? e.message : e);
  } finally {
    client.release();
  }
} catch (e) {
  console.error("[deal-memo-reaper] could not connect:", e instanceof Error ? e.message : e);
} finally {
  await pool.end().catch(() => {});
}
