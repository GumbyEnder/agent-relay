/**
 * The music studio's server half.
 *
 * A generated track is a plan plus a history, not a file. This module owns three
 * things:
 *
 *  1. **The plan** — lyrics, instruments, sections, tempo/key, duration — stored in
 *     `buzzy_jobs.data.music` so the studio and the chat agent read the same object.
 *  2. **The edit log** — every change, who made it (owner or model), which region it
 *     was aimed at, and which asset it produced. This is what lets the agent be told
 *     "what changed" instead of guessing from the newest MP3.
 *  3. **The render** — composing the provider prompt from the plan plus one edit.
 *
 * Honesty about the provider, because it shapes the product: ElevenLabs' Music API
 * takes prose (and on `music_v2_5`, optionally a composition plan). It has no
 * region-inpainting endpoint, so a "edit 0:32–0:48" is a re-render of the track with
 * the instruction scoped to that window — everything outside keeps its prior
 * description. The studio says so in the UI and every edit row carries `note`, so
 * nobody is told a splice happened when it did not.
 */
import { getSql } from "@/lib/db";
import { gatedMusic, storeAudio } from "./music";

export interface MusicPlan {
  prompt: string;
  lyrics: string;
  instruments: string[];
  sections: { label: string; fromSec: number; toSec: number; note?: string }[];
  tempo?: string;
  key?: string;
  seconds: number;
  currentAssetId?: number | null;
}

export interface MusicEdit {
  id: number;
  actor: "user" | "agent";
  instruction: string | null;
  fromMs: number | null;
  toMs: number | null;
  beforeAssetId: number | null;
  afterAssetId: number | null;
  note: string | null;
  createdAt: string;
}

export interface StudioState {
  jobId: string;
  title: string;
  status: string;
  plan: MusicPlan;
  asset: { id: number; url: string; bytes: number; type: string } | null;
  versions: { id: number; url: string; bytes: number; createdAt: string; label: string }[];
  edits: MusicEdit[];
}

const EMPTY_PLAN: MusicPlan = {
  prompt: "",
  lyrics: "",
  instruments: [],
  sections: [],
  seconds: 30,
};

function planOf(data: unknown): MusicPlan {
  const music = (data as { music?: Partial<MusicPlan> } | null)?.music;
  if (!music) return { ...EMPTY_PLAN };
  return {
    prompt: String(music.prompt ?? ""),
    lyrics: String(music.lyrics ?? ""),
    instruments: Array.isArray(music.instruments) ? music.instruments.map(String).slice(0, 24) : [],
    sections: Array.isArray(music.sections)
      ? music.sections.slice(0, 24).map((s) => ({
          label: String((s as { label?: string }).label ?? "section"),
          fromSec: Number((s as { fromSec?: number }).fromSec ?? 0),
          toSec: Number((s as { toSec?: number }).toSec ?? 0),
          note: (s as { note?: string }).note ? String((s as { note?: string }).note) : undefined,
        }))
      : [],
    tempo: music.tempo ? String(music.tempo) : undefined,
    key: music.key ? String(music.key) : undefined,
    seconds: Number(music.seconds ?? 30),
    currentAssetId: music.currentAssetId != null ? Number(music.currentAssetId) : null,
  };
}

/** Prompt for a fresh render: everything the provider needs, in one paragraph. */
export function composePrompt(plan: MusicPlan): string {
  const bits: string[] = [];
  if (plan.prompt) bits.push(plan.prompt.trim());
  const shape = [plan.tempo, plan.key].filter(Boolean).join(", ");
  if (shape) bits.push(shape);
  if (plan.instruments.length) bits.push(`Instrumentation: ${plan.instruments.join(", ")}.`);
  if (plan.sections.length) {
    bits.push(
      "Structure: " +
        plan.sections
          .map((s) => `${s.label} ${Math.floor(s.fromSec / 60)}:${String(Math.round(s.fromSec % 60)).padStart(2, "0")}–${Math.floor(s.toSec / 60)}:${String(Math.round(s.toSec % 60)).padStart(2, "0")}${s.note ? ` (${s.note})` : ""}`)
          .join("; ") +
        ".",
    );
  }
  if (plan.lyrics.trim()) bits.push(`Vocals, sung exactly these lyrics: ${plan.lyrics.trim()}`);
  bits.push(`Duration ${plan.seconds} seconds.`);
  return bits.join(" ").slice(0, 1900);
}

/**
 * Prompt for an edit. The region is stated in seconds AND in words, and the
 * instruction is scoped to it, because a prompt that merely repeats an instruction
 * over a whole track produces a new song rather than a changed passage.
 */
