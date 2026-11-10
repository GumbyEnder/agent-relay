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

/**
 * "Beezilla" / "bee zilla" / "Bee-Zilla" / "bezilla" → the product's spelling.
 * The one-e spelling is what the live model actually returned on a QA clip
 * (2026-11-10), so the prefix is optional and a single "l" is accepted.
 */
const brandFix = (text: string) =>
  text.replace(/\b(?:b?ee?[\s-]?)?zil{1,2}a\b/gi, "BeeZilla");

/**
 * Squashed form of a term: letters and digits only, lowercase. This is what
 * makes a rewrite *boundary-insensitive* — "Honey Crumb", "honeycrumb" and
 * "Honey-Crumb" all squash to `honeycrumb`, so one comparison catches all three
 * spellings without a list of separator variants.
 */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The per-request vocabulary (BZ-22). NOT a prompt glossary.
 *
 * Measured 2026-11-10 on a spoken clip of "Add a bakery job for Honey Crumb,
 * three locations, opening in spring.": the live model returns "Honeycrumb"
 * 2/2 — it joins the two-word name. Adding "Honey Crumb" to the system prompt
 * *or* to the user turn fixes that clip 2/2 and then makes a pure 1 kHz tone
 * transcribe as "Honey Crumb, Honey Drops, BeeZilla" 2/2 — a phantom user turn,
 * which is far worse than the miss (same priming trap the brand name hit).
 *
 * So the correction is post-hoc and one-directional: it only rewrites words the
 * model already heard, and only when the transcript is non-empty. It can never
 * introduce a word on silence.
 */
export function normalizeVocab(raw: unknown, minSquash = 3): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const term = String(item ?? "").trim().replace(/\s+/g, " ");
    if (term.length < 3 || term.length > 48) continue;
    // Letters, digits, spaces and the punctuation a name actually carries. A
    // term with a quote or a newline in it is not a name, it is an injection.
    if (!/[a-z]/i.test(term) || /[^A-Za-z0-9 .'&-]/.test(term)) continue;
    const key = squash(term);
    if (key.length < minSquash || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Rewrite every word run in `text` whose squashed form equals a vocabulary
 * term's squashed form. Words are only joined across whitespace or hyphens, so
 * "Honey, Crumb" is left alone — a comma is a different phrase, not a spelling.
 */
export function applyVocab(text: string, terms: string[]): string {
  if (!text || terms.length === 0) return text;
  const canonical = new Map<string, string>();
  let longest = 0;
  for (const term of terms) {
    const key = squash(term);
    if (!key) continue;
    if (!canonical.has(key)) canonical.set(key, term);
    longest = Math.max(longest, key.length);
  }
  if (canonical.size === 0) return text;

  const words: Array<{ start: number; end: number }> = [];
  const wordRe = /[A-Za-z0-9']+/g;
  for (let m = wordRe.exec(text); m; m = wordRe.exec(text)) {
    words.push({ start: m.index, end: m.index + m[0].length });
  }
  if (words.length === 0) return text;

  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < words.length) {
    let matched = false;
    // Longest run first: "Honey Crumb Bakery" must not be eaten by "Honey".
    const maxRun = Math.min(6, words.length - i);
    for (let n = maxRun; n >= 1; n--) {
      let gapOk = true;
      for (let k = i; k < i + n - 1; k++) {
        const gap = text.slice(words[k].end, words[k + 1].start);
        if (!/^[\s-]*$/.test(gap)) {
          gapOk = false;
          break;
        }
      }
      if (!gapOk) continue;
      const span = text.slice(words[i].start, words[i + n - 1].end);
      const key = squash(span);
      if (key.length > longest) continue;
      const want = canonical.get(key);
      if (!want) continue;
      out += text.slice(cursor, words[i].start) + want;
      cursor = words[i + n - 1].end;
      i += n;
      matched = true;
      break;
    }
    if (!matched) i += 1;
  }
  return out + text.slice(cursor);
}

/**
 * Transcribe one recorded clip. Throws on transport failure; an empty string is a
 * legitimate result (silence), not an error.
 */
export async function transcribeAudio(
  audio: Uint8Array,
  format: AsrFormat,
  vocab: string[] = [],
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
  return {
    text: saidNothing ? "" : brandFix(applyVocab(text, vocab)).slice(0, 4000),
    ms,
    model: ASR_MODEL,
  };
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
