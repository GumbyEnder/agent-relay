import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";

/**
 * 3D models, from Meshy.
 *
 * Testers, 2026-11-24 (the call the owner pasted): a 3D model asked for from concept art
 * came back as "normal, realistic army looking tanks", or as stage lights and bookshelves,
 * "kinda disappointing and textureless", and as "a soup of triangles". The old maker sent
 * the person's whole sentence to Text to 3D in preview mode: preview is geometry only (no
 * texture — Meshy's own docs: "generate a 3D mesh without texture, so you can check the
 * shape"), the picture never went anywhere, and `art_style: "realistic"` was fixed (and is
 * ignored by Meshy since January 2026).
 *
 * Now (Meshy API as documented on docs.meshy.ai, read 2026-11-24):
 *  - A picture of theirs makes the model: Image to 3D with the picture itself, or Multi-Image
 *    to 3D with two to four views of one thing. Its look is kept (`image_enhancement: false`)
 *    unless it is a rough sketch.
 *  - Words alone go through Text to 3D in two steps — the shape (preview), then the paint
 *    (refine) — started one after the other by the poll, so the model always has a texture.
 *  - Every model is textured with PBR maps, and its shape is rebuilt as a clean quad mesh
 *    (`should_remesh` + `topology: "quad"`, 30,000 faces) for games and editing; "low poly"
 *    uses a Smart Topology model at a face count, "detailed" keeps the full detail, "for 3D
 *    printing" keeps the full detail too.
 *  - A finished model is checked for a texture; one that came back bare is painted again
 *    from the same picture or words (Retexture) before it is shown.
 *
 * Generation takes one to four minutes, longer than a proxy holds a request open, so this
 * is a task API: the turn starts a task, the page polls GET /api/buzzy/model3d/:id, and the
 * poll moves the job along (shape → paint → check) and stores the .glb the first time the
 * last step is done. A job's id says which Meshy endpoint it lives on ("img.…", "txt.…").
 */

// BZ_MESHY_BASE_URL points the maker somewhere else (a proxy, or a stand-in in tests).
const API = (process.env.BZ_MESHY_BASE_URL || "https://api.meshy.ai/openapi").trim().replace(/\/+$/, "");
const KEY = process.env.BZ_MESHY_KEY || "";
/** Meshy's newest standard model; pinned, so an upgrade is a decision and not a surprise. */
const AI_MODEL = (process.env.BZ_MESHY_MODEL || "meshy-7.1").trim();

export function threeDConfigured(): boolean {
  return Boolean(KEY);
}

/** What the model is for, from their words; it decides the mesh and the paint. */
export type ModelPurpose = "game" | "detailed" | "lowpoly" | "print";

export function modelPurpose(message: string): ModelPurpose {
  const m = String(message || "").toLowerCase();
  if (/\blow[\s-]?poly\b|\blowpoly\b|\bmobile game\b|\blightweight\b|\bfew polygons\b|\bsimple shapes?\b/.test(m)) return "lowpoly";
  if (/\b3d[\s-]?print(?:ing|able|er|ed)?\b|\bprint (?:it|this|that)\b|\bprintable\b|\bstl\b/.test(m)) return "print";
  if (/\b(?:highly |very |super )?detailed\b|\bhigh[\s-]?(?:detail|poly|res(?:olution)?)\b|\bhero (?:asset|model)\b|\bcinematic\b|\bclose[\s-]?ups?\b|\bultra\b|\b4k\b|\b8k\b/.test(m)) return "detailed";
  return "game";
}

/** A job to start: from pictures (one, or two to four views of one thing) or from words. */
export interface ModelPlan {
  kind: "image" | "multi" | "text";
  /** For words: what the thing is (at most 800 characters). For pictures: what it is, kept for the record. */
  prompt: string;
  /** Data URIs (image/png, jpeg, webp), first one the front view. */
  images: string[];
  purpose: ModelPurpose;
  /** Keep the picture's exact look (no "image enhancement"). Off for a rough sketch. */
  keepLook: boolean;
  /** How the paint should look, only when they asked for a different look than the picture. */
  texturePrompt?: string;
  /** A character to rig later: stand it in an A-pose. */
  pose?: "a-pose" | "t-pose";
}

