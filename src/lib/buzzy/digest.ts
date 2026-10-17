/**
 * Buzzy weekly digest — the plain-language activity log (plan doc 23, #7).
 *
 * Phase 0's usage columns make this possible: every assistant turn now
 * carries prompt/completion/total tokens, latency, and the model that served
 * it. This module folds a trailing window of those rows into a civilian
 * summary: what the harness did for the owner, and roughly what it cost.
 *
 * Civilian bar: NOTHING token/latency/model-jargon-shaped may appear in the
 * rendered strings — "words processed", "about $X", "a smarter model" only.
 * The structured numbers are for the digest card's own math, not display.
 */

/** Rough per-token blend rate (USD). Approximate on purpose — the digest
 *  labels every dollar figure as an estimate. Tuned to the flash-tier blend
 *  on the Nous catalog; reasoning-model turns cost more and are disclosed in
 *  words instead of dollars. */
const ESTIMATED_USD_PER_TOKEN = 0.000002;

/** Models whose id/label matches this are the pricier reasoning tier. */
const REASONING_PATTERN = /think|reason|kimi|qwen.*think/i;

export interface WeeklyDigest {
  /** Trailing window length in days (7 x weeks). */
  windowDays: number;
  /** Assistant turns served in the window. */
  turns: number;
  /** Total tokens across those turns — "words processed" in the UI. */
  wordsProcessed: number;
  /** Average response time in ms — internal only, never displayed raw. */
  avgResponseMs: number | null;
  /** Approximate cost in USD — always labeled as an estimate when shown. */
  dollarsEstimate: number;
  /** Drafts created in the window. */
  draftsCreated: number;
  /** Drafts the owner approved in the window. */
  draftsApproved: number;
  /** Distinct models that served turns (raw ids — internal bookkeeping). */
  modelsUsed: string[];
  /** Civilian sentences for the digest card. */
  notes: string[];
}

function civilianDollars(usd: number): string {
  if (usd < 0.005) return "under a penny";
  if (usd < 0.1) return `about ${(usd * 100).toFixed(0)} cents`;
  if (usd < 1) return `about $${usd.toFixed(2)}`;
  return `about $${usd.toFixed(2)}`;
}

