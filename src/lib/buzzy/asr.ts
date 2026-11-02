/**
 * Server-side speech-to-text.
 *
 * Why this exists: the browser SpeechRecognition API is Chrome-only. Firefox
 * ships no implementation at all and Brave exposes it only to return
 * `service-not-allowed`, so a Firefox or Brave user could never talk to BeeZilla
 * no matter what the page did. Recording audio needs nothing but getUserMedia,
 * which every browser has — so the fallback is the audio model itself:
 * `openai/gpt-audio-mini` accepts `input_audio` on the chat endpoint and
 * transcribes it accurately.
 *
 * No new provider and no new key: it rides BZ_CHAT_BASE_URL / BZ_CHAT_KEY.
 *
 * The prompt carries a tiny glossary because the product name is the one word
 * the model gets wrong ("Bezilla"). Keep corrections additive and short; a long
 * prompt slows transcription down.
 */

const env = (key: string): string => {
  const v = process.env[key]?.trim();
  return v ?? "";
};

const BASE_URL = env("BZ_CHAT_BASE_URL") || "https://inference-api.nousresearch.com/v1";
const API_KEY = env("BZ_CHAT_KEY");

/** Model used for transcription. Same gateway as voice, so no new credential. */
export const ASR_MODEL = env("BZ_ASR_MODEL") || "openai/gpt-audio-mini";

/** A spoken turn is a few seconds. 8 MB is ~4 minutes of 16 kHz mono WAV. */
export const ASR_MAX_BYTES = 8 * 1024 * 1024;

export const ASR_FORMATS = ["wav", "mp3", "webm", "ogg"] as const;
export type AsrFormat = (typeof ASR_FORMATS)[number];

export interface AsrResult {
  text: string;
  ms: number;
  model: string;
}

const INSTRUCTION =
  "Transcribe the speech verbatim. Return only the transcript text — no quotes, " +
  "no commentary, no speaker labels. The speaker is usually talking to a product " +
  "called BeeZilla (spoken \"bee-zilla\"); spell it BeeZilla. If there is no speech, " +
  "return an empty string.";

/**
 * Transcribe one recorded clip. Throws on transport failure; an empty string is a
 * legitimate result (silence), not an error.
 */
export async function transcribeAudio(
  audio: Uint8Array,
  format: AsrFormat,
): Promise<AsrResult> {
  if (!API_KEY) throw new Error("transcription is not configured (BZ_CHAT_KEY missing)");
  if (audio.byteLength === 0) throw new Error("no audio");
  if (audio.byteLength > ASR_MAX_BYTES) throw new Error("audio too large");

  const url = BASE_URL.replace(/\/+$/, "") + "/chat/completions";
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: ASR_MODEL,
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: INSTRUCTION },
            {
              type: "input_audio",
              input_audio: {
                data: Buffer.from(audio).toString("base64"),
                format,
              },
            },
          ],
        },
      ],
    }),
  });

  const ms = Date.now() - started;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  // Models sometimes wrap the transcript in quotes or answer "no speech".
  const text = String(raw)
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^transcript:\s*/i, "")
    .trim();
  const silent = /^(no speech|no audio|\[silence\]|\(silence\)|silence)\.?$/i.test(text);
  return { text: silent ? "" : text.slice(0, 4000), ms, model: ASR_MODEL };
}

/** Content-Type → format, for the client that posts a raw audio body. */
export function formatFromContentType(ct: string | undefined): AsrFormat | null {
  const v = (ct || "").toLowerCase();
  if (v.includes("wav")) return "wav";
  if (v.includes("mpeg") || v.includes("mp3")) return "mp3";
  if (v.includes("webm")) return "webm";
  if (v.includes("ogg")) return "ogg";
  return null;
}
