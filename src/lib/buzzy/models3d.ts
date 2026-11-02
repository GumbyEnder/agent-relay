import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";

/**
 * Text → 3D, from Meshy.
 *
 * Generation takes 40–90 seconds, which is longer than a proxy will hold a
 * request open, so this is a task API: POST creates, GET polls, and the model is
 * fetched and stored the first time a poll sees SUCCEEDED. The caller polls, the
 * connection stays short, and a slow provider never looks like a dead page.
 */

const BASE = "https://api.meshy.ai/openapi/v2/text-to-3d";
const KEY = process.env.BZ_MESHY_KEY || "";

export function threeDConfigured(): boolean {
  return Boolean(KEY);
}

function explain(status: number, body: string): { code: string; error: string } {
  let msg = "";
  try {
    const j = JSON.parse(body) as { message?: string; detail?: string };
    msg = j.message || j.detail || "";
  } catch {
    msg = body.slice(0, 160);
  }
  if (status === 401 || status === 403) return { code: "bad_key", error: "Meshy rejected the API key." };
  if (status === 402) return { code: "no_credits", error: "The Meshy account has no credits left." };
  if (status === 429) return { code: "rate_limited", error: "Meshy is rate-limiting this account — try again shortly." };
  return { code: "meshy_failed", error: msg || `Meshy answered ${status}.` };
}

export async function createModelTask(prompt: string): Promise<{ ok: true; taskId: string } | { ok: false; code: string; error: string }> {
  if (!KEY) return { ok: false, code: "not_configured", error: "No 3D provider is configured (BZ_MESHY_KEY is unset)." };
  const text = prompt.trim().slice(0, 600);
  if (!text) return { ok: false, code: "no_prompt", error: "Describe the model you want." };
  try {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "preview", prompt: text, art_style: "realistic", should_remesh: true }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, ...explain(res.status, body) };
    const j = JSON.parse(body) as { result?: string };
    if (!j.result) return { ok: false, code: "no_task", error: "Meshy did not return a task id." };
    return { ok: true, taskId: j.result };
  } catch (e) {
    return { ok: false, code: "unreachable", error: `Could not reach Meshy: ${(e as Error).message.slice(0, 120)}` };
  }
}

export interface TaskState {
  status: string;
  progress: number;
  glbUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

export async function readModelTask(taskId: string): Promise<TaskState | null> {
  if (!KEY) return null;
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { status: "error", progress: 0, error: explain(res.status, await res.text()).error };
    const j = (await res.json()) as {
      status?: string; progress?: number; model_urls?: { glb?: string }; thumbnail_url?: string; task_error?: { message?: string };
    };
    return {
      status: j.status || "UNKNOWN",
      progress: Number(j.progress || 0),
      glbUrl: j.model_urls?.glb,
      thumbnailUrl: j.thumbnail_url,
      error: j.task_error?.message,
    };
  } catch (e) {
    return { status: "error", progress: 0, error: (e as Error).message.slice(0, 120) };
  }
}

/** Download the finished .glb and keep it on the asset shelf. */
export async function storeModel(
  userId: string,
  glbUrl: string,
  name: string,
): Promise<{ id: number; bytes: number; duplicate: boolean } | null> {
  try {
    const res = await fetch(glbUrl, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) return null;
    const sql = await getSql();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const inserted = await sql<{ id: number }>`
      INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body)
      VALUES (${userId}, ${sha256}, ${name}, ${name}, 'model/gltf-binary', ${bytes.byteLength}, ${bytes})
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
