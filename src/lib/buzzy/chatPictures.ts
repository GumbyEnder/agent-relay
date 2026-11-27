/**
 * The pictures added to a conversation (Talk's paperclip), kept with it (0073
 * buzzy_chat_pictures): reopened from History, "make this photo 3D" still means that photo
 * (independent review, 2026-11-25). Ids only — the picture stays in buzzy_assets and goes
 * with it — and only the person's own pictures.
 */
import type { Sql } from "@/lib/db";

/**
 * Keep a turn's pictures with its conversation, in the order the page knows them:
 *  - `added`: the ones this message carries, in the order they were added — a picture
 *    added again counts from its last time (A, B, then A again: A is the newest) — and they
 *    are the newest of the conversation;
 *  - `earlier`: ones the page still holds from before (newest first), for instance after a
 *    send that failed before it reached here. One already kept keeps its time; one not kept
 *    yet is put between its kept neighbours, in the page's order (never assuming kept times
 *    are a second apart), so History lists them as the page did.
 */
export async function keepConversationPictures(
  sql: Sql,
  userId: string,
  sessionId: string,
  added: number[],
  earlier: number[],
): Promise<void> {
  const fresh = added.filter((id, i) => added.lastIndexOf(id) === i);
  // Oldest first.
  const before = [...new Set(earlier.filter((id) => !fresh.includes(id)))].reverse();
  const kept = new Map<number, number>();
  for (const id of before) {
    const rows = await sql<{ added_at: string | Date }>`
      SELECT added_at FROM buzzy_chat_pictures WHERE user_id = ${userId} AND session_id = ${sessionId} AND asset_id = ${id} LIMIT 1`;
    if (rows[0]) kept.set(id, new Date(rows[0].added_at).getTime());
  }
  const latest = await sql<{ at: string | Date | null }>`
    SELECT max(added_at) AS at FROM buzzy_chat_pictures WHERE user_id = ${userId} AND session_id = ${sessionId}`;
  const newestKept = latest[0]?.at ? new Date(latest[0].at).getTime() : 0;
  const now = Math.max(Date.now(), newestKept + 1);
  const put = async (id: number, at: number, again: "keep" | "move") => {
    const iso = new Date(at).toISOString();
    if (again === "keep") {
      await sql`
        INSERT INTO buzzy_chat_pictures (user_id, session_id, asset_id, added_at)
        SELECT ${userId}, ${sessionId}, id, ${iso}::timestamptz FROM buzzy_assets WHERE user_id = ${userId} AND id = ${id}
        ON CONFLICT (user_id, session_id, asset_id) DO NOTHING`;
    } else {
      await sql`
        INSERT INTO buzzy_chat_pictures (user_id, session_id, asset_id, added_at)
        SELECT ${userId}, ${sessionId}, id, ${iso}::timestamptz FROM buzzy_assets WHERE user_id = ${userId} AND id = ${id}
        ON CONFLICT (user_id, session_id, asset_id) DO UPDATE SET added_at = EXCLUDED.added_at`;
    }
  };
  // Each run of not-yet-kept pictures goes evenly into the gap between the kept ones around
  // it (or before the first kept one, or up to now).
  for (let i = 0; i < before.length;) {
    if (kept.has(before[i]!)) { i++; continue; }
    let j = i;
    while (j < before.length && !kept.has(before[j]!)) j++;
    const n = j - i;
    const hi = j < before.length ? kept.get(before[j]!)! : now;
    const lo = i > 0 ? kept.get(before[i - 1]!)! : hi - (n + 1) * 1000;
    const step = hi - lo > n ? (hi - lo) / (n + 1) : 1;
    for (let k = 0; k < n; k++) await put(before[i + k]!, Math.round(lo + step * (k + 1)), "keep");
    i = j;
  }
  // The ones this message carries: the newest, in the order they were added.
  for (let k = 0; k < fresh.length; k++) await put(fresh[k]!, now + 1 + k, "move");
}

/** The conversation's pictures, newest first (at most six). */
export async function conversationPictures(sql: Sql, userId: string, sessionId: string): Promise<number[]> {
  const rows = await sql<{ asset_id: number | string }>`
    SELECT asset_id FROM buzzy_chat_pictures
    WHERE user_id = ${userId} AND session_id = ${sessionId}
    ORDER BY added_at DESC, asset_id DESC LIMIT 6`;
  return rows.map((r) => Number(r.asset_id)).filter((n) => Number.isSafeInteger(n) && n > 0);
}
