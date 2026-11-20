/**
 * CR-9 phase E — the deal-memo run record.
 *
 * The runner is in-process and detached: the chat turn starts it and answers,
 * and the page polls `GET /api/buzzy/deal-memo/<id>`. That makes the database
 * row, not a promise, the source of truth about a run. Three rules follow, and
 * they are the whole point of this module:
 *
 *  1. A job reaches `done` only after the files are stored and the checks have
 *     passed. Nothing in this file may mark a job done.
 *  2. A job that was queued or running when the process died is `interrupted`
 *     with "nothing charged". `sweepInterrupted()` is called at boot, and it is
 *     the only writer of that state — a redeploy cannot land in `done`.
 *  3. Stage notes and the inputs manifest carry counts and hashes only. A rent
 *     roll names tenants and rents, and this table is readable by support.
 *
 * State vocabulary: queued | running | done | failed | interrupted.
 * Stage vocabulary: pending | running | done | failed | skipped | interrupted.
 */

import { randomBytes } from "node:crypto";

/** The query shape both PGlite (tests) and node-postgres (production) satisfy. */
export type DealMemoQuery = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

export type DealMemoState = "queued" | "running" | "done" | "failed" | "interrupted";
export type DealMemoStageState = "pending" | "running" | "done" | "failed" | "skipped" | "interrupted";

