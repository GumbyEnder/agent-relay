/**
 * BZ-REUSE-159 — On Approve: create the shop-floor board + agent for the job.
 *
 * The locked rule "do not create another board" means no second CONSUMER app:
 * the civilian never leaves the in-product Waiting/Working/Needs-you/Done
 * states. What Approve creates is a Dev Boards project + bound agent + first
 * ticket UNDER THE HOOD, linked from the job's data.execution.
 *
 * Hard gates (F022 / QA-08 / QA-09):
 * - No execution item without a durable approval audit: the job must be
 *   approved AND its materialized document must carry an accepted_version
 *   (the exact-version anchor from BZ-F017). Anything else refuses.
 * - Idempotent: a job with data.execution.projectId returns the existing
 *   linkage — repeated approvals never duplicate boards, agents, tickets
 *   or reservations.
 */

import type { Sql } from "@/lib/db";
import { boardOps } from "../board-server";
import { documentIdForJob } from "./documents";

export interface ExecutionLink {
  projectId: string;
  agentName: string;
  missionId: string;
  acceptedVersion: number;
  createdAt: string;
}

export type EnsureExecutionResult =
  | { ok: true; created: boolean; execution: ExecutionLink }
  | { ok: false; code: "approval_required" | "no_document" };

function slugSuffix(jobId: string): string {
  return jobId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase() || "job";
}

export async function ensureExecutionBoard(
  sql: Sql,
  userId: string,
  jobId: string,
): Promise<EnsureExecutionResult> {
  // ── Idempotency: an existing linkage wins, no duplicates (QA-08/09) ──
  const jrows = await sql<{ title: string | null; data: unknown }>`
    SELECT title, data FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} LIMIT 1
  `;
  if (!jrows.length) return { ok: false, code: "no_document" };
  const data = typeof jrows[0].data === "string" ? JSON.parse(jrows[0].data) : (jrows[0].data ?? {});
  const existing = (data as Record<string, unknown>).execution as ExecutionLink | undefined;
  if (existing?.projectId) {
    const pr = await boardOps.getProject(existing.projectId);
    if (pr) return { ok: true, created: false, execution: existing };
    // Linkage points at a deleted board — fall through and recreate.
  }

  // ── Durable approval audit BEFORE any work item (policy gate) ────────
  const approved = (data as Record<string, unknown>).approved === true;
  const docId = documentIdForJob(jobId);
  const drows = await sql<{ accepted_version: number | null }>`
    SELECT accepted_version FROM buzzy_documents WHERE id = ${docId} AND user_id = ${userId} LIMIT 1
  `;
  const acceptedVersion = drows[0]?.accepted_version ?? null;
  if (!approved || acceptedVersion == null) {
    return { ok: false, code: "approval_required" };
  }

  const title = (jrows[0].title || jobId).slice(0, 80);
  const draft = typeof (data as Record<string, unknown>).draft === "string"
    ? String((data as Record<string, unknown>).draft)
    : "";

  // ── Board + agent + first ticket ──────────────────────────────────────
  const project = await boardOps.createProject({
    name: `BZ job: ${title}`,
    description: `Shop floor for BeeZilla job ${jobId} (approved version ${acceptedVersion}).`,
    ownerUserId: userId,
  });
  const agentName = `bz-job-${slugSuffix(jobId)}`;
  await boardOps.registerAgent({
    name: agentName,
    harness: "hermes",
    role: "worker",
    skills: ["buzzy-job"],
    projectId: project.id,
  });

  const ingest = await boardOps.ingestGitHubIssue({
    issue: {
      number: Math.abs(hashCode(jobId)) % 900000 + 100000,
      title: `Deliver approved work: ${title}`,
      body: [
        `BeeZilla job ${jobId}, approved at document version ${acceptedVersion}.`,
        "",
        "## Approved output (exact version)",
        draft.slice(0, 6000),
        "",
        "## Acceptance",
        "- Deliver exactly what the approved version states; changes need a new approval.",
      ].join("\n"),
      html_url: `https://internal.beezilla/jobs/${jobId}`,
      state: "open",
    },
    repository: { full_name: "beezilla/jobs" },
    projectId: project.id,
  });

  const missionId = (ingest as { mission?: { id?: string } })?.mission?.id ?? "";
  const execution: ExecutionLink = {
    projectId: project.id,
    agentName,
    missionId,
    acceptedVersion,
    createdAt: new Date().toISOString(),
  };
  await sql`
    UPDATE buzzy_jobs
    SET data = COALESCE(data, '{}'::jsonb) || ${JSON.stringify({ execution })}::jsonb,
        updated_at = now()
    WHERE id = ${jobId} AND user_id = ${userId}
  `;
  return { ok: true, created: true, execution };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return h;
}
