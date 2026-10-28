/**
 * Tool-call telemetry.
 *
 * Identity + timing only: which tool, which turn, how long, did it work, which
 * gate applied, how big the result was. Never the arguments and never the
 * result — a search query is the owner's words, and a page result is somebody
 * else's content.
 *
 * A lost row must never break a turn: every write is best-effort and swallows
 * its own failure with a warning.
 */

export interface ToolCallRow {
  userId: string;
  jobId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  tool: string;
  gate?: string | null;
  ms?: number | null;
  ok: boolean;
  errorCode?: string | null;
  bytes?: number | null;
  path?: string | null;
}

export async function recordToolCall(sql: any, row: ToolCallRow): Promise<void> {
  try {
    await sql`
      INSERT INTO buzzy_tool_calls
        (user_id, job_id, session_id, turn_id, tool, gate, ms, ok, error_code, result_bytes, path)
      VALUES
        (${row.userId}, ${row.jobId ?? null}, ${row.sessionId ?? null}, ${row.turnId ?? null},
         ${row.tool}, ${row.gate ?? null}, ${row.ms ?? null}, ${row.ok},
         ${row.errorCode ?? null}, ${row.bytes ?? null}, ${row.path ?? null})
    `;
  } catch (err) {
    console.warn("[buzzy/tool-telemetry] insert failed:", err instanceof Error ? err.message : err);
  }
}
