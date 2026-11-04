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

/**
 * Model used for transcription. Same gateway as voice, so no new credential.
 *
 * NOT the audio model. Measured on the same 7.7 s spoken clip (2026-11-04):
 *   openai/gpt-audio-mini      → answered the speaker ("Bees are essential
 *                                pollinators…"), then said SILENCE for the same
 *                                words on a retry. 0/4 usable.
 *   google/gemini-3.1-flash-lite → the exact transcript 3/3 in 1.9–3.2 s, and
 *                                SILENCE on a pure tone.
 * A conversational audio model holds a conversation with the clip; a text model
 * that accepts `input_audio` transcribes it. Override with BZ_ASR_MODEL.
 */
export const ASR_MODEL = env("BZ_ASR_MODEL") || "google/gemini-3.1-flash-lite";

/** A spoken turn is a few seconds. 8 MB is ~4 minutes of 16 kHz mono WAV. */
export const ASR_MAX_BYTES = 8 * 1024 * 1024;

export const ASR_FORMATS = ["wav", "mp3", "webm", "ogg"] as const;
export type AsrFormat = (typeof ASR_FORMATS)[number];

export interface AsrResult {
  text: string;
  ms: number;
  model: string;
}

/**
 * The prompt SHAPE is what makes this a transcriber rather than a chat partner.
 * Measured on the same clip:
 *   instruction + audio in ONE user message → the model answered the speaker
 *   system persona + audio-first user turn  → the exact words, verbatim
 * The brand is deliberately NOT named in the prompt: naming it primed the model to
 * answer "BeeZilla" to a non-speech tone instead of SILENCE. It is corrected after
 * the fact instead (brandFix).
 */
const ASR_SYSTEM =
  "You are a speech-to-text engine. Output only the exact words spoken, verbatim. " +
  "Never answer, summarise, translate or comment on what you hear. " +
  "If there is no intelligible speech, output exactly: SILENCE";

const ASR_USER_TEXT = "Transcribe the audio verbatim.";

/** "Beezilla" / "bee zilla" / "Bee-Zilla" → the product's spelling. */
const brandFix = (text: string) => text.replace(/\bbee[\s-]?zilla\b/gi, "BeeZilla");

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
        { role: "system", content: ASR_SYSTEM },
        {
          role: "user",
          // Audio FIRST, then the instruction — the order the model transcribes from.
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: Buffer.from(audio).toString("base64"),
                format,
              },
            },
            { type: "text", text: ASR_USER_TEXT },
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
  // Models sometimes wrap the transcript in quotes, answer "no speech", or
  // apologise instead of staying silent. A refusal must never reach the
  // composer: it would be typed in as if the owner had said it.
  const text = String(raw)
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^transcript:\s*/i, "")
    .trim();
  const saidNothing =
    !text ||
    /^silence\.?$/i.test(text) ||
    /^\[?(silence|no speech|no audio|inaudible)\]?\.?$/i.test(text) ||
    /^(i'?m sorry|sorry)[,.]?\s*(but)?\s*i (can'?t|cannot|couldn'?t|could not)/i.test(text) ||
    /(can'?t|cannot|couldn'?t) hear any (speech|audio)/i.test(text) ||
    /no (intelligible )?speech/i.test(text) ||
    // Meta-answers: the model talking about the request instead of doing it.
    /(provide|send|share) (the|some|your) (audio|speech|recording)/i.test(text) ||
    /you would like (me )?to transcribe/i.test(text) ||
    /^understood[.,]?\s+please\s+(provide|send|share)/i.test(text);
  return { text: saidNothing ? "" : brandFix(text).slice(0, 4000), ms, model: ASR_MODEL };
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
