/**
 * Voice/turn latency metrics (server side).
 *
 * Extracted from `chat.nitro.ts` so the chat turn can leave the Nitro handler
 * without dragging a private helper with it. One INSERT per turn; a lost metric
 * must never break a turn, so every failure is swallowed and logged.
 */
import type { Sql } from "../db";

export async function recordVoiceMetrics(
  sql: Sql,
  row: {
    userId: string;
    jobId?: string | null;
    sessionId?: string | null;
    source: "client" | "server";
    mode?: string | null;
    model?: string | null;
    asrMs?: number | null;
    ttftMs?: number | null;
    ttfaMs?: number | null;
    turnMs?: number | null;
    extractMs?: number | null;
    llmMs?: number | null;
    honchoMs?: number | null;
    replyChars?: number | null;
    audioBytes?: number | null;
    spoken?: boolean;
    // Lane + speech time arrived with the streaming work: a turn that had to
    // take the text lane says so, so ops can tell "slow voice" from "voice".
    lane?: string | null;
    speechMs?: number | null;
  },
): Promise<void> {
  try {
    await sql`
      INSERT INTO buzzy_voice_metrics
        (user_id, job_id, session_id, source, mode, model, asr_ms, ttft_ms, ttfa_ms,
         turn_ms, extract_ms, llm_ms, honcho_ms, reply_chars, audio_bytes, spoken, lane, speech_ms)
      VALUES
        (${row.userId}, ${row.jobId ?? null}, ${row.sessionId ?? null}, ${row.source},
         ${row.mode ?? null}, ${row.model ?? null}, ${row.asrMs ?? null}, ${row.ttftMs ?? null},
         ${row.ttfaMs ?? null}, ${row.turnMs ?? null}, ${row.extractMs ?? null},
         ${row.llmMs ?? null}, ${row.honchoMs ?? null}, ${row.replyChars ?? null},
         ${row.audioBytes ?? null}, ${row.spoken ?? false}, ${row.lane ?? null}, ${row.speechMs ?? null})
    `;
  } catch (err) {
    // A lost metric must never break a turn.
    console.warn("[buzzy/voice-metrics] insert failed:", err instanceof Error ? err.message : err);
  }
}
