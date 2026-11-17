/**
 * Video recipes — the Breadcrumbs kit behind one shared token.
 *
 * The kit is proprietary and lives outside BeeZilla: a render service
 * (`engines/tips/serve.py` + `worker.py`) that takes a topic and returns a ~45s
 * 1080x1350 MP4 with voice, captions, music, a thumbnail and post text. BeeZilla
 * never runs the render; it starts a job, polls it, and stores the outputs.
 *
 * Three rules this file exists to enforce:
 *
 *  1. The token never leaves the server. It comes from BZ_VIDEO_KIT_TOKEN and is
 *     sent only as `X-Kit-Token` on server-to-server calls. The browser sees a
 *     BeeZilla asset URL, never a kit URL.
 *  2. The token can read ANY job on the kit. So a kit job id is meaningless to
 *     BeeZilla unless `buzzy_video_jobs` says this user started it — ownership is
 *     checked here, not trusted from the caller.
 *  3. A topic is the person's own words. It is sent to the kit and never written
 *     to a log line or to Postgres; the row keeps sha256(topic) only.
 *
 * Shane's decisions, 2026-11-17 15:46 ET (room 6615):
 *   - the script is written by Gemini Flash (TEXT_MODEL=gemini-flash-latest);
 *   - no Breadcrumbs end card on public videos (brand off, QC must not fail a job
 *     for a missing card);
 *   - all five recipes are in scope, not just the chalkboard;
 *   - DAILY_LIMIT_PER_USER=5.
 * The constants below default to exactly those values, so a deployment that sets
 * nothing still runs the product Shane signed off. Every one of them can be
 * overridden by the service environment.
 */
import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";

const env = (k: string) => (process.env[k] ?? "").trim();

/** Render service base URL, e.g. https://video.internal:8080 — no trailing slash. */
const BASE = env("BZ_VIDEO_BASE").replace(/\/+$/, "");
const TOKEN = env("BZ_VIDEO_KIT_TOKEN");

/** Gemini Flash writes the script (TEXT_MODEL on the kit side). */
export const VIDEO_WRITER = env("BZ_VIDEO_TEXT_MODEL") || "gemini-flash-latest";
/** End card OFF by default: public videos carry no Breadcrumbs brand. */
export const VIDEO_BRAND = env("BZ_VIDEO_BRAND") === "1";
/** Five videos per user per UTC day. The kit enforces it; we count too so the
 *  refusal is instant and the person never spends a queue slot learning it. */
export const VIDEO_DAILY_LIMIT = Math.max(1, Number(env("BZ_VIDEO_DAILY_LIMIT") || 5));

export type VideoRecipeId =
  | "explain-on-a-chalkboard"
  | "paper-cut-tips"
  | "chart-race"
  | "picture-reel"
  | "narrated-explainer";

export interface VideoRecipe {
  id: VideoRecipeId;
  /** What the person sees on the Recipes page. */
  label: string;
  /** One line for the card and for the tool description. */
  blurb: string;
}

/**
 * The five recipes in Shane's Thursday scope. The ids are the kit's recipe ids
 * (`recipes/<id>.recipe.json`); `explain-on-a-chalkboard` is confirmed by the kit
 * brief, the other four are the same kebab-case convention and must be checked
 * against the kit's `recipes/` directory the moment it is readable.
 */
export const VIDEO_RECIPES: VideoRecipe[] = [
  {
    id: "explain-on-a-chalkboard",
    label: "Explain it on a chalkboard",
    blurb: "A hand-drawn chalkboard explainer of any topic, 45 seconds, voiced and captioned.",
  },
  {
    id: "paper-cut-tips",
    label: "Paper-cut tips",
    blurb: "Paper-cutout style tips on a topic — three or four short points, one per cut.",
  },
  {
    id: "chart-race",
    label: "Chart race",
    blurb: "A racing bar chart of numbers you give it — who is ahead, and by how much.",
  },
  {
    id: "picture-reel",
    label: "Picture reel",
    blurb: "A reel of pictures with a caption line each, cut to the beat.",
  },
  {
    id: "narrated-explainer",
    label: "Narrated explainer",
    blurb: "A narrated explainer with clean full-bleed scenes, no drawing.",
  },
];

