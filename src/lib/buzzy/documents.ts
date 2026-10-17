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

/** Provenance recorded with every substantive version (BZ-F017). */
export interface VersionProvenance {
  /** The brief (slots) snapshot this version was generated from. */
  slots?: Record<string, string>;
  expert?: string | null;
  /** Verification results computed at generation time (reviewDraft checks). */
  review?: unknown;
  creator?: string | null;
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
  provenance: VersionProvenance = {},
): Promise<MaterializedDoc> {
  const id = documentIdForJob(jobId);
  const existing = await sql<{ current_version: number; status: string }>`
    SELECT current_version, status FROM buzzy_documents
    WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `;
  const briefJson = provenance.slots ? JSON.stringify(provenance.slots) : null;
  const reviewJson = provenance.review ? JSON.stringify(provenance.review) : null;
  if (!existing.length) {
    await sql`
      INSERT INTO buzzy_documents (id, user_id, job_id, title, type, status, current_version, expert)
      VALUES (${id}, ${userId}, ${jobId}, ${title.slice(0, 200)}, 'document', 'ready', 1, ${provenance.expert ?? null})
    `;
    await sql`
      INSERT INTO buzzy_document_versions
        (doc_id, version, content, parent_version, creator, brief_revision, expert, review)
      VALUES
        (${id}, 1, ${content}, NULL, ${provenance.creator ?? null}, ${briefJson}::jsonb,
         ${provenance.expert ?? null}, ${reviewJson}::jsonb)
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
    INSERT INTO buzzy_document_versions
      (doc_id, version, content, parent_version, creator, brief_revision, expert, review)
    VALUES
      (${id}, ${nextVersion}, ${content}, ${current.current_version}, ${provenance.creator ?? null},
       ${briefJson}::jsonb, ${provenance.expert ?? null}, ${reviewJson}::jsonb)
  `;
  // A revision re-opens review: an accepted document goes back to ready until
  // the new version is accepted (QA-20 material-scope invalidates approval),
  // and the old accepted_version pointer is cleared — approval must reference
  // the exact version it accepted (QA-08).
  await sql`
    UPDATE buzzy_documents
    SET current_version = ${nextVersion}, title = ${title.slice(0, 200)},
        status = CASE WHEN status = 'accepted' THEN 'ready' ELSE status END,
        accepted_version = NULL,
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return { id, version: nextVersion, changed: true };
}

// ── BZ-F016: changed-section summary ─────────────────────────────────────

export interface DiffSummary {
  from: number;
  to: number;
  added: string[];
  removed: string[];
  sectionsChanged: string[];
  /** True when the two versions are byte-identical (no false "changed"). */
  identical: boolean;
}

function sectionOf(headings: Array<{ at: number; name: string }>, lineIdx: number): string {
  let name = "(opening)";
  for (const h of headings) {
    if (h.at <= lineIdx) name = h.name;
  }
  return name;
}

/**
 * Line-level changed-section summary between two canonical texts. Deliberately
 * a summary, not a Myers diff: lines unique to each side plus the section
 * headings those lines fall under.
 */
export function summarizeChanges(fromText: string, toText: string, from: number, to: number): DiffSummary {
  const aLines = fromText.split("\n").map((l) => l.trim()).filter(Boolean);
  const bLines = toText.split("\n").map((l) => l.trim()).filter(Boolean);
  const aHeads = fromText.split("\n").map((l, i) => ({ at: i, name: l.replace(/^#{1,3}\s+/, "").trim() })).filter((h) => /^#{1,3}\s/.test(fromText.split("\n")[h.at] ?? ""));
  const bHeads = toText.split("\n").map((l, i) => ({ at: i, name: l.replace(/^#{1,3}\s+/, "").trim() })).filter((h) => /^#{1,3}\s/.test(toText.split("\n")[h.at] ?? ""));
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const added = bLines.filter((l) => !aSet.has(l)).slice(0, 20);
  const removed = aLines.filter((l) => !bSet.has(l)).slice(0, 20);
  const sections = new Set<string>();
  toText.split("\n").forEach((l, i) => {
    if (l.trim() && !aSet.has(l.trim())) sections.add(sectionOf(bHeads, i));
  });
  fromText.split("\n").forEach((l, i) => {
    if (l.trim() && !bSet.has(l.trim())) sections.add(sectionOf(aHeads, i));
  });
  return {
    from,
    to,
    added,
    removed,
    sectionsChanged: [...sections].slice(0, 10),
    identical: fromText === toText,
  };
}

export type AcceptanceResult =
  | { ok: true }
  | { ok: false; code: "stale_version"; currentVersion: number };

/**
 * Approval state flows into the document lifecycle (BZ-F017 / QA-08).
 * When `approvedText` is supplied (the client approves the exact text on its
 * screen), it must match the document's CURRENT version — approving a stale
 * revision is rejected, never silently applied to newer content.
 */
export async function setDocumentAcceptance(
  sql: Sql,
  userId: string,
  jobId: string,
  accepted: boolean,
  approvedText?: string | null,
): Promise<AcceptanceResult> {
  const id = documentIdForJob(jobId);
  const docs = await sql<{ current_version: number }>`
    SELECT current_version FROM buzzy_documents WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `;
  if (!docs.length) return { ok: true }; // no materialized document — nothing to sync
  if (accepted && typeof approvedText === "string") {
    const v = await sql<{ content: string }>`
      SELECT content FROM buzzy_document_versions
      WHERE doc_id = ${id} AND version = ${docs[0].current_version} LIMIT 1
    `;
    if (v.length && v[0].content !== approvedText) {
      return { ok: false, code: "stale_version", currentVersion: docs[0].current_version };
    }
  }
  if (accepted) {
    await sql`
      UPDATE buzzy_documents
      SET status = 'accepted', accepted_version = ${docs[0].current_version}, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
    `;
    await sql`
      UPDATE buzzy_document_versions
      SET accepted_at = now(), accepted_by = ${userId}
      WHERE doc_id = ${id} AND version = ${docs[0].current_version}
    `;
  } else {
    await sql`
      UPDATE buzzy_documents
      SET status = 'ready', accepted_version = NULL, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
    `;
    await sql`
      UPDATE buzzy_document_versions
      SET accepted_at = NULL, accepted_by = NULL
      WHERE doc_id = ${id}
    `;
  }
  return { ok: true };
}