export function composeEditPrompt(plan: MusicPlan, instruction: string, fromMs?: number | null, toMs?: number | null): string {
  const base = composePrompt({ ...plan, prompt: plan.prompt });
  if (fromMs == null || toMs == null || toMs <= fromMs) {
    return `${base} Change: ${instruction.trim()}. Keep everything else as it is.`.slice(0, 1900);
  }
  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return (
    `${base} THIS VERSION: only the passage from ${fmt(fromMs)} to ${fmt(toMs)} changes — ` +
    `apply "${instruction.trim()}" there. Every other second keeps the same instrumentation, ` +
    `tempo, key and structure as the previous version; do not restyle the rest of the track.`
  ).slice(0, 1900);
}

/** The plan plus its history, for the studio page and for a chat turn about it. */
export async function getStudio(userId: string, jobId: string): Promise<StudioState | null> {
  const sql = await getSql();
  const rows = await sql<{ id: string; title: string | null; status: string | null; data: unknown }>`
    SELECT id, title, status, data FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} LIMIT 1
  `;
  if (!rows.length) return null;
  const row = rows[0]!;
  const plan = planOf(row.data);

  const assets = await sql<{ id: number; filename: string | null; content_type: string | null; bytes: number; created_at: string }>`
    SELECT id, filename, content_type, bytes, created_at FROM buzzy_assets
    WHERE user_id = ${userId} AND job_id = ${jobId} AND (content_type LIKE 'audio/%' OR content_type IS NULL)
    ORDER BY id ASC
  `;
  const versions = assets.map((a) => ({
    id: a.id,
    url: `/api/buzzy/assets/${a.id}`,
    bytes: a.bytes,
    createdAt: String(a.created_at),
    label: a.filename || `version ${a.id}`,
  }));
  const current = plan.currentAssetId ?? (versions.length ? versions[versions.length - 1]!.id : null);
  const asset = current
    ? (() => {
        const v = versions.find((x) => x.id === current) ?? versions[versions.length - 1];
        return v ? { id: v.id, url: v.url, bytes: v.bytes, type: "audio/mpeg" } : null;
      })()
    : null;

  const edits = await sql<{
    id: string; actor: string; instruction: string | null; region_from_ms: number | null;
    region_to_ms: number | null; before_asset_id: string | null; after_asset_id: string | null;
    note: string | null; created_at: string;
  }>`
    SELECT id, actor, instruction, region_from_ms, region_to_ms, before_asset_id, after_asset_id, note, created_at
    FROM buzzy_music_edits WHERE user_id = ${userId} AND job_id = ${jobId} ORDER BY id DESC LIMIT 100
  `;

  return {
    jobId,
    title: row.title ?? "Untitled track",
    status: row.status ?? "In progress",
    plan,
    asset,
    versions,
    edits: edits.map((e) => ({
      id: Number(e.id),
      actor: e.actor === "agent" ? "agent" : "user",
      instruction: e.instruction,
      fromMs: e.region_from_ms,
      toMs: e.region_to_ms,
      beforeAssetId: e.before_asset_id ? Number(e.before_asset_id) : null,
      afterAssetId: e.after_asset_id ? Number(e.after_asset_id) : null,
      note: e.note,
      createdAt: String(e.created_at),
    })),
  };
}

export async function savePlan(userId: string, jobId: string, plan: Partial<MusicPlan>): Promise<MusicPlan> {
  const sql = await getSql();
  const current = await getStudio(userId, jobId);
  const merged: MusicPlan = {
    ...(current?.plan ?? EMPTY_PLAN),
    ...plan,
    instruments: plan.instruments ?? current?.plan.instruments ?? [],
    sections: plan.sections ?? current?.plan.sections ?? [],
    seconds: Math.min(Math.max(Number(plan.seconds ?? current?.plan.seconds ?? 30), 3), 300),
  };
  await sql`
    UPDATE buzzy_jobs
       SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{music}', ${JSON.stringify(merged)}::jsonb, true),
           updated_at = now()
     WHERE id = ${jobId} AND user_id = ${userId}
  `;
  return merged;
}

/**
 * Register a track that was born in chat.
 *
 * A track made by "write me a 90 second lullaby" is the same object as one made in
 * the studio: it needs a plan (so the studio can show and edit it), an asset pointer,
 * and an edit row (so the agent can be told how it came to exist). Without this the
 * audio existed and the studio had never heard of it.
 */
export async function registerChatTrack(
  userId: string,
  jobId: string,
  opts: { brief: string; seconds: number; assetId: number; bytes: number },
): Promise<void> {
  const sql = await getSql();
  const existing = await getStudio(userId, jobId);
  const plan: MusicPlan = {
    ...(existing?.plan ?? EMPTY_PLAN),
    prompt: (existing?.plan.prompt || opts.brief).slice(0, 1200),
    seconds: opts.seconds,
    currentAssetId: opts.assetId,
  };
  await sql`
    UPDATE buzzy_jobs
       SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{music}', ${JSON.stringify(plan)}::jsonb, true),
           status = 'Audio ready', updated_at = now()
     WHERE id = ${jobId} AND user_id = ${userId}
  `;
  await sql`
    INSERT INTO buzzy_music_edits
      (user_id, job_id, actor, instruction, before_asset_id, after_asset_id, note)
    VALUES (${userId}, ${jobId}, 'agent', ${"created from chat: " + opts.brief.slice(0, 200)},
            NULL, ${opts.assetId}, ${`First render, ${opts.seconds}s, ${opts.bytes} bytes.`})
  `;
}

