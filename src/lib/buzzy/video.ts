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

/**
 * Videos a user may make per UTC day. ONE flat cap, identical on free, starter
 * and pro (room 6615, Shane, 2026-11-17 15:46 ET: `DAILY_LIMIT_PER_USER=5`; 6874
 * restates it as "5 videos per user per day"). There is no plan split and there
 * never was one — a per-plan table here was a product change with an invented
 * citation, and it is gone.
 *
 * The kit enforces the same flat number (`DAILY_LIMIT_PER_USER` on serve.py)
 * because it has no idea what a BeeZilla plan is; its 429 is the backstop, never
 * the product rule. `BZ_VIDEO_DAILY_LIMIT` is the only override, for ops. Never
 * reintroduce a plan argument: this signature takes none, so no caller can pass
 * a plan and silently disagree with the kit.
 */
export const DAILY_LIMIT_PER_USER = 5;

export function videoDailyLimit(): number {
  const override = Number(env("BZ_VIDEO_DAILY_LIMIT") || 0);
  return Math.max(1, override > 0 ? override : DAILY_LIMIT_PER_USER);
}

/**
 * The five recipe ids are the kit's own: the `recipe` string in each
 * `recipes/<id>.recipe.json`, verbatim. They are NOT a BeeZilla invention any
 * more — verified against the kit on 2026-11-17 (zip sha256 9793bbbc…8364):
 *
 *   explain-on-a-chalkboard.recipe.json       recipe "explain-on-a-chalkboard"        kind tips
 *   ai-creator-tips-paper-cut.recipe.json     recipe "ai-creator-tips-paper-cut"      kind tips (look paper)
 *   chart-race-from-your-numbers.recipe.json  recipe "chart-race-from-your-numbers"   kind chart
 *   picture-reel.recipe.json                  recipe "picture-reel"                   kind reel
 *   narrated-explainer.recipe.json            recipe "narrated-explainer"             kind explainer
 *
 * The kit does not take a recipe id on the wire: `POST /jobs` takes `kind` plus
 * that kind's own fields. So the id is BeeZilla's handle (it is what the Recipes
 * card and the DB row store) and `kind` is what the kit is told.
 */
export type VideoRecipeId =
  | "explain-on-a-chalkboard"
  | "ai-creator-tips-paper-cut"
  | "chart-race-from-your-numbers"
  | "picture-reel"
  | "narrated-explainer";

/** The four kinds `POST /jobs` accepts (`kind` defaults to `tips` if omitted). */
export type KitKind = "tips" | "chart" | "reel" | "explainer";

/** The seven chalk board colours (`board` is tips-only; paper ignores it). */
export const CHALK_BOARDS = ["forest", "ocean", "clay", "code", "crimson", "sky", "lagoon"] as const;
export type ChalkBoard = (typeof CHALK_BOARDS)[number];

/**
 * One thing the person must give for a recipe. This is the card's form, taken
 * from `ask_the_person` in each kit recipe file — the limits are the kit's own,
 * so the card and the job API cannot disagree about what is acceptable.
 */
export interface VideoAskField {
  id: "topic" | "question" | "table" | "source" | "unit" | "chart" | "format" | "board" | "pictures";
  type: "text" | "table" | "choice";
  required: boolean;
  label: string;
  placeholder?: string;
  minChars?: number;
  maxChars?: number;
  options?: string[];
}

export interface VideoRecipe {
  id: VideoRecipeId;
  kind: KitKind;
  /** What the person sees on the Recipes page. */
  label: string;
  /** One line for the card and for the tool description. */
  blurb: string;
  /** What the card must collect before it can call POST /jobs. */
  asks: VideoAskField[];
  /** The kit's own typical minutes; the job's `eta_minutes` is authoritative. */
  minutes: number;
}

const TOPIC_FIELD: VideoAskField = {
  id: "topic",
  type: "text",
  required: true,
  label: "What should the video be about?",
  minChars: 8,
  maxChars: 200,
};

/**
 * Every recipe the kit has. `asks` mirrors the kit's cards: four of them take one
 * topic; the chart race takes a question, a table and a source, which is why it
 * cannot be started from a sentence alone.
 *
 * This list is the *catalogue*, not what BeeZilla offers. What BeeZilla offers is
 * `VIDEO_RECIPES` below (the catalogue minus `HELD_BACK_RECIPES`); the wire
 * contract and the labels on old job rows still need the whole thing.
 */