/** Shape models that take `image_enhancement` (Meshy 6 Lite and Smart Topology refuse it with 400). */
export function takesEnhancement(model: string): boolean {
  return /^(?:meshy-7\.1|meshy-6|latest)$/.test(String(model || "").trim());
}

/** The files a job asks for: an FBX too when the mesh is quads, since glTF only holds triangles. */
function formatsFor(purpose: ModelPurpose): string[] {
  return purpose === "game" ? ["glb", "fbx"] : ["glb"];
}

/** The mesh settings for a purpose (shared by every endpoint that takes them). */
function meshFor(purpose: ModelPurpose, kind: ModelPlan["kind"]): Record<string, unknown> {
  if (purpose === "lowpoly" && kind !== "multi") {
    // Smart Topology: a clean low-poly triangle mesh at the face count asked for, painted by
    // Meshy N1 (made for stylised low-poly assets; base colour only, no PBR).
    return { model_type: "smart-topology", ai_model: "meshy-t2.5", target_polycount: 5000 };
  }
  if (purpose === "detailed" || purpose === "print") {
    // Every bit of detail: no remesh (Meshy: "For the highest-quality 3D model, set it to false").
    return { ai_model: AI_MODEL, should_remesh: false };
  }
  // Games and editing: a quad-dominant mesh at ~30,000 faces, instead of a dense triangle soup.
  return { ai_model: AI_MODEL, should_remesh: true, topology: "quad", target_polycount: purpose === "lowpoly" ? 8000 : 30000 };
}