export interface RenderOutcome {
  ok: boolean;
  code?: string;
  error?: string;
  assetId?: number;
  url?: string;
  bytes?: number;
  note?: string;
}

/**
 * Render the plan, optionally as an edit of it. Writes the asset, points the job at
 * it and appends the change row in one place so no caller can do half of it.
 */
export async function renderTrack(
  userId: string,
  jobId: string,
  opts: { plan: MusicPlan; actor: "user" | "agent"; instruction?: string; fromMs?: number | null; toMs?: number | null },
): Promise<RenderOutcome> {
  const sql = await getSql();
  const { plan, actor } = opts;
  const regionFrom = opts.fromMs ?? null;
  const regionTo = opts.toMs ?? null;
  const isEdit = regionFrom != null && regionTo != null;

  const prompt = isEdit
    ? composeEditPrompt(plan, opts.instruction || "improve this passage", regionFrom, regionTo)
    : composePrompt(plan);

  const prior = await sql<{ id: string }>`
    SELECT id FROM buzzy_assets WHERE user_id = ${userId} AND job_id = ${jobId}
     AND (content_type LIKE 'audio/%' OR content_type IS NULL) ORDER BY id DESC LIMIT 1
  `;
  const beforeId = prior[0] ? Number(prior[0].id) : null;

  const made = await gatedMusic(userId, prompt, plan.seconds * 1000);
  if (!made.ok || !made.bytes) {
    return { ok: false, code: made.code, error: made.error };
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const stored = await storeAudio(userId, made.bytes, `music-${stamp}.mp3`, made.contentType || "audio/mpeg");
  const url = `/api/buzzy/assets/${stored.id}`;

  const note = isEdit
    ? `Re-rendered the whole track with "${opts.instruction}" applied to ${(regionFrom! / 1000).toFixed(1)}s–${(regionTo! / 1000).toFixed(1)}s. The provider has no region inpainting, so the rest is generated to match the previous description rather than spliced from it.`
    : "First render of this plan.";

  const nextPlan: MusicPlan = { ...plan, currentAssetId: stored.id };
  await sql`
    UPDATE buzzy_jobs
       SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{music}', ${JSON.stringify(nextPlan)}::jsonb, true),
           status = 'Audio ready', updated_at = now()
     WHERE id = ${jobId} AND user_id = ${userId}
  `;
  await sql`UPDATE buzzy_assets SET job_id = ${jobId} WHERE user_id = ${userId} AND id = ${stored.id}`;

  await sql`
    INSERT INTO buzzy_music_edits
      (user_id, job_id, actor, instruction, region_from_ms, region_to_ms, before_asset_id, after_asset_id, note, changes)
    VALUES (${userId}, ${jobId}, ${actor}, ${opts.instruction ?? (isEdit ? null : "initial render")},
            ${regionFrom}, ${regionTo}, ${beforeId}, ${stored.id}, ${note},
            ${JSON.stringify({ seconds: plan.seconds, instruments: plan.instruments, tempo: plan.tempo ?? null, key: plan.key ?? null })}::jsonb)
  `;

  return { ok: true, assetId: stored.id, url, bytes: stored.bytes, note };
}

/**
 * What the agent is told about this track: the plan and the recent changes, in the
 * order they happened. Injected into the chat prompt so "what did I change?" is
 * answerable without a second round-trip to the database.
 */
export async function musicContextForAgent(userId: string, jobId: string, limit = 8): Promise<string> {
  const state = await getStudio(userId, jobId);
  if (!state) return "";
  const hasMusic = state.asset || state.plan.prompt || state.plan.lyrics;
  if (!hasMusic) return "";
  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const lines = state.edits
    .slice(0, limit)
    .map((e) => {
      const who = e.actor === "agent" ? "you" : "the owner";
      const where = e.fromMs != null && e.toMs != null ? ` at ${fmt(e.fromMs)}–${fmt(e.toMs)}` : "";
      return `${who}${where}: ${e.instruction || "(no instruction)"}`;
    });
  return [
    `This project is a music track: "${state.title}".`,
    state.plan.instruments.length ? `Instruments on the plan: ${state.plan.instruments.join(", ")}.` : "",
    state.plan.lyrics ? `Lyrics on file: ${state.plan.lyrics.slice(0, 400)}` : "No lyrics on file.",
    state.versions.length ? `${state.versions.length} rendered version(s); the current one is asset ${state.asset?.id ?? "unknown"}.` : "Nothing rendered yet.",
    lines.length ? `Changes so far, newest first — ${lines.join(" | ")}` : "No edits yet.",
  ]
    .filter(Boolean)
    .join("\n");
}