export const ALL_VIDEO_RECIPES: VideoRecipe[] = [
  {
    id: "explain-on-a-chalkboard",
    kind: "tips",
    label: "Explain it on a chalkboard",
    blurb: "A hand-drawn chalkboard explainer of any topic, 45 seconds, voiced and captioned.",
    asks: [
      TOPIC_FIELD,
      {
        id: "board",
        type: "choice",
        required: false,
        label: "Board colour",
        options: [...CHALK_BOARDS],
      },
    ],
    minutes: 5,
  },
  {
    id: "ai-creator-tips-paper-cut",
    kind: "tips",
    label: "AI Creator Tips (paper-cut)",
    blurb: "Purple-and-orange torn-paper tips on a creator topic, voiced and captioned.",
    asks: [TOPIC_FIELD],
    minutes: 5,
  },
  {
    id: "chart-race-from-your-numbers",
    kind: "chart",
    label: "Chart race from your numbers",
    blurb: "A racing bar or line chart of numbers you paste — who is ahead, and by how much.",
    asks: [
      {
        id: "question",
        type: "text",
        required: true,
        label: "What question does the chart answer?",
        minChars: 8,
        maxChars: 80,
      },
      {
        id: "table",
        type: "table",
        required: true,
        label: "Your numbers (first column = date, one column per competitor)",
      },
      {
        id: "source",
        type: "text",
        required: true,
        label: "Where are the numbers from?",
        minChars: 3,
        maxChars: 120,
      },
      { id: "unit", type: "text", required: false, label: "Unit shown with the numbers", maxChars: 20 },
      { id: "chart", type: "choice", required: false, label: "Chart", options: ["bar", "line"] },
      {
        id: "format",
        type: "choice",
        required: false,
        label: "Shape",
        options: ["portrait", "square", "vertical"],
      },
    ],
    minutes: 3,
  },
  {
    id: "picture-reel",
    kind: "reel",
    label: "Picture reel",
    blurb: "A reel of pictures with a caption line each, cut to the beat.",
    asks: [TOPIC_FIELD],
    minutes: 7,
  },
  {
    id: "narrated-explainer",
    kind: "explainer",
    label: "Narrated explainer",
    blurb: "A narrated explainer with clean full-bleed scenes, no drawing.",
    asks: [TOPIC_FIELD],
    minutes: 12,
  },
];

/**
 * Recipes the kit has but BeeZilla is NOT offering yet, held back on purpose.
 *
 * Shane, 2026-11-19 (CR-1): "ships today with 4 of 5 recipes, picture-reel
 * later". The reason is the kit's own behaviour, not taste: with no seeded
 * picture library it refuses the job with `pictures_unavailable` rather than
 * half-rendering (verified 2026-11-19 against a 13 MB JPEG-only library), so
 * offering it would only turn a person's request into a failure.
 *
 * To switch it on, delete its id from this list — nothing else to change: the
 * recipe card, the tool enum and the chat pre-pass all read VIDEO_RECIPES.
 */
export const HELD_BACK_RECIPES: readonly VideoRecipeId[] = ["picture-reel"];

/** What the Recipes page, the chat pre-pass and `generate_video` offer. */
export const VIDEO_RECIPES: VideoRecipe[] = ALL_VIDEO_RECIPES.filter(
  (r) => !HELD_BACK_RECIPES.includes(r.id),
);

export function videoRecipeHeldBack(id: string): boolean {
  return (HELD_BACK_RECIPES as readonly string[]).includes(id);
}

/** The catalogue lookup: labels on old job rows and the kit's wire body need
 *  every recipe, including one that is held back from new jobs. */
export function recipeById(id: string): VideoRecipe | undefined {
  return ALL_VIDEO_RECIPES.find((r) => r.id === id);
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
  /** Only the create call carries an ETA (`kind` base + 5 per job ahead). The
   *  status call does not, so the page keeps the number it was given once. */
  etaMinutes?: number;
  message?: string;
  /** The kit's failure cause (`topic_refused`, `voice_unavailable`, …). */
  cause?: string;
  /** `true` only on done; the kit never charges a failure. */
  charge?: boolean;
  attempt?: number;
  seconds?: number;
  rounds?: number;
  /** The three files the kit exposes, by role. Named by the recipe
   *  (`<id>.mp4` for tips, `video.mp4` for a chart, `reel.mp4` for a reel,
   *  `<slug>.mp4` for an explainer), so the ROLE is the only stable key. */
  files?: KitJobFiles;
}