function clip800(s: string | undefined): string {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

/**
 * The Meshy request for a plan: which endpoint, and the body. Pure, so the choices are
 * tested without a key (scripts/test-model3d.ts).
 */
export function meshyRequest(plan: ModelPlan): { path: string; body: Record<string, unknown> } {
  const lowpoly = plan.purpose === "lowpoly" && plan.kind !== "multi";
  const paint: Record<string, unknown> = lowpoly
    ? { should_texture: true, texture_model: "meshy-n1" }
    // The paint model named, not left to the shape model's default (Meshy added
    // texture_model to Image to 3D on 2026-11-03; Meshy 7 paints PBR maps up to 8K).
    : { should_texture: true, texture_model: "meshy-7", enable_pbr: true, ...(plan.purpose === "detailed" ? { texture_resolution: "4k" } : {}) };
  // Only N1 can't take words for its paint; anything else may follow a look they asked for.
  if (plan.texturePrompt && !lowpoly) paint.texture_prompt = clip800(plan.texturePrompt);
  const extras = {
    target_formats: formatsFor(plan.purpose),
    // Four views to show them and to check the result with (front, right, back, left).
    multi_view_thumbnails: true,
    alpha_thumbnail: true,
    ...(plan.pose ? { pose_mode: plan.pose } : {}),
  };
  if (plan.kind === "image") {
    const body: Record<string, unknown> = { image_url: plan.images[0], ...meshFor(plan.purpose, "image"), ...paint, ...extras };
    // "false keeps the exact look of the input image, with no style processing" — the
    // concept art IS the design. Only where the shape model takes it (not Smart Topology,
    // not Meshy 6 Lite: both answer 400).
    if (!lowpoly && takesEnhancement(String(body.ai_model))) body.image_enhancement = !plan.keepLook;
    return { path: "/v1/image-to-3d", body };
  }
  if (plan.kind === "multi") {
    const body: Record<string, unknown> = { image_urls: plan.images.slice(0, 4), ...meshFor(plan.purpose, "multi"), ...paint, ...extras };
    delete body.multi_view_thumbnails; // an Image to 3D option; Multi-Image to 3D does not list it
    // Meshy turns enhancement on by default here too: keep the views' own look.
    if (takesEnhancement(String(body.ai_model))) body.image_enhancement = !plan.keepLook;
    return { path: "/v1/multi-image-to-3d", body };
  }
  // Words: the shape first. The poll starts the paint (refine) when the shape is done.
  const shape: Record<string, unknown> = { mode: "preview", prompt: clip800(plan.prompt), ...meshFor(plan.purpose, "text"), target_formats: ["glb"], ...(plan.pose ? { pose_mode: plan.pose } : {}) };
  return { path: "/v2/text-to-3d", body: shape };
}

/** The paint step for a finished shape (Text to 3D refine). */
export function refineRequest(previewId: string, job: JobMemory | undefined): { path: string; body: Record<string, unknown> } {
  const lowpoly = job?.purpose === "lowpoly";
  const body: Record<string, unknown> = { mode: "refine", preview_task_id: previewId, target_formats: formatsFor(job?.purpose ?? "game"), alpha_thumbnail: true };
  if (!lowpoly) {
    body.enable_pbr = true;
    const words = clip800(job?.texturePrompt || job?.prompt);
    if (words) body.texture_prompt = words;
    if (job?.purpose === "detailed") body.texture_resolution = "4k";
  }
  return { path: "/v2/text-to-3d", body };
}

/** Painting a model again from the same picture or words, keeping its UVs (Retexture). */
export function retextureRequest(meshyTaskId: string, job: JobMemory | undefined): { path: string; body: Record<string, unknown> } | null {
  const body: Record<string, unknown> = { input_task_id: meshyTaskId, enable_original_uv: true, enable_pbr: true, target_formats: formatsFor(job?.purpose ?? "game"), alpha_thumbnail: true };
  if (job?.image) body.image_style_url = job.image;
  else if (clip800(job?.texturePrompt || job?.prompt)) body.text_style_prompt = clip800(job?.texturePrompt || job?.prompt);
  else return null;
  return { path: "/v1/retexture", body };
}

// Which endpoint a job id lives on. "txt" is a shape still to paint, "ref" its paint,
// "rtx" a repaint of a bare model. An id with no prefix is from before (Text to 3D).
const KINDS: Record<string, string> = { img: "/v1/image-to-3d", mimg: "/v1/multi-image-to-3d", txt: "/v2/text-to-3d", ref: "/v2/text-to-3d", rtx: "/v1/retexture" };
const JOB_ID = /^(?:(img|mimg|txt|ref|rtx)\.)?([A-Za-z0-9-]{8,64})$/;

export function parseJobId(id: string): { kind: keyof typeof KINDS | "legacy"; meshyId: string; path: string } | null {
  const m = JOB_ID.exec(String(id || ""));
  if (!m) return null;
  const kind = (m[1] || "legacy") as keyof typeof KINDS | "legacy";
  return { kind, meshyId: m[2]!, path: kind === "legacy" ? KINDS.txt! : KINDS[kind]! };
}

/**
 * What a job needs between polls (buzzy_model3d_jobs, migration 0072): whose it is, its
 * words and purpose (for the paint step), the Library id of its picture (for a repaint),
 * and the one job that continues it. Kept in the database, so a restart loses nothing,
 * only the person who started a job can poll it, and each next step is started once.
 */
export interface JobMemory {
  userId: string;
  prompt: string;
  purpose: ModelPurpose;
  texturePrompt?: string;
  /** The front picture as a data URI, loaded only when a repaint needs it. */
  image?: string;
  /** Its Library id (what is kept; never the bytes). */
  pictureId?: number | null;
  /** Repainted once already (never twice). */
  repainted?: boolean;
}
type Sql = Awaited<ReturnType<typeof getSql>>;
type JobRow = { meshy_id: string; user_id: string; kind: string; purpose: string; prompt: string; texture_prompt: string | null; picture_id: number | string | null; next_id: string | null; repainted: boolean };
let sqlImpl: () => Promise<Sql> = getSql;
/** Test seam: another database. Never called from runtime code. */
export function __setModelSqlForTests(f: (() => Promise<Sql>) | null): void {
  sqlImpl = f ?? getSql;
}
/** A job's row; throws when the database can't be read (that is not "no such job"). */
async function readJobRow(meshyId: string): Promise<JobRow | null> {
  const sql = await sqlImpl();
  const rows = await sql<JobRow>`SELECT meshy_id, user_id, kind, purpose, prompt, texture_prompt, picture_id, next_id, repainted FROM buzzy_model3d_jobs WHERE meshy_id = ${meshyId} LIMIT 1`;
  return rows[0] ?? null;
}
async function jobRow(meshyId: string): Promise<JobRow | null> {
  try { return await readJobRow(meshyId); } catch { return null; }
}
/** Who started a job (null: no such job, or it can't be read right now). */
export async function jobOwner(meshyId: string): Promise<string | null> {
  return (await jobRow(meshyId))?.user_id ?? null;
}
async function recordJob(meshyId: string, userId: string, kind: string, j: { prompt: string; purpose: ModelPurpose; texturePrompt?: string; pictureId?: number | null; parentId?: string | null; repainted?: boolean }): Promise<void> {
  const sql = await sqlImpl();
  await sql`
    INSERT INTO buzzy_model3d_jobs (meshy_id, user_id, kind, purpose, prompt, texture_prompt, picture_id, parent_id, repainted)
    VALUES (${meshyId}, ${userId}, ${kind}, ${j.purpose}, ${clip800(j.prompt)}, ${j.texturePrompt ? clip800(j.texturePrompt) : null},
            ${j.pictureId ?? null}, ${j.parentId ?? null}, ${j.repainted === true})
    ON CONFLICT (meshy_id) DO NOTHING`;
}

function explain(status: number, body: string): { code: string; error: string } {
  let msg = "";
  try {
    // Meshy (or a proxy in front of it) may answer with words or with an object, and may
    // leave `message` empty and say why in `detail`: the first one that says something.
    const j = JSON.parse(body) as { message?: unknown; detail?: unknown } | null;
    const said = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : JSON.stringify(v));
    msg = j && typeof j === "object" ? said(j.message) || said(j.detail) : "";
  } catch {
    msg = String(body || "").slice(0, 160);
  }
  if (status === 401 || status === 403) return { code: status === 403 && /moderat/i.test(msg) ? "moderated" : "bad_key", error: status === 403 && /moderat/i.test(msg) ? "Meshy's content check refused that picture or prompt." : "Meshy rejected the API key." };
  if (status === 402) return { code: "no_credits", error: "The Meshy account has no credits left." };
  if (status === 429) return { code: "rate_limited", error: "Meshy is rate-limiting this account — try again shortly." };
  return { code: "meshy_failed", error: msg ? `Meshy: ${msg.slice(0, 200)}` : `Meshy answered ${status}.` };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Test seam: send Meshy calls somewhere else. Never called from runtime code. */
export function __setMeshyFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

/**
 * Send one paid request. Meshy said no (a 4xx): a plain failure, nothing was started. No
 * answer, a server error, or an answer without a task id: it may have been started (and
 * charged) all the same — `uncertain`, so the caller never sends it again on its own.
 */
type PostResult = { ok: true; id: string } | { ok: false; code: string; error: string; uncertain?: true };
const UNCERTAIN_START = "The 3D maker didn't confirm it started the model (its answer was lost), so it isn't known whether it did; nothing was sent again.";
async function post(path: string, body: Record<string, unknown>): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetchImpl(API + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    // Sent, but no answer came back: Meshy may have taken it.
    return { ok: false, code: "uncertain", error: `${UNCERTAIN_START} (${(e as Error).message.slice(0, 80)})`, uncertain: true };
  }
  let text = "";
  try { text = await res.text(); } catch { /* the answer broke off: read as no answer */ }
  if (res.status >= 400 && res.status < 500) return { ok: false, ...explain(res.status, text) };
  if (!res.ok) return { ok: false, code: "uncertain", error: `${UNCERTAIN_START} (Meshy answered ${res.status}.)`, uncertain: true };
  let id = "";
  try { id = String((JSON.parse(text) as { result?: unknown }).result ?? ""); } catch { id = ""; }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return { ok: false, code: "uncertain", error: `${UNCERTAIN_START} (no task id came back.)`, uncertain: true };
  return { ok: true, id };
}
// Written down twice before giving up: a paid task that nobody can poll is lost to its owner.
async function recordOnce(meshyId: string, userId: string, kind: string, j: Parameters<typeof recordJob>[3]): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try { await recordJob(meshyId, userId, kind, j); return true; } catch { /* once more */ }
  }
  return false;
}

