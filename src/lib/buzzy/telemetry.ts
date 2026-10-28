/**
 * BZ-F039 — success telemetry and journey verification.
 *
 * Business signal is ACCEPTED, RETRIEVABLE, USEFUL OUTPUTS — never chat
 * counts, tokens or mission volume. Infrastructure uptime is supporting only.
 *
 * Privacy: events carry identity (user/job/doc ids), revisions and small
 * enums. The recorder strips anything that looks like content, so a raw
 * message, brief or draft can never land in telemetry even by accident.
 */

export const TELEMETRY_EVENTS = [
  "project_started",
  "brief_confirmed",
  "draft_shown",
  "approval_recorded",
  "run_started",
  "needs_you_answered",
  "artifact_saved",
  "check_failed",
  "check_passed",
  "exported",
  "human_accepted",
  "reopened",
  "retrieved",
] as const;

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(TELEMETRY_EVENTS);

/** Keys that must never appear in telemetry props (content, not identity). */
const CONTENT_KEY = /(content|draft|message|body|text|brief|prompt|question|answer|transcript|note|email|address)/i;

/** Identity/structural props we accept. Everything else is dropped. */
const ALLOWED_KEYS = new Set([
  "version", "fromVersion", "toVersion", "jobId", "docId", "starter", "playbook",
  "template", "kind", "channel", "role", "action", "status", "code", "count",
  "ms", "phase", "expert", "policyVersion", "label", "reason", "surface",
  "format", "check", "verdict", "step", "outcome",
]);

export function scrubProps(input: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (CONTENT_KEY.test(key)) continue;
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof raw === "string") out[key] = raw.slice(0, 64);
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = raw;
  }
  return out;
}

interface SqlLike {
  (strings: TemplateStringsArray, ...args: unknown[]): Promise<unknown>;
}

/**
 * Record one telemetry event. Never throws into the request path — losing a
 * metric must not break the owner's work.
 */
export async function recordTelemetry(
  sql: SqlLike,
  input: { userId: string; jobId?: string | null; docId?: string | null; event: string; props?: Record<string, unknown> },
): Promise<void> {
  try {
    if (!EVENT_SET.has(input.event)) return;
    const props = scrubProps(input.props);
    await sql`
      INSERT INTO buzzy_telemetry (user_id, job_id, doc_id, event, props)
      VALUES (${input.userId}, ${input.jobId ?? null}, ${input.docId ?? null}, ${input.event},
              ${JSON.stringify(props)}::jsonb)
    `;
  } catch (err) {
    console.error("[buzzy/telemetry] record failed:", err instanceof Error ? err.message : err);
  }
}

export interface SuccessSummary {
  acceptedOutputs: number;
  retrievableOutputs: number;
  usefulOutputs: number;
  revisions: number;
  checksFailed: number;
  checksPassed: number;
  approvalRate: number | null;
  exported: number;
  reopened: number;
  events: Record<string, number>;
  windowDays: number;
}

/**
 * Success summary over a window. Useful = accepted AND retrieved (the owner
 * came back for it), which is the only signal that matters commercially.
 */
export async function successSummary(sql: SqlLike, userId: string, days = 30): Promise<SuccessSummary> {
  const rows = (await sql`
    SELECT event, count(*)::int AS n FROM buzzy_telemetry
    WHERE user_id = ${userId} AND created_at > now() - (${days} || ' days')::interval
    GROUP BY event
  `) as Array<{ event: string; n: number }>;
  const events: Record<string, number> = {};
  for (const r of rows) events[r.event] = Number(r.n);

  const accepted = (await sql`
    SELECT count(DISTINCT doc_id)::int AS n FROM buzzy_telemetry
    WHERE user_id = ${userId} AND event = 'human_accepted' AND doc_id IS NOT NULL
  `) as Array<{ n: number }>;
  const retrievable = (await sql`
    SELECT count(DISTINCT t.doc_id)::int AS n FROM buzzy_telemetry t
    WHERE t.user_id = ${userId} AND t.event = 'retrieved' AND t.doc_id IS NOT NULL
      AND t.doc_id IN (SELECT doc_id FROM buzzy_telemetry
                       WHERE user_id = ${userId} AND event = 'human_accepted' AND doc_id IS NOT NULL)
  `) as Array<{ n: number }>;
  const useful = (await sql`
    SELECT count(DISTINCT a.doc_id)::int AS n FROM buzzy_telemetry a
    JOIN buzzy_telemetry r ON r.doc_id = a.doc_id AND r.user_id = a.user_id AND r.event = 'retrieved'
    WHERE a.user_id = ${userId} AND a.event = 'human_accepted' AND a.doc_id IS NOT NULL
  `) as Array<{ n: number }>;

  const drafts = events.draft_shown ?? 0;
  const approvals = events.approval_recorded ?? 0;
  return {
    acceptedOutputs: Number(accepted[0]?.n ?? 0),
    retrievableOutputs: Number(retrievable[0]?.n ?? 0),
    usefulOutputs: Number(useful[0]?.n ?? 0),
    revisions: events.reopened ?? 0,
    checksFailed: events.check_failed ?? 0,
    checksPassed: events.check_passed ?? 0,
    approvalRate: drafts > 0 ? Math.round((approvals / drafts) * 100) / 100 : null,
    exported: events.exported ?? 0,
    reopened: events.reopened ?? 0,
    events,
    windowDays: days,
  };
}

export const TELEMETRY_DISCLOSURE = {
  collects: "Event names with your account, job and document identifiers, document versions and small outcomes (for example which checks passed or failed).",
  neverCollects: "Chat messages, briefs, document drafts or any file contents. The recorder drops content-shaped fields at write time.",
  purpose: "Measure whether outputs are accepted, retrievable and reused — not how many chats or tokens were spent.",
  retentionDays: 540,
  control: "Deleting your account removes telemetry with everything else; no third-party analytics or advertising trackers are used.",
};