export interface KitJobFiles {
  video?: string;
  thumbnail?: string;
  post?: string;
}

export interface KitFailure {
  ok: false;
  code: string;
  error: string;
  /** 429 daily limit and 503 queue-full are the person's own to act on: retry
   *  later, not a support ticket. */
  retryable?: boolean;
}

/** A chart race's own input: the question, the table, and where the numbers came
 *  from. Four of the five recipes take one topic; this one cannot. */
export interface ChartInput {
  question: string;
  dataCsv: string;
  source: string;
  chart?: "bar" | "line";
  unit?: string;
  format?: "portrait" | "square" | "vertical";
  aiText?: boolean;
}

/** One render, as BeeZilla asks for it. The recipe id picks the shape; the
 *  discriminated union is what stops a chart job being sent without a table. */
export type VideoJobInput =
  | { recipe: "explain-on-a-chalkboard"; userId: string; topic: string; board?: ChalkBoard }
  | { recipe: "ai-creator-tips-paper-cut"; userId: string; topic: string }
  | { recipe: "chart-race-from-your-numbers"; userId: string; chart: ChartInput }
  | { recipe: "picture-reel"; userId: string; topic: string; pictures?: "library" | "ai" }
  | { recipe: "narrated-explainer"; userId: string; topic: string };

/** What the kit records as the job's own words — used only for the local
 *  sha256, never sent anywhere it is not already going. */
function inputSeed(input: VideoJobInput): string {
  return "chart" in input
    ? `${input.chart.question}\n${input.chart.source}\n${input.chart.dataCsv}`
    : input.topic;
}

/** The four recipes the chat path can start from a sentence. The chart race is
 *  excluded at the TYPE level because it needs a table: a harness that forgets
 *  cannot compile, which is better than a 400 at runtime. */
export type VideoTopicInput = {
  recipe: Exclude<VideoRecipeId, "chart-race-from-your-numbers">;
  userId: string;
  topic: string;
  board?: ChalkBoard;
  pictures?: "library" | "ai";
};

export function topicJobInput(t: VideoTopicInput): VideoJobInput {
  switch (t.recipe) {
    case "explain-on-a-chalkboard":
      return { recipe: t.recipe, userId: t.userId, topic: t.topic, board: t.board };
    case "ai-creator-tips-paper-cut":
      return { recipe: t.recipe, userId: t.userId, topic: t.topic };
    case "picture-reel":
      return { recipe: t.recipe, userId: t.userId, topic: t.topic, pictures: t.pictures };
    case "narrated-explainer":
      return { recipe: t.recipe, userId: t.userId, topic: t.topic };
  }
}

const collapse = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The `POST /jobs` body, built and validated against `engines/tips/JOB-CONTRACT.md`
 * and `serve.py` itself (read 2026-11-17). Every rule here is the kit's, and every
 * sentence is the kit's own wording, so a person never spends a queue slot to
 * learn something BeeZilla could have said instantly.
 *
 * Field names, exactly as serve.py reads them:
 *   tips      kind, topic (8–200), look (chalk|paper), board (7 colours)
 *   chart     kind, question (8–80), data_csv (non-empty, <200 KB),
 *             source (3–120), chart (bar|line), unit (≤20), format
 *             (portrait|square|vertical), ai_text (bool)
 *   reel      kind, topic, pictures (library|ai)
 *   explainer kind, topic
 *   all       user (an app user id, cut to 80 chars, default "anonymous")
 *
 * TWO THINGS THE KIT DOES NOT ACCEPT, and the old body sent anyway:
 *   - `recipe` — a recipe id is not a wire field. `kind` picks the script.
 *   - `brand` / `text_model` — unknown keys are ignored silently by serve.py, so
 *     sending them looked like it worked and did nothing. The end card is a
 *     per-script `--no-brand` flag on the RENDER side, and the writing model is
 *     `TEXT_MODEL` in the worker's environment. Neither belongs in a job body.
 */
