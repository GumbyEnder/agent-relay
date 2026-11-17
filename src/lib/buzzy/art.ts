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

  const body = (await res.json().catch(() => null)) as unknown;
  const picked = pickImageUrl(body);
  if (!picked.url) {
    // The shape is logged, never the payload: an image response is megabytes of
    // base64 and printing it is both useless and a leak. Key names and part types
    // are what tell the next reader whether the provider changed its envelope.
    console.warn(
      "[buzzy/art] no image in the provider payload:",
      JSON.stringify(describePayload(body)).slice(0, 800),
      picked.reason ? `(reason: ${picked.reason})` : "",
    );
    return {
      ok: false,
      code: "no_image",
      error: picked.reason || "the provider answered without an image",
      ms: Date.now() - started,
    };
  }

  const inline = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(picked.url);
  if (inline) {
    const bytes = Buffer.from(inline[2]!, "base64");
    if (!bytes.byteLength) {
      return { ok: false, code: "no_image", error: "decoded image was empty", ms: Date.now() - started };
    }
    return { ok: true, bytes, contentType: inline[1]!, ms: Date.now() - started, model: IMAGE_MODEL };
  }

  // Not every deployment inlines the bytes. A signed or plain https URL is just
  // as much an image; fetch it now, because the provider's links expire and the
  // Library must hold the bytes, not a link that dies tomorrow.
  if (/^https?:\/\//i.test(picked.url)) {
    const got = await fetchImageUrl(picked.url, started);
    return got;
  }

  return {
    ok: false,
    code: "no_image",
    error: `image arrived in an unsupported form: ${picked.url.slice(0, 24)}…`,
    ms: Date.now() - started,
  };
}

/** The image URL inside a chat-completions payload, whatever envelope it used. */
export function pickImageUrl(body: unknown): { url?: string; reason?: string } {
  const b = body as Record<string, any> | null;
  const choices = Array.isArray(b?.choices) ? b!.choices : [];
  const choice = choices[0] ?? {};
  const msg = choice.message ?? {};

  // 1. `message.images[]` — the shape this provider uses today. Accept a bare
  //    string, `image_url` as an object or a string, `url`, or raw base64.
  const images = Array.isArray(msg.images) ? msg.images : [];
  for (const im of images) {
    if (typeof im === "string" && im) return { url: im };
    const cand =
      (typeof im?.image_url === "string" ? im.image_url : undefined) ??
      im?.image_url?.url ??
      im?.url ??
      im?.b64_json;
    if (typeof cand === "string" && cand) {
      return { url: /^[A-Za-z0-9+/=]+$/.test(cand) && cand.length > 64 ? `data:image/png;base64,${cand}` : cand };
    }
  }

  // 2. `message.content` as an array of parts — the OpenAI-compatible image
  //    extension (`{type:"image_url", image_url:{url}}`), and the Gemini-ish
  //    `{type:"image", source:{data}}` / `{type:"output_image", url}` cousins.
  const parts = Array.isArray(msg.content) ? msg.content : [];
  for (const p of parts) {
    if (typeof p === "string") {
      const dataUrl = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i.exec(p);
      if (dataUrl) return { url: dataUrl[0] };
      continue;
    }
    const type = String(p?.type ?? "");
    if (!/image/i.test(type) && !p?.image_url && !p?.inline_data && !p?.inlineData) continue;
    const cand =
      (typeof p?.image_url === "string" ? p.image_url : undefined) ??
      p?.image_url?.url ??
      p?.url ??
      p?.inline_data?.data ??
      p?.inlineData?.data;
    if (typeof cand === "string" && cand) {
      const mime = p?.inline_data?.mime_type ?? p?.inlineData?.mimeType ?? "image/png";
      const isBare = /^[A-Za-z0-9+/=]+$/.test(cand) && cand.length > 64;
      return { url: isBare ? `data:${mime};base64,${cand}` : cand };
    }
  }

  // 3. `message.content` as a plain string that carries a data URL.
  if (typeof msg.content === "string") {
    const dataUrl = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i.exec(msg.content);
    if (dataUrl) return { url: dataUrl[0] };
  }

  const refusal = msg.refusal ?? choice.finish_reason;
  return {
    reason:
      "the provider answered without an image" +
      (typeof refusal === "string" && refusal ? ` (${refusal.slice(0, 120)})` : ""),
  };
}

/** Key names and part types only — never a value that could be a payload. */
export function describePayload(body: unknown): Record<string, unknown> {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== "object") return { body: typeof b };
  const choice = (Array.isArray(b.choices) ? b.choices[0] : null) as Record<string, any> | null;
  const msg = (choice?.message ?? {}) as Record<string, any>;
  const content = msg.content;
  const scheme = (v: unknown) =>
    typeof v === "string" ? (v.startsWith("data:") ? `data:${v.slice(5, 20)}` : /^https?:/i.test(v) ? "https:" : `string(${v.length})`) : typeof v;
  return {
    top: Object.keys(b),
    choice: choice ? Object.keys(choice) : null,
    finish_reason: choice?.finish_reason ?? null,
    message: Object.keys(msg),
    content: Array.isArray(content)
      ? content.map((p: any) => ({ type: p?.type, keys: p && typeof p === "object" ? Object.keys(p) : typeof p }))
      : typeof content === "string"
        ? `string(${content.length})`
        : content,
    images: Array.isArray(msg.images)
      ? msg.images.map((im: any) => (typeof im === "string" ? scheme(im) : { keys: Object.keys(im ?? {}), url: scheme(im?.image_url?.url ?? im?.url) }))
      : msg.images ?? null,
    refusal: typeof msg.refusal === "string" ? `string(${msg.refusal.length})` : msg.refusal ?? null,
  };
}

/** Fetch an image the provider linked to rather than inlined. */
export async function fetchImageUrl(url: string, started: number): Promise<ArtResult> {
  const MAX = 32 * 1024 * 1024;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      return { ok: false, code: "image_download_failed", error: `image link answered ${res.status}`, ms: Date.now() - started };
    }
    const type = (res.headers.get("content-type") || "").split(";")[0]!.trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.byteLength) {
      return { ok: false, code: "no_image", error: "linked image was empty", ms: Date.now() - started };
    }
    if (buf.byteLength > MAX) {
      return { ok: false, code: "no_image", error: `linked image was ${buf.byteLength} bytes — too large to store`, ms: Date.now() - started };
    }
    if (type && !/^image\//i.test(type)) {
      return { ok: false, code: "no_image", error: `image link answered ${type}, not an image`, ms: Date.now() - started };
    }
    return {
      ok: true,
      bytes: buf,
      contentType: /^image\//i.test(type) ? type : sniffImageType(buf),
      ms: Date.now() - started,
      model: IMAGE_MODEL,
    };
  } catch (err) {
    return {
      ok: false,
      code: "image_download_failed",
      error: err instanceof Error ? err.message : "image link could not be read",
      ms: Date.now() - started,
    };
  }
}

/** A stored image must be labelled honestly; magic bytes settle it. */
export function sniffImageType(buf: Buffer): string {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png";
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