/** Start a job from a plan. The id it returns says which endpoint to poll. */
export async function startModel(
  plan: ModelPlan,
  userId: string,
  opts: { pictureId?: number | null } = {},
): Promise<{ ok: true; taskId: string } | { ok: false; code: string; error: string }> {
  if (!KEY) return { ok: false, code: "not_configured", error: "No 3D provider is configured (BZ_MESHY_KEY is unset)." };
  if (plan.kind !== "text" && !plan.images.length) return { ok: false, code: "no_picture", error: "There is no picture to make the model from." };
  if (plan.kind === "text" && !clip800(plan.prompt)) return { ok: false, code: "no_prompt", error: "Describe the model you want." };
  const req = meshyRequest(plan);
  const r = await post(req.path, req.body);
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  const prefix = plan.kind === "image" ? "img" : plan.kind === "multi" ? "mimg" : "txt";
  if (!(await recordOnce(r.id, userId, prefix, { prompt: plan.prompt, purpose: plan.purpose, texturePrompt: plan.texturePrompt, pictureId: opts.pictureId ?? null }))) {
    // Without its owner on record nobody could poll it: say so rather than lose the job silently.
    return { ok: false, code: "not_recorded", error: "The 3D job started but could not be recorded, so it can't be followed here." };
  }
  return { ok: true, taskId: `${prefix}.${r.id}` };
}