/**
 * Build the weekly digest for one owner from real rows — never mocked.
 * @param sql — the tagged-template sql client from getSql().
 * @param userId — the owner.
 * @param opts.weeks — window width, 1–4 weeks (default 1).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function buildWeeklyDigest(
  sql: any,
  userId: string,
  opts?: { weeks?: number },
): Promise<WeeklyDigest> {
  const weeks = Math.min(Math.max(opts?.weeks ?? 1, 1), 4);
  const windowDays = weeks * 7;

  const usageRows = (await sql`
    SELECT
      COUNT(*)                                           AS turns,
      COALESCE(SUM(total_tokens), 0)                     AS total_tokens,
      COALESCE(AVG(latency_ms), 0)                       AS avg_latency_ms,
      COUNT(DISTINCT model)                              AS distinct_models
    FROM buzzy_chat_messages
    WHERE user_id = ${userId}
      AND role = 'assistant'
      AND created_at >= now() - (${windowDays} || ' days')::interval
  `) as Array<{ turns: string | number; total_tokens: string | number; avg_latency_ms: string | number; distinct_models: string | number }>;

  const modelRows = (await sql`
    SELECT model, COUNT(*) AS turns
    FROM buzzy_chat_messages
    WHERE user_id = ${userId}
      AND role = 'assistant'
      AND model IS NOT NULL
      AND created_at >= now() - (${windowDays} || ' days')::interval
    GROUP BY model
    ORDER BY turns DESC
  `) as Array<{ model: string; turns: string | number }>;

  const jobRows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE data->>'draft' IS NOT NULL)                      AS drafts_created,
      COUNT(*) FILTER (WHERE data->>'approved' = 'true')                      AS drafts_approved
    FROM buzzy_jobs
    WHERE user_id = ${userId}
      AND updated_at >= now() - (${windowDays} || ' days')::interval
  `) as Array<{ drafts_created: string | number; drafts_approved: string | number }>;

  const u = usageRows[0] ?? { turns: 0, total_tokens: 0, avg_latency_ms: 0, distinct_models: 0 };
  const j = jobRows[0] ?? { drafts_created: 0, drafts_approved: 0 };

  const turns = Number(u.turns) || 0;
  const wordsProcessed = Number(u.total_tokens) || 0;
  const avgResponseMs = turns > 0 ? Math.round(Number(u.avg_latency_ms)) : null;
  const draftsCreated = Number(j.drafts_created) || 0;
  const draftsApproved = Number(j.drafts_approved) || 0;
  const dollarsEstimate = wordsProcessed * ESTIMATED_USD_PER_TOKEN;

  const modelsUsed = modelRows.map((r) => r.model).filter(Boolean);
  const reasoningTurns = modelRows
    .filter((r) => REASONING_PATTERN.test(r.model))
    .reduce((acc, r) => acc + (Number(r.turns) || 0), 0);

  // ── Civilian notes ──────────────────────────────────────────────────
  const notes: string[] = [];
  if (turns === 0) {
    notes.push("A quiet week — no conversations yet. Say hello any time.");
  } else {
    notes.push(`${turns} conversation${turns === 1 ? "" : "s"} this week.`);
    if (draftsCreated > 0) {
      notes.push(
        `${draftsCreated} draft${draftsCreated === 1 ? "" : "s"} ready` +
          (draftsApproved > 0 ? `, ${draftsApproved} approved by you.` : " — waiting on your review."),
      );
    } else {
      notes.push("No finished drafts yet this week.");
    }
    notes.push(`This cost ${civilianDollars(dollarsEstimate)} (an estimate).`);
    if (reasoningTurns > 0) {
      notes.push(
        `A smarter model handled ${reasoningTurns} of your ${turns} conversations — it costs a bit more but handles the tricky legal and technical work.`,
      );
    }
  }

  return {
    windowDays,
    turns,
    wordsProcessed,
    avgResponseMs,
    dollarsEstimate,
    draftsCreated,
    draftsApproved,
    modelsUsed,
    notes,
  };
}


/** ── Pricing surface (plan doc 23, stack item 12) ───────────────────────
 * Per-job cost estimate disclosed BEFORE the loop runs, and the
 * free-until-first-file promise. No billing system exists yet — this is the
 * trust surface: the estimate, the free promise, and the receipt (the
 * weekly digest) that a later billing integration must reconcile with.
 */

export const FREE_UNTIL_FIRST_FILE = true;

/** Rough civilian estimate for a job before it runs. */
export async function buildJobEstimate(
  sql: any,
  userId: string,
  hasFileTool: boolean,
): Promise<{ estimateLow: number; estimateHigh: number; civilian: string; free: boolean }> {
  const rows = (await sql`
    SELECT COALESCE(AVG(total_tokens), 800) AS avg_tokens
    FROM buzzy_chat_messages
    WHERE user_id = ${userId} AND role = 'assistant' AND created_at >= now() - interval '30 days'
  `) as Array<{ avg_tokens: string | number }>;
  const avgTokens = Math.max(Number(rows[0]?.avg_tokens) || 800, 400);
  // A loop job runs the same turn 2-4x; document turns run heavier.
  const expectedLow = Math.round(avgTokens * (hasFileTool ? 2.5 : 1.2));
  const expectedHigh = Math.round(avgTokens * (hasFileTool ? 4 : 1.8));
  const low = expectedLow * 0.000002;
  const high = expectedHigh * 0.000002;
  const fmt = (v: number) => (v < 0.01 ? "under a penny" : `about $${v.toFixed(2)}`);
  return {
    estimateLow: low,
    estimateHigh: high,
    civilian: `This should cost ${fmt(low)} to ${fmt(high)} (an estimate). Your first real file was free.`,
    free: FREE_UNTIL_FIRST_FILE,
  };
}

/** Has this owner already had their free first real file? */
export async function hasFirstFile(sql: any, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM buzzy_jobs
    WHERE user_id = ${userId} AND data->>'approved' = 'true' AND data->'artifact' IS NOT NULL
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}