export interface DealMemoJobRow {
  job_id: string;
  user_id: string;
  recipe_hash: string;
  owner_host: string;
  title: string | null;
  state: DealMemoState;
  message: string | null;
  charged_cents: number;
  /** F: what the Honey Drops ledger moved. Cents stay 0 for this lane. */
  charged_drops: number;
  inputs: unknown;
  summary: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface DealMemoStageRow {
  id: number;
  job_id: string;
  seq: number;
  stage_key: string;
  label: string;
  state: DealMemoStageState;
  note: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface DealMemoFileRow {
  id: number;
  filename: string;
  rel_path: string;
  content_type: string | null;
  bytes: number;
  url: string;
}

/** A job id that cannot be guessed from another user's. */
export function newDealMemoJobId(): string {
  return `djm_${randomBytes(12).toString("hex")}`;
}

export async function createDealMemoJob(
  q: DealMemoQuery,
  input: {
    jobId?: string;
    userId: string;
    recipeHash: string;
    /** The service hosting the run; defaults to this process's service name. */
    ownerHost?: string;
    title?: string | null;
    /** Intake ledger only — see the note at the top of this file. */
    inputs?: unknown;
  },
): Promise<DealMemoJobRow> {
  const jobId = input.jobId ?? newDealMemoJobId();
  const rows = await q<DealMemoJobRow>(
    `INSERT INTO buzzy_deal_memo_jobs (job_id, user_id, recipe_hash, owner_host, title, state, inputs)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6::jsonb)
     RETURNING *`,
    [
      jobId,
      input.userId,
      input.recipeHash,
      input.ownerHost ?? process.env.RAILWAY_SERVICE_NAME ?? process.env.HOSTNAME ?? "",
      input.title ?? null,
      JSON.stringify(input.inputs ?? {}),
    ],
  );
  if (!rows[0]) throw new Error("DEAL_MEMO_JOB the run row was not written");
  return rows[0];
}

/** queued -> running. Idempotent so a resumed poll cannot fail the run. */
export async function markDealMemoRunning(q: DealMemoQuery, jobId: string): Promise<void> {
  await q(
    `UPDATE buzzy_deal_memo_jobs
        SET state = CASE WHEN state = 'queued' THEN 'running' ELSE state END,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE job_id = $1`,
    [jobId],
  );
}

export async function startDealMemoStage(
  q: DealMemoQuery,
  input: { jobId: string; seq: number; key: string; label: string },
): Promise<void> {
  await q(
    `INSERT INTO buzzy_deal_memo_stages (job_id, seq, stage_key, label, state, started_at)
     VALUES ($1, $2, $3, $4, 'running', now())
     ON CONFLICT (job_id, seq) DO UPDATE
       SET state = 'running',
           started_at = COALESCE(buzzy_deal_memo_stages.started_at, now()),
           label = EXCLUDED.label`,
    [input.jobId, input.seq, input.key, input.label],
  );
}

export async function finishDealMemoStage(
  q: DealMemoQuery,
  input: { jobId: string; seq: number; state: Exclude<DealMemoStageState, "pending" | "running">; note?: string | null },
): Promise<void> {
  await q(
    `UPDATE buzzy_deal_memo_stages
        SET state = $3, note = $4, finished_at = now()
      WHERE job_id = $1 AND seq = $2`,
    [input.jobId, input.seq, input.state, input.note ?? null],
  );
}

/**
 * The only transition a runner may use to end a run.
 *
 * `done` is accepted here because the runner calls it after storage; the route
 * and the reaper never do. Charged cents are written only on `done`, and the
 * argument is clamped to zero for every other state so a failed run cannot
 * carry a charge by accident.
 *
 * TERMINAL-STATE GUARD. Only a queued or running row can be finished. A late
 * finish — the process was swept as `interrupted` at boot while its detached
 * run was still alive, or a run finished twice — must not rewrite an already
 * terminal row: `interrupted, nothing charged` is a promise the product made,
 * and a second `done` must not attach a charge to work that was announced as
 * uncharged. Returns true when the transition applied, false when it was
 * refused, so tests and callers can tell the difference.
 */
export async function finishDealMemoJob(
  q: DealMemoQuery,
  input: {
    jobId: string;
    state: Exclude<DealMemoState, "queued" | "running">;
    message?: string | null;
    summary?: unknown;
    chargedCents?: number;
  },
): Promise<boolean> {
  const charged = input.state === "done" ? Math.max(0, Math.trunc(input.chargedCents ?? 0)) : 0;
  const rows = await q<{ job_id: string }>(
    `UPDATE buzzy_deal_memo_jobs
        SET state = $2,
            message = $3,
            summary = $4::jsonb,
            charged_cents = $5,
            -- F: the wallet unit. A finish never charges; chargeDealMemoRun does,
            -- and only after this returns true on a done transition.
            charged_drops = 0,
            finished_at = COALESCE(finished_at, now()),
            updated_at = now()
      WHERE job_id = $1
        AND state IN ('queued', 'running')
      RETURNING job_id`,
    [input.jobId, input.state, input.message ?? null, JSON.stringify(input.summary ?? null), charged],
  );
  return rows.length > 0;
}

/**
 * Fail every run that outlived its process.
 *
 * Called at boot (scripts/deal-memo-reaper.mjs) and by the ownership-less
 * maintenance path. The message is fixed text: "interrupted, nothing charged"
 * is a promise the product makes, so it is not composed per caller. Stages that
 * were pending or running move too, so the card cannot show a spinner on a run
 * that is never coming back.
 */
export async function sweepInterruptedDealMemoJobs(
  q: DealMemoQuery,
  opts: { host: string; staleHours?: number },
): Promise<{ jobs: number; stages: number }> {
  const staleHours = Math.max(1, Math.trunc(opts.staleHours ?? 2));
  // Two conditions, both honest:
  //  - owner_host = this service: the process that would have finished it is
  //    this one, and it has just started;
  //  - anything older than `staleHours`: a memo takes minutes, so a row this
  //    old is dead whoever started it. This also drains a renamed service.
  // A sibling service's live run is untouched, which is why this is not a
  // blanket UPDATE over every running row.
  const jobs = await q<{ job_id: string }>(
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
    [opts.host, String(staleHours)],
  );
  const stages = await q<{ id: number }>(
    `UPDATE buzzy_deal_memo_stages
        SET state = 'interrupted',
            note = COALESCE(note, 'the process ended before this step finished'),
            finished_at = COALESCE(finished_at, now())
      WHERE state IN ('pending', 'running')
        AND job_id IN (SELECT job_id FROM buzzy_deal_memo_jobs WHERE state = 'interrupted')
      RETURNING id`,
  );
  return { jobs: jobs.length, stages: stages.length };
}

export interface DealMemoJobView {
  job: DealMemoJobRow;
  stages: DealMemoStageRow[];
  files: DealMemoFileRow[];
}

/**
 * Read one run, scoped to its owner.
 *
 * Returns null when the job does not exist OR belongs to somebody else: the
 * caller answers 404 either way, because whether another person's run exists is
 * not this caller's business.
 */
export async function readDealMemoJob(
  q: DealMemoQuery,
  input: { userId: string; jobId: string },
): Promise<DealMemoJobView | null> {
  const jobs = await q<DealMemoJobRow>(
    `SELECT * FROM buzzy_deal_memo_jobs WHERE job_id = $1 AND user_id = $2 LIMIT 1`,
    [input.jobId, input.userId],
  );
  const job = jobs[0];
  if (!job) return null;
  const stages = await q<DealMemoStageRow>(
    `SELECT id, job_id, seq, stage_key, label, state, note, started_at, finished_at
       FROM buzzy_deal_memo_stages WHERE job_id = $1 ORDER BY seq ASC`,
    [input.jobId],
  );
  const files = await q<DealMemoFileRow>(
    `SELECT id, filename, rel_path, content_type, bytes
       FROM buzzy_assets WHERE job_id = $1 AND user_id = $2 ORDER BY id ASC`,
    [input.jobId, input.userId],
  );
  return {
    job,
    stages: stages.map((s) => ({ ...s, id: Number(s.id) })),
    files: files.map((f) => ({
      id: Number(f.id),
      filename: f.filename,
      rel_path: f.rel_path,
      content_type: f.content_type,
      bytes: Number(f.bytes),
      // The existing asset route; a memo is not a second download system.
      url: `/api/buzzy/assets/${Number(f.id)}`,
    })),
  };
}

/**
 * Which sealed bundle may this request run?
 *
 * The recipe hash is deployment configuration (BZ_DEAL_MEMO_RECIPE), never a
 * client choice: loadDealMemoMethod opens whatever hash it is handed if the KEK
 * can, so a caller that picked its own hash would be running a bundle the
 * product did not publish. The chat path has always used the configured hash;
 * the HTTP route now goes through this function so it cannot drift.
 *
 * Returns the refusal the route should send, or null when the request may run
 * on the configured hash. A caller that sends the configured hash (or none) is
 * fine; a caller that sends any other hash is told so rather than ignored.
 */
export function dealMemoRecipeRefusal(
  configuredHash: string | null,
  supplied: unknown[],
): "not_configured" | "recipe_fixed" | null {
  if (!configuredHash) return "not_configured";
  // Normalise BOTH sides. Comparing a lowercased client value against a
  // configured value as configured refuses a caller who sent the right hash in
  // capitals — a hex digest's case is not a different bundle.
  const published = configuredHash.trim().toLowerCase();
  if (!published) return "not_configured";
  const wants = supplied
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());
  return wants.some((h) => h !== published) ? "recipe_fixed" : null;
}

/** Runs started by this account in the last rolling 24h, for a daily cap. */
export async function dealMemoJobsToday(q: DealMemoQuery, userId: string): Promise<number> {
  const rows = await q<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM buzzy_deal_memo_jobs
      WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}
