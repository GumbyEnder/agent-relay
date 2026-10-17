/**
 * Buzzy scheduled jobs (plan doc 23, component #5).
 *
 * A scheduled run is a chatLoop invocation whose output ALWAYS lands as a
 * draft in the approve queue — never a sent thing. The harness works while
 * the owner doesn't; the owner still decides everything.
 */

export interface DueJob {
  id: string;
  user_id: string;
  company_id: string | null;
  name: string;
  prompt: string;
}

/** Jobs due to run now. */
export async function dueScheduledJobs(sql: any, limit = 5): Promise<DueJob[]> {
  return (await sql`
    SELECT id, user_id, company_id, name, prompt
    FROM buzzy_scheduled_jobs
    WHERE enabled = true AND next_run_at <= now()
    ORDER BY next_run_at ASC
    LIMIT ${limit}
  `) as DueJob[];
}

/** Bump the schedule after a run (or a failed attempt — retry next cadence). */
export async function markScheduledRun(sql: any, id: string, resultSummary: string | null, cadence: string): Promise<void> {
  const days = cadence === "daily" ? 1 : cadence === "monthly" ? 30 : 7;
  await sql`
    UPDATE buzzy_scheduled_jobs
    SET next_run_at = now() + (${days} || ' days')::interval,
        last_result = ${resultSummary},
        updated_at = now()
    WHERE id = ${id}
  `;
}

/** Persist the run's output as a DRAFT job (approval-gated like any draft). */
export async function saveScheduledDraft(
  sql: any,
  job: DueJob,
  draftText: string,
): Promise<string> {
  const draftId = `sched_${job.id.slice(-8)}_${Date.now().toString(36)}`;
  await sql`
    INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
    VALUES (
      ${draftId}, ${job.user_id}, null,
      ${("Scheduled: " + job.name).slice(0, 80)},
      'Draft ready',
      ${job.company_id},
      ${JSON.stringify({
        draft: draftText,
        slots: {},
        approved: false,
        scheduled: true,
        source_schedule: job.id,
      })}::jsonb,
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data, updated_at = now()
  `;
  return draftId;
}
