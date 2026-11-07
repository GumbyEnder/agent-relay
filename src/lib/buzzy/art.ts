/**
 * Image generation.
 *
 * The provider has no /images/generations endpoint — image models answer on
 * /chat/completions and return their picture in `choices[0].message.images[0]
 * .image_url.url` as a `data:image/png;base64,...` URL. Verified live:
 * google/gemini-3-pro-image returned 5.2 MB of PNG for one prompt.
 *
 * Same rule as music: the capability is performed by the harness, never left to
 * the model to decide to call.
 */
import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";

const env = (k: string) => (process.env[k] ?? "").trim();
const BASE_URL = env("BZ_CHAT_BASE_URL") || "https://inference-api.nousresearch.com/v1";
const API_KEY = env("BZ_CHAT_KEY");
const IMAGE_MODEL = env("BZ_IMAGE_MODEL") || "google/gemini-3-pro-image";

export function artConfigured(): boolean {
  return Boolean(API_KEY);
}

export function imageModel(): string {
  return IMAGE_MODEL;
}

export interface ArtResult {
  ok: boolean;
  bytes?: Buffer;
  contentType?: string;
  code?: string;
  error?: string;
  ms?: number;
  model?: string;
}

/** Turn a board or a prompt into one image. */
export async function generateImage(prompt: string, opts?: { referenceImages?: string[] }): Promise<ArtResult> {
  const started = Date.now();
  if (!API_KEY) return { ok: false, code: "not_configured", error: "BZ_CHAT_KEY is not set" };

  // Board references arrive as data URLs; the provider accepts them inline, so the
  // drawing the owner made IS the conditioning and not merely a description of it.
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt.slice(0, 4000) }];
  for (const ref of (opts?.referenceImages ?? []).slice(0, 4)) {
    if (typeof ref === "string" && ref.startsWith("data:image/")) {
      content.push({ type: "image_url", image_url: { url: ref } });
    }
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        messages: [{ role: "user", content }],
        modalities: ["image", "text"],
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return {
      ok: false,
      code: "provider_unreachable",
      error: err instanceof Error ? err.message : "network error",
      ms: Date.now() - started,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      code: res.status === 402 ? "provider_plan_required" : "provider_error",
      error: `provider ${res.status}: ${text.slice(0, 300)}`,
      ms: Date.now() - started,
    };
  }

  const body = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }> }
    | null;
  const url = body?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) {
    return { ok: false, code: "no_image", error: "the provider answered without an image", ms: Date.now() - started };
  }

  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (!m) {
    return { ok: false, code: "no_image", error: "image was not inlined as base64", ms: Date.now() - started };
  }
  const bytes = Buffer.from(m[2]!, "base64");
  if (!bytes.byteLength) {
    return { ok: false, code: "no_image", error: "decoded image was empty", ms: Date.now() - started };
  }
  return { ok: true, bytes, contentType: m[1]!, ms: Date.now() - started, model: IMAGE_MODEL };
}

/** Same storage the audio path uses: one asset table, one download route. */
export async function storeImage(
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