/** Words only, as before (POST /api/buzzy/model3d { prompt }): now painted and remeshed. */
export async function createModelTask(prompt: string, userId = ""): Promise<{ ok: true; taskId: string } | { ok: false; code: string; error: string }> {
  const text = String(prompt || "").trim();
  if (!KEY) return { ok: false, code: "not_configured", error: "No 3D provider is configured (BZ_MESHY_KEY is unset)." };
  if (!text) return { ok: false, code: "no_prompt", error: "Describe the model you want." };
  return startModel({ kind: "text", prompt: text, images: [], purpose: modelPurpose(text), keepLook: true }, userId);
}

export interface TaskState {
  status: string;
  progress: number;
  glbUrl?: string;
  /** The FBX, when asked for: it keeps the quad faces glTF can't hold. */
  fbxUrl?: string;
  thumbnailUrl?: string;
  /** Front, right, back and left views, when Meshy rendered them. */
  thumbnailUrls?: string[];
  error?: string;
  /** Meshy's texture maps for the model, when it reports them. */
  textured?: boolean;
}

export async function readModelTask(taskId: string): Promise<TaskState | null> {
  if (!KEY) return null;
  const job = parseJobId(taskId);
  if (!job) return { status: "error", progress: 0, error: "That is not a 3D job." };
  try {
    const res = await fetchImpl(`${API}${job.path}/${encodeURIComponent(job.meshyId)}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { status: "error", progress: 0, error: explain(res.status, await res.text()).error };
    const j = (await res.json()) as {
      status?: string; progress?: number; model_urls?: { glb?: string; fbx?: string }; thumbnail_url?: string;
      thumbnail_urls?: unknown; texture_urls?: unknown; task_error?: { message?: string };
    };
    // Meshy names the four views ({ front, right, back, left }); a list is read too.
    const tu = j.thumbnail_urls;
    const viewList = Array.isArray(tu) ? tu : tu && typeof tu === "object" ? ["front", "right", "back", "left"].map((k) => (tu as Record<string, unknown>)[k]) : [];
    const views = viewList.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 4);
    return {
      status: j.status || "UNKNOWN",
      progress: Number(j.progress || 0),
      glbUrl: j.model_urls?.glb,
      ...(j.model_urls?.fbx ? { fbxUrl: j.model_urls.fbx } : {}),
      thumbnailUrl: j.thumbnail_url,
      ...(views.length ? { thumbnailUrls: views } : {}),
      ...(Array.isArray(j.texture_urls) ? { textured: j.texture_urls.length > 0 } : {}),
      error: j.task_error?.message,
    };
  } catch (e) {
    return { status: "error", progress: 0, error: (e as Error).message.slice(0, 120) };
  }
}

/**
 * The next step of a finished job — the paint for a shape (refine), or a repaint for a bare
 * model — started ONCE, and never paid for twice:
 *  - the job row is claimed first (next_id 'pending'), so two polls at the same moment are
 *    given the same next job instead of starting another;
 *  - the next job's id is written down (its own row, and next_id) before it is handed out:
 *    an id nobody can poll is never given;
 *  - a step whose start is not known (no answer from Meshy, a server error, a claim that
 *    never finished) is marked 'uncertain' and never sent again; the poll says so, and the
 *    person can ask for the model again.
 * `loadPicture` reads the person's picture by its Library id when a repaint needs it
 * (owner-scoped in the caller). Answers `busy` (try again) when the job can't be read.
 */
const UNCERTAIN_NEXT = "The 3D maker may have started the next step, but its answer was lost. It isn't sent again (that could pay for it twice) — ask for the model again to finish it.";
// Next jobs Meshy confirmed whose id couldn't be written down yet (the database failed at
// that moment): written on the next poll, never started again. In this server only.
const unlinked = new Map<string, { meshyId: string; nextId: string; kind: string; j: Parameters<typeof recordJob>[3] }>();
export async function nextStep(
  taskId: string,
  userId: string,
  why: "shape-done" | "bare",
  loadPicture?: (id: number) => Promise<string | null>,
): Promise<{ ok: true; taskId: string; label: string } | { ok: true; pending: true; label: string } | { ok: false; code: string; error: string } | null> {
  const job = parseJobId(taskId);
  if (!job) return null;
  let row: JobRow | null;
  try { row = await readJobRow(job.meshyId); } catch { return { ok: false, code: "busy", error: "The 3D job can't be read just now." }; }
  if (!row || row.user_id !== userId) return null;
  const shape = why === "shape-done" && (job.kind === "txt" || job.kind === "legacy");
  const bare = why === "bare" && !row.repainted && job.kind !== "rtx";
  if (!shape && !bare) return null;
  const label = shape ? "Painting the textures" : "It came back without colour — painting it";
  const uncertain = { ok: false as const, code: "uncertain", error: UNCERTAIN_NEXT };
  const sql = await sqlImpl();
  // A next job already written down for this one (its own row names this one as its
  // parent) — the link to it failed, or another server started it: that one, never a new one.
  const recoverChild = async (): Promise<{ ok: true; taskId: string; label: string } | null> => {
    try {
      const kids = await sql<{ meshy_id: string; kind: string }>`
        SELECT meshy_id, kind FROM buzzy_model3d_jobs
         WHERE parent_id = ${job.meshyId} AND user_id = ${userId}
         ORDER BY created_at DESC LIMIT 1`;
      const kid = kids[0];
      if (!kid) return null;
      const nextId = `${kid.kind}.${kid.meshy_id}`;
      try { await sql`UPDATE buzzy_model3d_jobs SET next_id = ${nextId} WHERE meshy_id = ${job.meshyId} AND user_id = ${userId}`; } catch { /* its own row is there: handed out all the same */ }
      return { ok: true, taskId: nextId, label };
    } catch { return null; }
  };
  const settledAs = async (next: string | null) =>
    next === "uncertain" ? ((await recoverChild()) ?? uncertain) : next && next !== "pending" ? { ok: true as const, taskId: next, label } : null;
  const known = await settledAs(row.next_id);
  if (known) return known;
  const link = async (child: { meshyId: string; nextId: string; kind: string; j: Parameters<typeof recordJob>[3] }) => {
    if (!(await recordOnce(child.meshyId, userId, child.kind, child.j))) return false;
    try {
      await sql`UPDATE buzzy_model3d_jobs SET next_id = ${child.nextId} WHERE meshy_id = ${job.meshyId} AND user_id = ${userId}`;
      return true;
    } catch { return false; }
  };
  // Started and confirmed earlier, not yet written down: written now, never started again.
  const waiting = unlinked.get(job.meshyId);
  if (waiting) {
    if (!(await link(waiting))) return { ok: true, pending: true, label };
    unlinked.delete(job.meshyId);
    return { ok: true, taskId: waiting.nextId, label };
  }
  let claimed: Array<{ meshy_id: string }>;
  try {
    claimed = await sql<{ meshy_id: string }>`
      UPDATE buzzy_model3d_jobs SET next_id = 'pending', next_claimed_at = now()
       WHERE meshy_id = ${job.meshyId} AND user_id = ${userId} AND next_id IS NULL
       RETURNING meshy_id`;
  } catch { return { ok: false, code: "busy", error: "The 3D job can't be read just now." }; }
  if (!claimed.length) {
    const again = await jobRow(job.meshyId);
    const now = await settledAs(again?.next_id ?? null);
    if (now) return now;
    // Being started by another poll right now — or by one that never finished (a crash, a
    // lost answer). One that got as far as writing its next job down is found by it; after
    // three minutes the rest is said, and nothing is sent again.
    if (again?.next_id === "pending") {
      const found = await recoverChild();
      if (found) return found;
    }
    try {
      const stale = await sql<{ meshy_id: string }>`
        UPDATE buzzy_model3d_jobs SET next_id = 'uncertain'
         WHERE meshy_id = ${job.meshyId} AND next_id = 'pending' AND next_claimed_at < now() - interval '3 minutes'
         RETURNING meshy_id`;
      if (stale.length) return uncertain;
    } catch { /* asked again on the next poll */ }
    return { ok: true, pending: true, label };
  }
  const memory: JobMemory = {
    userId, prompt: row.prompt, purpose: (row.purpose as ModelPurpose) || "game",
    texturePrompt: row.texture_prompt ?? undefined, pictureId: row.picture_id === null ? null : Number(row.picture_id), repainted: row.repainted,
  };
  if (bare && memory.pictureId && loadPicture) memory.image = (await loadPicture(memory.pictureId)) ?? undefined;
  const req = shape ? refineRequest(job.meshyId, memory) : retextureRequest(job.meshyId, memory);
  const prefix = shape ? "ref" : "rtx";
  // Only for a step that was certainly not started: free to be claimed again.
  const release = async () => { try { await sql`UPDATE buzzy_model3d_jobs SET next_id = NULL WHERE meshy_id = ${job.meshyId} AND next_id = 'pending'`; } catch { /* after three minutes it reads as uncertain */ } };
  if (!req) { await release(); return null; }
  const r = await post(req.path, req.body);
  if (!r.ok) {
    if (r.uncertain) {
      try { await sql`UPDATE buzzy_model3d_jobs SET next_id = 'uncertain' WHERE meshy_id = ${job.meshyId} AND next_id = 'pending'`; } catch { /* stays claimed: after three minutes it reads as uncertain */ }
      return uncertain;
    }
    await release();
    return { ok: false, code: r.code, error: r.error };
  }
  const child = {
    meshyId: r.id, nextId: `${prefix}.${r.id}`, kind: prefix,
    j: { prompt: memory.prompt, purpose: memory.purpose, texturePrompt: memory.texturePrompt, pictureId: memory.pictureId, parentId: job.meshyId, repainted: !shape || memory.repainted },
  };
  if (await link(child)) return { ok: true, taskId: child.nextId, label };
  unlinked.set(job.meshyId, child);
  return { ok: true, pending: true, label };
}

/** What is in a .glb: enough to know it has a texture and how big it is. Never throws. */
export interface GlbSummary {
  ok: boolean;
  meshes: number;
  materials: number;
  textures: number;
  images: number;
  /** Materials that point at a base colour texture. */
  texturedMaterials: number;
  /** Faces, counted from the index (or position) accessors. */
  triangles: number;
  hasUvs: boolean;
  hasNormals: boolean;
}

export function glbSummary(bytes: Uint8Array | Buffer | null | undefined): GlbSummary {
  const none: GlbSummary = { ok: false, meshes: 0, materials: 0, textures: 0, images: 0, texturedMaterials: 0, triangles: 0, hasUvs: false, hasNormals: false };
  try {
    if (!bytes || bytes.byteLength < 20) return none;
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (b.readUInt32LE(0) !== 0x46546c67) return none; // "glTF"
    const jsonLen = b.readUInt32LE(12);
    if (b.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLen > b.byteLength) return none; // "JSON"
    const g = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8")) as {
      meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number; mode?: number }> }>;
      materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: unknown } }>;
      textures?: unknown[];
      images?: unknown[];
      accessors?: Array<{ count?: number }>;
    };
    let triangles = 0;
    let hasUvs = false;
    let hasNormals = false;
    for (const m of g.meshes ?? []) {
      for (const p of m.primitives ?? []) {
        if (p.mode !== undefined && p.mode !== 4) continue;
        const acc = p.indices !== undefined ? g.accessors?.[p.indices] : p.attributes?.POSITION !== undefined ? g.accessors?.[p.attributes.POSITION] : undefined;
        triangles += Math.floor(Number(acc?.count || 0) / 3);
        if (p.attributes?.TEXCOORD_0 !== undefined) hasUvs = true;
        if (p.attributes?.NORMAL !== undefined) hasNormals = true;
      }
    }
    return {
      ok: true,
      meshes: (g.meshes ?? []).length,
      materials: (g.materials ?? []).length,
      textures: (g.textures ?? []).length,
      images: (g.images ?? []).length,
      texturedMaterials: (g.materials ?? []).filter((m) => m?.pbrMetallicRoughness?.baseColorTexture).length,
      triangles,
      hasUvs,
      hasNormals,
    };
  } catch {
    return none;
  }
}

/** Download a finished .glb (its bytes, so the texture can be checked before it is kept). */
export async function fetchModel(glbUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetchImpl(glbUrl, { signal: AbortSignal.timeout(90000) } as RequestInit);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/** Keep a finished .glb on the asset shelf (from a link, or from bytes already fetched). */
export async function storeModel(
  userId: string,
  glbUrlOrBytes: string | Buffer,
  name: string,
  contentType = "model/gltf-binary",
): Promise<{ id: number; bytes: number; duplicate: boolean } | null> {
  try {
    const bytes = typeof glbUrlOrBytes === "string" ? await fetchModel(glbUrlOrBytes) : glbUrlOrBytes;
    if (!bytes || !bytes.length) return null;
    const sql = await getSql();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const inserted = await sql<{ id: number }>`
      INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body)
      VALUES (${userId}, ${sha256}, ${name}, ${name}, ${contentType}, ${bytes.byteLength}, ${bytes})
      ON CONFLICT (user_id, sha256) DO NOTHING
      RETURNING id
    `;
    if (inserted.length) return { id: inserted[0]!.id, bytes: bytes.byteLength, duplicate: false };
    const prior = await sql<{ id: number; bytes: number }>`
      SELECT id, bytes FROM buzzy_assets WHERE user_id = ${userId} AND sha256 = ${sha256} LIMIT 1
    `;
    return prior.length ? { id: prior[0]!.id, bytes: prior[0]!.bytes, duplicate: true } : null;
  } catch {
    return null;
  }
}
