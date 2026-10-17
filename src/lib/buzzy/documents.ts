/**
 * BZ-F015 — durable project documents.
 *
 * Materialize the ACTUAL output a workflow produced (never reconstruct a
 * "document" from a problem echo), keep every prior version immutable, and
 * expose the lifecycle (draft → ready → accepted) as real state.
 */

import type { Sql } from "@/lib/db";

export interface MaterializedDoc {
  id: string;
  version: number;
  changed: boolean;
}

/** One canonical deliverable document per job (id derived from the job id). */
export function documentIdForJob(jobId: string): string {
  return "doc_" + jobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
}

/**
 * Persist `content` as the job's document. A changed body appends a new
 * immutable version and bumps current_version; an identical body is a no-op
 * (re-saving never rewrites history, QA-12).
 */
export async function materializeDraft(
  sql: Sql,
  userId: string,
  jobId: string,
  title: string,
  content: string,
  expert?: string | null,
): Promise<MaterializedDoc> {
  const id = documentIdForJob(jobId);
  const existing = await sql<{ current_version: number; status: string }>`
    SELECT current_version, status FROM buzzy_documents
    WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `;
  if (!existing.length) {
    await sql`
      INSERT INTO buzzy_documents (id, user_id, job_id, title, type, status, current_version, expert)
      VALUES (${id}, ${userId}, ${jobId}, ${title.slice(0, 200)}, 'document', 'ready', 1, ${expert ?? null})
    `;
    await sql`
      INSERT INTO buzzy_document_versions (doc_id, version, content)
      VALUES (${id}, 1, ${content})
    `;
    return { id, version: 1, changed: true };
  }
  const current = existing[0];
  const latest = await sql<{ content: string }>`
    SELECT content FROM buzzy_document_versions
    WHERE doc_id = ${id} AND version = ${current.current_version} LIMIT 1
  `;
  if (latest.length && latest[0].content === content) {
    return { id, version: current.current_version, changed: false };
  }
  const nextVersion = current.current_version + 1;
  await sql`
    INSERT INTO buzzy_document_versions (doc_id, version, content)
    VALUES (${id}, ${nextVersion}, ${content})
  `;
  // A revision re-opens review: an accepted document goes back to ready until
  // the new version is accepted (QA-20 material-scope invalidates approval).
  await sql`
    UPDATE buzzy_documents
    SET current_version = ${nextVersion}, title = ${title.slice(0, 200)},
        status = CASE WHEN status = 'accepted' THEN 'ready' ELSE status END,
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return { id, version: nextVersion, changed: true };
}

/** Approval state flows into the document lifecycle. */
export async function setDocumentAcceptance(
  sql: Sql,
  userId: string,
  jobId: string,
  accepted: boolean,
): Promise<void> {
  const id = documentIdForJob(jobId);
  await sql`
    UPDATE buzzy_documents
    SET status = ${accepted ? "accepted" : "ready"}, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
}