export function recipeById(id: string): VideoRecipe | undefined {
  return VIDEO_RECIPES.find((r) => r.id === id);
}

export function videoConfigured(): boolean {
  return Boolean(BASE && TOKEN);
}

export function videoWriter(): string {
  return VIDEO_WRITER;
}

// ── The kit's HTTP surface ───────────────────────────────────────────────

export interface KitJob {
  /** Discriminant: a job read is either this or a KitFailure. */
  ok: true;
  jobId: string;
  state: "queued" | "running" | "done" | "failed";
  etaMinutes?: number;
  message?: string;
  files?: string[];
}

export interface KitFailure {
  ok: false;
  code: string;
  error: string;
  /** 429 daily limit and 503 queue-full are the person's own to act on: retry
   *  later, not a support ticket. */
  retryable?: boolean;
}

/**
 * Request body for POST /jobs.
 *
 * The kit brief fixes the response (202 { job_id, state, eta_minutes }) and the
 * failure codes (400 bad topic / 401 bad token / 429 daily limit / 503 queue
 * full) but not the request field names. They live in ONE function so the day
 * JOB-CONTRACT.md is readable this is a one-line correction, not a hunt through
 * the codebase. `brand` is what turns the Breadcrumbs end card off.
 */
function jobBody(input: { recipe: VideoRecipeId; topic: string; userId: string }): Record<string, unknown> {
  return {
    recipe: input.recipe,
    topic: input.topic,
    user_id: input.userId,
    brand: VIDEO_BRAND,
    text_model: VIDEO_WRITER,
  };
}

/** Human sentences for the refusals a person will actually meet. */
function explain(status: number, body: string): KitFailure {
  let message = "";
  try {
    const j = JSON.parse(body) as { message?: string; detail?: string; error?: string };
    message = j.message || j.detail || j.error || "";
  } catch {
    message = body.slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return { ok: false, code: "bad_token", error: "The video service rejected BeeZilla's kit token." };
  }
  if (status === 400) {
    // The kit refuses a topic it will not render (the safety refusal). Nothing
    // was charged: failures are never charged.
    return { ok: false, code: "topic_refused", error: message || "That topic cannot be made into a video." };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "daily_limit",
      retryable: true,
      error: message || `That is today's ${VIDEO_DAILY_LIMIT}-video limit — it resets tomorrow.`,
    };
  }
  if (status === 503) {
    return {
      ok: false,
      code: "queue_full",
      retryable: true,
      error: message || "The video queue is full right now — try again in a few minutes.",
    };
  }
  return { ok: false, code: "kit_failed", error: message || `The video service answered ${status}.` };
}

function headers(): Record<string, string> {
  return { "content-type": "application/json", "x-kit-token": TOKEN };
}

/**
 * POST /jobs — start one render. Returns in about a second; the work is async.
 *
 * Split from `createVideoJob` so the HTTP contract is testable without Postgres:
 * `startKitJob` is the kit, `createVideoJob` adds BeeZilla's ownership record.
 */