export function kitJobBody(
  input: VideoJobInput,
): { ok: true; body: Record<string, unknown> } | KitFailure {
  const recipe = recipeById(input.recipe);
  if (!recipe) return { ok: false, code: "bad_recipe", error: "That is not a recipe the kit has." };
  const user = (collapse(input.userId) || "anonymous").slice(0, 80);

  if (recipe.kind === "chart") {
    const c = (input as { chart?: ChartInput }).chart;
    if (!c) {
      return {
        ok: false,
        code: "needs_table",
        error: "A chart race needs a question, the numbers as a table, and where they came from.",
      };
    }
    const question = collapse(c.question);
    const source = collapse(c.source);
    const dataCsv = String(c.dataCsv ?? "");
    if (question.length < 8 || question.length > 80) {
      return { ok: false, code: "invalid_input", error: "Please write the chart question in 8 to 80 characters." };
    }
    if (source.length < 3 || source.length > 120) {
      return { ok: false, code: "invalid_input", error: "Please say where the numbers come from (3 to 120 characters)." };
    }
    if (!dataCsv.trim() || dataCsv.length > 200_000) {
      return { ok: false, code: "invalid_input", error: "Please paste the numbers as CSV (up to 200 KB)." };
    }
    const chart = c.chart === "line" ? "line" : "bar";
    const format = c.format ?? "portrait";
    if (!["portrait", "square", "vertical"].includes(format)) {
      return { ok: false, code: "invalid_input", error: "format must be portrait, square or vertical" };
    }
    return {
      ok: true,
      body: {
        kind: "chart",
        question,
        data_csv: dataCsv,
        source,
        chart,
        unit: collapse(c.unit).slice(0, 20),
        format,
        ai_text: Boolean(c.aiText),
        user,
      },
    };
  }

  // tips, reel and explainer all take a topic with the same 8–200 window.
  const topic = collapse((input as { topic?: string }).topic);
  if (topic.length < 8 || topic.length > 200) {
    return { ok: false, code: "topic_invalid", error: "Please describe the topic in 8 to 200 characters." };
  }
  if (recipe.kind === "tips") {
    // The chalkboard is `look: chalk` (+ optional board); the paper-cut card is
    // `look: paper`. The id is the difference, and paper ignores `board`.
    const look = recipe.id === "ai-creator-tips-paper-cut" ? "paper" : "chalk";
    const body: Record<string, unknown> = { kind: "tips", topic, look, user };
    if (look === "chalk") {
      const board = (input as { board?: ChalkBoard }).board;
      if (board !== undefined && !CHALK_BOARDS.includes(board)) {
        return {
          ok: false,
          code: "invalid_input",
          error: `look must be chalk or paper; board one of ${[...CHALK_BOARDS].sort().join(", ")}`,
        };
      }
      body.board = board ?? "forest";
    }
    return { ok: true, body };
  }
  if (recipe.kind === "reel") {
    const pictures = (input as { pictures?: "library" | "ai" }).pictures ?? "library";
    if (pictures !== "library" && pictures !== "ai") {
      return { ok: false, code: "invalid_input", error: "pictures must be library or ai" };
    }
    return { ok: true, body: { kind: "reel", topic, pictures, user } };
  }
  return { ok: true, body: { kind: "explainer", topic, user } };
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
    // Two different 400s arrive here: a body the kit rejected (the safety refusal
    // is not one of them — that is a FAILED JOB, not a 400) and a field the kit's
    // own validation refused. The kit puts a machine word in `error` and a
    // sentence for the person in `message`; show the sentence, keep the word.
    let kind = "invalid_input";
    try {
      const j = JSON.parse(body) as { error?: string };
      if (j.error === "topic_invalid") kind = "topic_invalid";
      if (j.error === "body must be JSON") kind = "bad_request";
    } catch {
      /* not JSON: the sentence below is still the best we have */
    }
    return { ok: false, code: kind, error: message || "That request cannot be made into a video." };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "daily_limit",
      retryable: true,
      error: message || "That is today's video limit — it resets tomorrow.",
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
export async function startKitJob(
  input: VideoJobInput,
): Promise<{ ok: true; jobId: string; state: string; etaMinutes: number } | KitFailure> {
  if (!videoConfigured()) {
    return { ok: false, code: "not_configured", error: "No video service is configured on this deployment." };
  }
  // The body is built and validated in ONE place against the kit's own rules.
  const built = kitJobBody(input);
  if (!built.ok) return built;

  let res: Response;
  try {
    res = await fetch(`${BASE}/jobs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(built.body),
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
export async function createVideoJob(
  input: VideoJobInput,
): Promise<{ ok: true; jobId: string; state: string; etaMinutes: number } | KitFailure> {
  // The product gate. Every path that starts a job for a person (chat pre-pass,
  // generate_video, the Recipes card's API) comes through here; a held-back
  // recipe is refused in the person's own words rather than sent to a kit that
  // will fail it. startKitJob stays a raw kit client so its contract can be tested.
  if (videoRecipeHeldBack(input.recipe)) {
    return {
      ok: false,
      code: "recipe_unavailable",
      error: "The picture reel is not switched on yet — the other four recipes are ready today.",
    };
  }
  const started = await startKitJob(input);
  if (!started.ok) return started;
  await recordVideoJob(input.userId, started.jobId, input.recipe, inputSeed(input));
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
  let j: {
    job_id?: string;
    id?: string;
    state?: string;
    message?: string;
    cause?: string;
    charge?: boolean;
    attempt?: number;
    attempts?: number;
    seconds?: number;
    rounds?: number;
    files?: unknown;
  };
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
    message: j.message ?? undefined,
    cause: j.cause ?? undefined,
    charge: typeof j.charge === "boolean" ? j.charge : undefined,
    // The contract says `attempt`; the reference worker writes `attempts` into the
    // final status. Read both rather than reporting a render that has no attempt.
    attempt: Number(j.attempt ?? j.attempts ?? 0) || undefined,
    seconds: typeof j.seconds === "number" ? j.seconds : undefined,
    rounds: typeof j.rounds === "number" ? j.rounds : undefined,
    files: kitFiles(j.files),
  };
}

/** `files` is an OBJECT keyed by role ({video, thumbnail, post}), not a list.
 *  Reading it as an array was the bug that made a finished video look empty. */
function kitFiles(raw: unknown): KitJobFiles | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" && o[k] ? String(o[k]) : undefined);
  const out: KitJobFiles = { video: pick("video"), thumbnail: pick("thumbnail"), post: pick("post") };
  return out.video || out.thumbnail || out.post ? out : undefined;
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
 * `recipe` is an enum of what BeeZilla offers today (four of the catalogue; the
 * picture reel is held back), and `topic` is the thing to explain — not the
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
            "ai-creator-tips-paper-cut is cut-out creator tips; chart-race-from-your-numbers is a " +
            "racing bar chart and needs the person's own table, so ask for the numbers first; " +
            "narrated-explainer is a plain narrated explainer.",
        },
        topic: {
          type: "string",
          description: "What the video explains, in the owner's own words. Example: 'the water cycle'.",
        },
        chart: {
          type: "object",
          description:
            "Only for chart-race-from-your-numbers: the person's own numbers. Omit it for the other recipes. " +
            "If the person has not pasted a table, do not call this tool — ask them for it first.",
          properties: {
            question: { type: "string", description: "The question on screen, 8 to 80 characters." },
            data_csv: {
              type: "string",
              description:
                "The table as CSV text, exactly as the person pasted it: first column dates, then one " +
                "column of numbers per competitor, at least six dated rows.",
            },
            source: { type: "string", description: "Where the numbers come from, 3 to 120 characters." },
            chart: { type: "string", enum: ["bar", "line"], description: "Bar race (default) or line race." },
            unit: { type: "string", description: "Unit shown with the numbers, e.g. GW, %, $. Optional." },
            format: {
              type: "string",
              enum: ["portrait", "square", "vertical"],
              description: "portrait 1080x1350 (default), square 1080x1080, vertical 1080x1920.",
            },
            ai_text: { type: "boolean", description: "Let the text model write the hook and post text." },
          },
          required: ["question", "data_csv", "source"],
        },
      },
      required: ["recipe"],
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
 * Kept for callers that already have a list of names (a log line, a test): the
 * wire format is an object keyed by role, so `readVideoJob` no longer needs this.
 * The first mp4 is the video, the first image the thumbnail, the first text the post.
 */
export function classifyFiles(files: string[]): { video?: string; thumb?: string; postText?: string } {
  return {
    video: files.find((f) => /\.mp4$/i.test(f)),
    thumb: files.find((f) => /\.(jpe?g|png|webp)$/i.test(f)),
    postText: files.find((f) => /\.(txt|md)$/i.test(f)),
  };
}
