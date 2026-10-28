/**
 * Buzzy voice lane — speech-to-speech-ish completions.
 *
 * The text lane calls chat/completions with stream:false, so the owner waits
 * for the WHOLE reply before a single word is spoken. This module streams a
 * chat completion that returns text AND audio in the same response, so the
 * avatar can start talking on the first audio chunk (measured: ~1.1s to first
 * audio vs ~7-15s for a buffered text turn).
 *
 * Wire shape (OpenAI-compatible, Nous):
 *   POST /chat/completions
 *   { model, modalities:["text","audio"], audio:{voice,format}, stream:true }
 *   → SSE deltas: choices[0].delta.content (text)
 *                 choices[0].delta.audio.data (base64 PCM16 24kHz mono)
 *                 choices[0].delta.audio.transcript (what was spoken)
 *
 * Audio output REQUIRES stream:true on this provider — a non-streaming call
 * with modalities returns 400 "Audio output requires stream: true".
 */

const env = (key: string): string => process.env[key]?.trim() ?? "";

const BASE_URL = env("BZ_CHAT_BASE_URL") || "https://inference-api.nousresearch.com/v1";
const API_KEY = env("BZ_CHAT_KEY");

/** Audio-capable model. Mini is the latency pick; pro is an escalation. */
export const VOICE_MODEL = env("BZ_VOICE_MODEL") || "openai/gpt-audio-mini";
export const VOICE_NAME = env("BZ_VOICE_NAME") || "alloy";
/** pcm16 = 24kHz mono 16-bit little-endian — playable straight into Web Audio. */
export const VOICE_FORMAT = env("BZ_VOICE_FORMAT") || "pcm16";

export interface VoiceHandlers {
  /** Text as it arrives — render it live, never wait for the full reply. */
  onText?: (text: string) => void;
  /** Base64 audio chunk + its container format. */
  onAudio?: (b64: string, format: string) => void;
}

export interface VoiceResult {
  text: string;
  transcript: string;
  model: string;
  /** ms from request start to the first text delta. */
  ttftMs: number | null;
  /** ms from request start to the first audio chunk (time to talk). */
  ttfaMs: number | null;
  totalMs: number;
  audioBytes: number;
  finishReason: string | null;
}

export function voiceAvailable(): boolean {
  return API_KEY !== "";
}

/**
 * Stream one spoken reply. Throws on transport/HTTP failure so the caller can
 * fall back to the text lane rather than going silent.
 */
export async function voiceCompletion(
  messages: Array<{ role: string; content: string }>,
  opts: {
    model?: string;
    voice?: string;
    format?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  },
  handlers: VoiceHandlers = {},
): Promise<VoiceResult> {
  if (!API_KEY) throw new Error("BZ_CHAT_KEY is not set");
  const model = opts.model || VOICE_MODEL;
  const format = opts.format || VOICE_FORMAT;
  const url = BASE_URL.replace(/\/+$/, "") + "/chat/completions";
  const started = Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      modalities: ["text", "audio"],
      audio: { voice: opts.voice || VOICE_NAME, format },
      temperature: opts.temperature ?? 0.6,
      max_tokens: opts.maxTokens ?? 400,
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Voice request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  let text = "";
  let transcript = "";
  let sawContent = false;
  let ttftMs: number | null = null;
  let ttfaMs: number | null = null;
  let audioBytes = 0;
  let finishReason: string | null = null;
  let buffer = "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; keep the tail for the next read.
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              audio?: { data?: string; transcript?: string };
            };
            finish_reason?: string | null;
          }>;
          model?: string;
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          if (ttftMs === null) ttftMs = Date.now() - started;
          sawContent = true;
          text += delta.content;
          handlers.onText?.(delta.content);
        }
        const audio = delta.audio;
        if (audio?.data) {
          if (ttfaMs === null) ttfaMs = Date.now() - started;
          audioBytes += Math.floor((audio.data.length * 3) / 4);
          handlers.onAudio?.(audio.data, format);
        }
        if (audio?.transcript) {
          transcript += audio.transcript;
          // gpt-audio models speak the words but send NO content deltas — the
          // spoken text arrives as `audio.transcript`. Forward it as text so
          // the transcript bubble fills while the avatar talks, but never
          // double-count when a model sends both content and transcript.
          if (!sawContent) {
            if (ttftMs === null) ttftMs = Date.now() - started;
            text += audio.transcript;
            handlers.onText?.(audio.transcript);
          }
        }
      }
    }
  }

  // Some providers return the spoken words only in the transcript stream.
  if (!text.trim() && transcript.trim()) text = transcript.trim();

  return {
    text: text.trim(),
    transcript: transcript.trim(),
    model,
    ttftMs,
    ttfaMs,
    totalMs: Date.now() - started,
    audioBytes,
    finishReason,
  };
}