export async function startKitJob(input: {
  recipe: VideoRecipeId;
  topic: string;
  userId: string;
}): Promise<{ ok: true; jobId: string; state: string; etaMinutes: number } | KitFailure> {
  if (!videoConfigured()) {
    return { ok: false, code: "not_configured", error: "No video service is configured on this deployment." };
  }
  const topic = input.topic.trim().slice(0, 500);
  if (!topic) return { ok: false, code: "no_topic", error: "Give me a topic and I will make the video." };

  let res: Response;
  try {
    res = await fetch(`${BASE}/jobs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(jobBody({ ...input, topic })),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, code: "unreachable", error: `Could not reach the video service: ${(e as Error).message.slice(0, 120)}` };
  }
  const body = await res.text();
  if (!res.ok) return explain(res.status, body);

  let parsed: { job_id?: string; id?: string; state?: string; eta_minutes?: number };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { ok: false, code: "bad_response", error: "The video service answered without a job id." };
  }
  const jobId = parsed.job_id || parsed.id || "";
  if (!jobId) return { ok: false, code: "bad_response", error: "The video service answered without a job id." };
  return {
    ok: true,
    jobId,
    state: parsed.state || "queued",
    etaMinutes: Math.max(1, Math.round(Number(parsed.eta_minutes) || 5)),
  };
}

/** Start a render AND record who owns it. The id is only handed out after the
 *  ownership row exists — a job BeeZilla cannot attribute is a job nobody may poll. */
export async function createVideoJob(input: {
  recipe: VideoRecipeId;
  topic: string;
  userId: string;
}): Promise<{ ok: true; jobId: string; state: string; etaMinutes: number } | KitFailure> {
  const started = await startKitJob(input);
  if (!started.ok) return started;
  await recordVideoJob(input.userId, started.jobId, input.recipe, input.topic);
  return started;
}

/** GET /jobs/<id> — the poll. `files` appears only once the render is done. */
export async function readVideoJob(jobId: string): Promise<KitJob | KitFailure> {
  if (!videoConfigured()) {
    return { ok: false, code: "not_configured", error: "No video service is configured on this deployment." };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, code: "unreachable", error: `Could not reach the video service: ${(e as Error).message.slice(0, 120)}` };
  }
  const body = await res.text();
  if (!res.ok) return explain(res.status, body);
  let j: { job_id?: string; id?: string; state?: string; eta_minutes?: number; message?: string; files?: unknown };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    return { ok: false, code: "bad_response", error: "The video service answered with something that is not JSON." };
  }
  const state = String(j.state || "queued").toLowerCase();
  const known = state === "queued" || state === "running" || state === "done" || state === "failed";
  return {
    ok: true,
    jobId: j.job_id || j.id || jobId,
    state: (known ? state : "running") as KitJob["state"],
    etaMinutes: j.eta_minutes == null ? undefined : Number(j.eta_minutes),
    message: j.message,
    files: Array.isArray(j.files) ? (j.files as unknown[]).map(String) : undefined,
  };
}

/**
 * GET /jobs/<id>/files/<name> — one output.
 *
 * Filenames come from the kit, not from the caller, and are re-validated here: a
 * name with a separator or a dot-dot is a path traversal attempt against a
 * service that also serves its own directory.
 */
export async function fetchVideoFile(
  jobId: string,
  name: string,
): Promise<{ ok: true; bytes: Buffer; contentType: string } | KitFailure> {
  if (!videoConfigured()) {
    return { ok: false, code: "not_configured", error: "No video service is configured on this deployment." };
  }
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || name.includes("..")) {
    return { ok: false, code: "bad_filename", error: "That is not one of the job's output files." };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`, {
      headers: { "x-kit-token": TOKEN },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return { ok: false, code: "unreachable", error: `Could not fetch the file: ${(e as Error).message.slice(0, 120)}` };
  }
  if (!res.ok) return explain(res.status, await res.text().catch(() => ""));
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || guessType(name);
  return { ok: true, bytes, contentType };
}

function guessType(name: string): string {
  if (/\.mp4$/i.test(name)) return "video/mp4";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.txt$/i.test(name)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/**
 * The tool the model calls to make a video.
 *
 * `recipe` is an enum of the five, and `topic` is the thing to explain — not the
 * request. The harness starts the render either way (intent.ts decides before the
 * model is asked), but the model needs the tool so that a follow-up like "now one
 * about volcanoes, paper-cut style" is a job rather than a paragraph.
 */
export const GENERATE_VIDEO_TOOL = {
  type: "function",
  function: {
    name: "generate_video",
    description:
      "Make a short vertical video (about 45 seconds, 1080x1350, with voice, captions, music, " +
      "thumbnail and post text) and save it to the owner's Library. Use when the owner asks for " +
      "an infographic, a chalkboard video, a chart race, a paper-cut tips video, a picture reel " +
      "or a narrated explainer. Pass the topic in the owner's words, not the whole request. " +
      "The render takes minutes and returns a job; never claim a video exists until the job is done.",
    parameters: {
      type: "object",
      properties: {
        recipe: {
          type: "string",
          enum: VIDEO_RECIPES.map((r) => r.id),
          description:
            "Which recipe to run. explain-on-a-chalkboard is the hand-drawn explainer; " +
            "paper-cut-tips is cut-out tips; chart-race is a racing bar chart; picture-reel is " +
            "pictures cut to the beat; narrated-explainer is a plain narrated explainer.",
        },
        topic: {
          type: "string",
          description: "What the video explains, in the owner's own words. Example: 'the water cycle'.",
        },
      },
      required: ["recipe", "topic"],
    },
  },
} as const;

// ── BeeZilla's own record: ownership and the daily count ─────────────────
function topicHash(topic: string): string {
  return createHash("sha256").update(topic.trim().toLowerCase()).digest("hex");
}

export async function recordVideoJob(
  userId: string,
  jobId: string,
  recipe: VideoRecipeId,
  topic: string,
): Promise<void> {
  const sql = await getSql();
  await sql`
    INSERT INTO buzzy_video_jobs (job_id, user_id, recipe, topic_sha, state)
    VALUES (${jobId}, ${userId}, ${recipe}, ${topicHash(topic)}, 'queued')
    ON CONFLICT (job_id) DO NOTHING
  `;
}

/** Does this user own this kit job? The only thing that makes an id pollable. */
export async function videoJobOwnedBy(userId: string, jobId: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ job_id: string }>`
    SELECT job_id FROM buzzy_video_jobs WHERE job_id = ${jobId} AND user_id = ${userId} LIMIT 1
  `;
  return rows.length > 0;
}

export async function noteVideoState(jobId: string, state: string, message?: string | null): Promise<void> {
  const sql = await getSql();
  await sql`
    UPDATE buzzy_video_jobs SET state = ${state}, message = ${message ?? null}, updated_at = now()
    WHERE job_id = ${jobId}
  `;
}

/** Videos this user started today (UTC). Failed jobs are never charged, so they
 *  do not count against the limit — the kit's own counter is authoritative, this
 *  is the same rule applied early. */
export async function videoJobsToday(userId: string): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM buzzy_video_jobs
    WHERE user_id = ${userId}
      AND state <> 'failed'
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
  `;
  return Number(rows[0]?.n ?? 0);
}

/** One asset row, same shelf and download route as every other file. */
export async function storeVideoAsset(
  userId: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<{ id: number; bytes: number; duplicate: boolean }> {
  const sql = await getSql();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const inserted = await sql<{ id: number }>`
    INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body)
    VALUES (${userId}, ${sha256}, ${filename}, ${filename}, ${contentType}, ${bytes.byteLength}, ${bytes})
    ON CONFLICT (user_id, sha256) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) return { id: Number(inserted[0]!.id), bytes: bytes.byteLength, duplicate: false };
  const existing = await sql<{ id: number }>`
    SELECT id FROM buzzy_assets WHERE user_id = ${userId} AND sha256 = ${sha256} LIMIT 1
  `;
  return { id: Number(existing[0]?.id ?? 0), bytes: bytes.byteLength, duplicate: true };
}

/**
 * The pair of things the kit promises, classified so the caller does not have to
 * guess which file is the video: the first mp4, the first image, the first text.
 */
export function classifyFiles(files: string[]): { video?: string; thumb?: string; postText?: string } {
  return {
    video: files.find((f) => /\.mp4$/i.test(f)),
    thumb: files.find((f) => /\.(jpe?g|png|webp)$/i.test(f)),
    postText: files.find((f) => /\.(txt|md)$/i.test(f)),
  };
}
