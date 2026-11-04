import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";

/**
 * Music, from ElevenLabs.
 *
 * Two things this file refuses to do:
 *
 *  1. Pretend an account-level refusal is a code bug. A free ElevenLabs plan
 *     answers 402 `paid_plan_required` for the Music API, and a scoped key
 *     answers 401 `missing_permissions` naming the scope. Both are reported as
 *     they are, with the scope and the plan named, because "music failed" tells
 *     nobody anything.
 *  2. Write the key anywhere. It comes from BZ_ELEVEN_KEY, set on the service.
 */

const BASE = "https://api.elevenlabs.io/v1";
const KEY = process.env.BZ_ELEVEN_KEY || "";

export interface MusicResult {
  ok: boolean;
  bytes?: Buffer;
  contentType?: string;
  code?: string;
  error?: string;
}

export function musicConfigured(): boolean {
  return Boolean(KEY);
}

/** Human sentences for the two account-level refusals that will actually happen. */
function explain(status: number, body: string): { code: string; error: string } {
  let detail: { code?: string; message?: string; status?: string } = {};
  try {
    const parsed = JSON.parse(body) as { detail?: { code?: string; message?: string; status?: string } };
    detail = parsed.detail || {};
  } catch {
    /* not JSON */
  }
  if (status === 402 || detail.code === "paid_plan_required") {
    return {
      code: "paid_plan_required",
      error:
        "The ElevenLabs account is on the free plan, which cannot use the Music API " +
        "(ElevenLabs: 'Music API is not available for free users'). Starter is $6/month " +
        "and includes music commercial use — upgrade at elevenlabs.io/app/subscription " +
        "and this works with no code change.",
    };
  }
  if (status === 401 && detail.code === "unauthorized") {
    const scope = /permission ([a-z_]+)/i.exec(detail.message || "")?.[1];
    return {
      code: "missing_permission",
      error: scope
        ? `The API key is valid but lacks the "${scope}" permission. Tick it on the key in ElevenLabs and retry.`
        : "The API key is valid but not permitted for this operation.",
    };
  }
  if (status === 429) return { code: "rate_limited", error: "ElevenLabs is rate-limiting this account — try again shortly." };
  return { code: "music_failed", error: detail.message || `ElevenLabs answered ${status}.` };
}

/** The tool the model calls to actually make a track. */
export const GENERATE_MUSIC_TOOL = {
  type: "function",
  function: {
    name: "generate_music",
    description:
      "Compose instrumental music and save it to the owner's Library as an audio file. " +
      "Use when the owner asks for a song, track, score, jingle or background music. " +
      "Put every musical instruction (tempo, key, instrumentation, structure, duration) in `prompt`: " +
      "the provider reads style and structure from prose, not from separate fields. " +
      "Call it once per request — never claim a track without calling it.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The production brief in prose: genre, instrumentation, tempo (BPM), key, and the section " +
            "structure with timings. Example: 'Orchestral-electronic, 96 BPM, A minor, solo cello 0:00-0:12, " +
            "strings enter 0:12, synth bass 0:30, full drop 0:55, strings outro to 2:00.'",
        },
        seconds: {
          type: "number",
          description: "Length in seconds (3-300). Defaults to the length implied by the brief, or 20.",
        },
      },
      required: ["prompt"],
    },
  },
} as const;

/**
 * Managed mode: the local runtime has no provider key of its own, so music goes
 * through OUR gateway with the same short-lived token that already carries chat.
 * Set by the desktop shell (BZ_MUSIC_VIA_GATEWAY = the inference gateway base).
 */
const VIA_GATEWAY = () => (process.env.BZ_MUSIC_VIA_GATEWAY ?? "").trim().replace(/\/+$/, "");
const GATEWAY_TOKEN = () => (process.env.BZ_CHAT_KEY ?? "").trim();

export async function generateMusic(prompt: string, lengthMs = 20000): Promise<MusicResult> {
  const via = VIA_GATEWAY();
  if (!via && !KEY) {
    return {
      ok: false,
      code: "not_configured",
      error:
        "No music provider is configured — either connect a BeeZilla account (managed music) or add your own ElevenLabs key in Settings.",
    };
  }
  const text = prompt.trim().slice(0, 2000);
  if (!text) return { ok: false, code: "no_prompt", error: "Describe the music you want." };
  const ms = Math.min(Math.max(lengthMs, 3000), 300000);

  // Managed first: a connected account is the normal case, and it needs no key on
  // this machine at all. Quota, plan and revocation are enforced by the gateway.
  if (via) {
    const token = GATEWAY_TOKEN();
    if (!token) {
      return { ok: false, code: "not_configured", error: "BeeZilla music needs a signed-in account — reconnect from Settings." };
    }
    try {
      const res = await fetch(`${via}/music`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ prompt: text, seconds: Math.round(ms / 1000) }),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) {
        let parsed: { code?: string; error?: string; plan?: string; limit?: number; used?: number } = {};
        try {
          parsed = (await res.json()) as typeof parsed;
        } catch {
          /* not JSON */
        }
        return {
          ok: false,
          code: parsed.code || `gateway_${res.status}`,
          error:
            parsed.error ||
            (res.status === 402
              ? "Music is not included in this plan."
              : res.status === 429
                ? "Music quota reached — it resets on a rolling 24 h window."
                : `BeeZilla music answered ${res.status}.`),
        };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, code: "empty_audio", error: "BeeZilla music returned no audio." };
      return { ok: true, bytes: buf, contentType: res.headers.get("content-type") || "audio/mpeg" };
    } catch (e) {
      return { ok: false, code: "unreachable", error: `Could not reach BeeZilla music: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  try {
    const res = await fetch(`${BASE}/music`, {
      method: "POST",
      headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
      // music_v2_5 is the current model; without model_id the API silently serves
      // music_v1, which is older and 128 kbps. Verified against the compose docs.
      body: JSON.stringify({ prompt: text, music_length_ms: ms, model_id: "music_v2_5" }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const body = await res.text();
      const e = explain(res.status, body);
      return { ok: false, ...e };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, code: "empty_audio", error: "ElevenLabs returned no audio." };
    return { ok: true, bytes: buf, contentType: res.headers.get("content-type") || "audio/mpeg" };
  } catch (e) {
    return { ok: false, code: "unreachable", error: `Could not reach ElevenLabs: ${(e as Error).message.slice(0, 120)}` };
  }
}

/** Store generated audio in the same content-addressed shelf as any other upload. */
export async function storeAudio(
  userId: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<{ id: number; path: string; bytes: number; duplicate: boolean }> {
  const sql = await getSql();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const inserted = await sql<{ id: number; rel_path: string }>`
    INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body)
    VALUES (${userId}, ${sha256}, ${filename}, ${filename}, ${contentType}, ${bytes.byteLength}, ${bytes})
    ON CONFLICT (user_id, sha256) DO NOTHING
    RETURNING id, rel_path
  `;
  if (inserted.length) {
    return { id: inserted[0]!.id, path: inserted[0]!.rel_path, bytes: bytes.byteLength, duplicate: false };
  }
  const prior = await sql<{ id: number; rel_path: string; bytes: number }>`
    SELECT id, rel_path, bytes FROM buzzy_assets WHERE user_id = ${userId} AND sha256 = ${sha256} LIMIT 1
  `;
  return { id: prior[0]!.id, path: prior[0]!.rel_path, bytes: prior[0]!.bytes, duplicate: true };
}
