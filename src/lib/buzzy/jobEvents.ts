/**
 * Per-human action attribution (plan doc 23, multi-owner groundwork).
 * The approval gate is per-human, not per-business: every consequential
 * action names the person who took it.
 */

export async function recordJobEvent(
  sql: any,
  jobId: string,
  userId: string,
  action: string,
  detail: string,
): Promise<void> {
  await sql`
    INSERT INTO buzzy_job_events (job_id, user_id, actor, action, detail)
    VALUES (${jobId}, ${userId}, ${userId}, ${action}, ${detail})
  `;
}
