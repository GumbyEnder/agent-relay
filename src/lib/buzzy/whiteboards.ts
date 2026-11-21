/**
 * The Talk page's whiteboard, kept in the person's account.
 *
 * Asked 2026-11-18: the board should follow the person to any computer, with a simple
 * history to go back to. Until then it lived only in the browser that drew it
 * (localStorage "bz.board.<conversation id>"). That copy stays, as the buffer while
 * the account can't be reached; public/buzzy/whiteboard.js does the syncing.
 *
 * One board per person and conversation (buzzy_whiteboards, migration 0060), keyed by
 * the conversation id, or "talk" for the board in front of a conversation that has no
 * id yet. A board can only be saved for one of the person's own conversations (or
 * "talk"); reading only ever looks at the person's own rows.
 *
 * Every save names the revision it started from. If another computer saved in between,
 * the save is refused with the account's copy, the browser merges the two card by card
 * and saves again, so two computers never silently overwrite each other.
 *
 * History (buzzy_whiteboard_versions): every save lands in the newest entry; a save
 * more than VERSION_WINDOW_MINUTES after that entry began starts a new one, and going
 * back to an earlier entry always starts a new one, so the board you left is still
 * there to come back to. A save that empties a board also starts a new one: the visit
 * that opens a fresh board empties it (whiteboard.js reset()), and rolling that blank
 * into the entry the drawing had just made would throw the drawing away. At most
 * VERSIONS_KEPT entries per board, none older than VERSIONS_MAX_DAYS.
 *
 * A board is the person's own data, shown back only to them, as text (whiteboard.js
 * builds every card from textContent). This file still checks its shape, keeps only
 * the fields the board uses, caps its size, and keeps only web links (http, https or
 * this site's own paths) for anything a card opens or shows.
 */
import { createHash } from "node:crypto";
import type { Sql } from "@/lib/db";

/** One board, as stored. 160 cards with full notes come to about 700 KB. */
export const WHITEBOARD_MAX_BYTES = 1024 * 1024;
/** A save request: the board plus room for the wrapper around it. */
export const WHITEBOARD_MAX_REQUEST_BYTES = WHITEBOARD_MAX_BYTES + 64 * 1024;
/** The page holds 160 cards; two computers' cards merged can briefly hold more. */
export const WHITEBOARD_MAX_CARDS = 400;
export const WHITEBOARD_MAX_LINKS = 1000;
/** History: at most this many entries per board… */
export const VERSIONS_KEPT = 30;
/** …and none older than this many days. */
export const VERSIONS_MAX_DAYS = 90;
/** A save less than this many minutes after the newest entry began lands in it. */
export const VERSION_WINDOW_MINUTES = 5;
/** The board in front of a conversation that has no id yet (voice-stage.js). */
export const SCRATCH_BOARD = "talk";

const BOARD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CORNERS = new Set(["nw", "ne", "sw", "se"]);

/** What a card may carry, and how much of it. Anything else is not kept. */
type Field = { kind: "text"; max: number; link?: true } | { kind: "number" } | { kind: "flag" };
const CARD_FIELDS: Record<string, Field> = {
  id: { kind: "text", max: 40 },
  kind: { kind: "text", max: 24 },
  title: { kind: "text", max: 200 },
  body: { kind: "text", max: 4000 },
  url: { kind: "text", max: 2048, link: true },
  thumb: { kind: "text", max: 2048, link: true },
  contentType: { kind: "text", max: 120 },
  x: { kind: "number" },
  y: { kind: "number" },
  flow: { kind: "text", max: 160 },
  state: { kind: "text", max: 16 },
  user: { kind: "flag" },
  taskId: { kind: "text", max: 160 },
  err: { kind: "text", max: 400 },
  // An area (kind "area"): its size, and "Sell this orchestration" (coming soon) —
  // how it would be shared (drops | honey | open), whether what it made may show as
  // examples (yes | no), and when that was chosen.
  w: { kind: "number" },
  h: { kind: "number" },
  share: { kind: "text", max: 16 },
  examples: { kind: "text", max: 8 },
  shareAt: { kind: "text", max: 40 },
  // A drawing (kind "sketch"): its marks, as small vectors (whiteboard.js marksOf).
  drawing: { kind: "text", max: 150_000 },
};

export type WhiteboardCard = Record<string, string | number | boolean>;
export interface WhiteboardLink { id: string; from: string; to: string; fc?: string; tc?: string }
export interface WhiteboardState {
  v: 2;
  cards: WhiteboardCard[];
  links: WhiteboardLink[];
  view: { x: number; y: number; z: number };
  viewSet?: true;
}
export interface StoredWhiteboard { id: string; state: WhiteboardState; rev: number; updatedAt: string }
export interface WhiteboardVersion {
  id: number;
  rev: number;
  cards: number;
  /** A few card titles, newest first. */
  titles: string[];
  reason: "save" | "restore";
  startedAt: string;
  savedAt: string;
}
export type CleanBoard = { ok: true; state: WhiteboardState; bytes: number; cards: number; titles: string };
type Refusal = { ok: false; status: number; code: string; error: string };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Postgres JSON can't hold U+0000 or half of a surrogate pair (a 4000-character cut
// can split an emoji); both would fail the whole save, so they are replaced.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function text(v: unknown, max: number): string {
  return String(v ?? "").split(String.fromCharCode(0)).join("").slice(0, max).replace(LONE_SURROGATE, "�");
}
function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1e7, Math.min(1e7, n));
}
/** A link a card may open or show: http(s), or a path on this site. Anything else is dropped. */
function webLink(s: string): string {
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  if (/^\/(?![/\\])[^\s]*$/.test(s)) return s;
  return "";
}

function cleanCard(raw: unknown): WhiteboardCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: WhiteboardCard = {};
  for (const [key, f] of Object.entries(CARD_FIELDS)) {
    if (!own(r, key) || r[key] === undefined || r[key] === null) continue;
    if (f.kind === "text") out[key] = f.link ? webLink(text(r[key], f.max)) : text(r[key], f.max);
    else if (f.kind === "number") out[key] = num(r[key]);
    else if (r[key] === true) out[key] = true;
  }
  return typeof out.id === "string" && out.id ? out : null;
}

/** The last few titles on the board, newest first: what the history list shows. */
function titlesOf(cards: WhiteboardCard[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = cards.length - 1; i >= 0 && out.length < 3; i--) {
    const t = String(cards[i]!.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join("\n");
}

/** A board the account may keep, or the reason it can't. */
export function cleanWhiteboard(raw: unknown): CleanBoard | Refusal {
  const s = raw as { cards?: unknown; links?: unknown; view?: unknown; viewSet?: unknown } | null;
  if (!s || typeof s !== "object" || Array.isArray(s) || !Array.isArray(s.cards)) {
    return { ok: false, status: 400, code: "bad_board", error: "Send the board as { v: 2, cards: [...], links: [...] }." };
  }
  if (s.cards.length > WHITEBOARD_MAX_CARDS) {
    return { ok: false, status: 413, code: "too_many_cards", error: `A board holds up to ${WHITEBOARD_MAX_CARDS} cards. Remove a few, then it saves again.` };
  }
  const rawLinks = Array.isArray(s.links) ? s.links : [];
  if (rawLinks.length > WHITEBOARD_MAX_LINKS) {
    return { ok: false, status: 413, code: "too_many_links", error: `A board holds up to ${WHITEBOARD_MAX_LINKS} lines. Remove a few, then it saves again.` };
  }
  const cards: WhiteboardCard[] = [];
  const ids = new Set<string>();
  for (const c of s.cards) {
    const card = cleanCard(c);
    if (!card || ids.has(String(card.id))) continue;
    ids.add(String(card.id));
    cards.push(card);
  }
  const links: WhiteboardLink[] = [];
  rawLinks.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const l = raw as Record<string, unknown>;
    const from = text(l.from, 40);
    const to = text(l.to, 40);
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) return;
    const link: WhiteboardLink = { id: text(l.id, 40) || `l${i}`, from, to };
    if (CORNERS.has(String(l.fc))) link.fc = String(l.fc);
    if (CORNERS.has(String(l.tc))) link.tc = String(l.tc);
    links.push(link);
  });
  const v = (s.view && typeof s.view === "object" ? s.view : {}) as Record<string, unknown>;
  const state: WhiteboardState = {
    v: 2,
    cards,
    links,
    view: { x: num(v.x), y: num(v.y), z: Math.max(0.2, Math.min(3, num(v.z) || 1)) },
  };
  if (s.viewSet === true) state.viewSet = true;
  const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
  if (bytes > WHITEBOARD_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "too_big",
      error: `This board is ${(bytes / 1048576).toFixed(1)} MB; a board saved to your account is up to ${WHITEBOARD_MAX_BYTES / 1048576} MB. Remove a few cards, then it saves again.`,
    };
  }
  return { ok: true, state, bytes, cards: cards.length, titles: titlesOf(cards) };
}

function iso(v: unknown): string {
  return v ? new Date(String(v)).toISOString() : "";
}
function stateOf(v: unknown): WhiteboardState {
  return (typeof v === "string" ? JSON.parse(v) : v) as WhiteboardState;
}

/** May this person keep a board under this id? Their own conversation, or "talk". */
export async function ownsBoard(sql: Sql, userId: string, boardId: string): Promise<boolean> {
  if (!BOARD_ID.test(boardId)) return false;
  if (boardId === SCRATCH_BOARD) return true;
  const rows = await sql`SELECT 1 FROM buzzy_sessions WHERE id = ${boardId} AND user_id = ${userId} LIMIT 1`;
  return rows.length > 0;
}

export async function getWhiteboard(sql: Sql, userId: string, boardId: string): Promise<StoredWhiteboard | null> {
  const rows = await sql`
    SELECT state, rev, updated_at FROM buzzy_whiteboards
    WHERE user_id = ${userId} AND session_id = ${boardId}
    LIMIT 1`;
  const r = rows[0];
  return r ? { id: boardId, state: stateOf(r.state), rev: Number(r.rev), updatedAt: iso(r.updated_at) } : null;
}

/**
 * Keep this save in the history, then trim the history to its limits. Two saves of
 * one board can finish out of order; the history never steps back to the older one.
 */
export async function recordVersion(
  sql: Sql,
  userId: string,
  boardId: string,
  rev: number,
  json: string,
  board: CleanBoard,
  reason: "save" | "restore",
): Promise<void> {
  if (reason === "save") {
    // A blank save never rolls into an entry that had cards: emptying the board is how
    // a new visit starts, and the drawing has to stay here to be gone back to. (Two
    // blank saves in a row still share one entry.)
    const merged = await sql`
      UPDATE buzzy_whiteboard_versions
      SET state = ${json}::jsonb, rev = ${rev}::int, card_count = ${board.cards}::int, bytes = ${board.bytes}::int,
          titles = ${board.titles}::text, saved_at = now()
      WHERE id = (SELECT id FROM buzzy_whiteboard_versions
                  WHERE user_id = ${userId} AND session_id = ${boardId}
                  ORDER BY id DESC LIMIT 1)
        AND reason = 'save'
        AND rev < ${rev}::int
        AND started_at > now() - ${VERSION_WINDOW_MINUTES}::int * interval '1 minute'
        AND NOT (${board.cards}::int = 0 AND card_count > 0)
      RETURNING id`;
    if (merged.length) return;
  }
  const made = await sql`
    INSERT INTO buzzy_whiteboard_versions (user_id, session_id, rev, state, card_count, bytes, titles, reason)
    SELECT ${userId}::text, ${boardId}::text, ${rev}::int, ${json}::jsonb, ${board.cards}::int, ${board.bytes}::int,
           ${board.titles}::text, ${reason}::text
    WHERE NOT EXISTS (SELECT 1 FROM buzzy_whiteboard_versions
                      WHERE user_id = ${userId} AND session_id = ${boardId} AND rev >= ${rev}::int)
    RETURNING id`;
  if (!made.length) return;          // a later save is in the history already
  await sql`
    DELETE FROM buzzy_whiteboard_versions
    WHERE user_id = ${userId} AND session_id = ${boardId}
      AND (saved_at < now() - ${VERSIONS_MAX_DAYS}::int * interval '1 day'
           OR id NOT IN (SELECT id FROM buzzy_whiteboard_versions
                         WHERE user_id = ${userId} AND session_id = ${boardId}
                         ORDER BY id DESC LIMIT ${VERSIONS_KEPT}))`;
}

/**
 * Save a board that was opened at `baseRev` (null: it was never in the account).
 * Refused with the account's copy when another computer saved since.
 */
export async function saveWhiteboard(
  sql: Sql,
  userId: string,
  boardId: string,
  board: CleanBoard,
  baseRev: number | null,
): Promise<{ ok: true; rev: number; updatedAt: string } | { ok: false; board: StoredWhiteboard }> {
  const json = JSON.stringify(board.state);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (baseRev !== null) {
      const moved = await sql`
        UPDATE buzzy_whiteboards
        SET state = ${json}::jsonb, rev = rev + 1, card_count = ${board.cards}, bytes = ${board.bytes}, updated_at = now()
        WHERE user_id = ${userId} AND session_id = ${boardId} AND rev = ${baseRev}
        RETURNING rev, updated_at`;
      if (moved.length) {
        const rev = Number(moved[0]!.rev);
        await recordVersion(sql, userId, boardId, rev, json, board, "save");
        return { ok: true, rev, updatedAt: iso(moved[0]!.updated_at) };
      }
    }
    // Not in the account (yet, or any more): this save creates it.
    const made = await sql`
      INSERT INTO buzzy_whiteboards (user_id, session_id, state, rev, card_count, bytes)
      VALUES (${userId}, ${boardId}, ${json}::jsonb, 1, ${board.cards}, ${board.bytes})
      ON CONFLICT (user_id, session_id) DO NOTHING
      RETURNING rev, updated_at`;
    if (made.length) {
      await recordVersion(sql, userId, boardId, 1, json, board, "save");
      return { ok: true, rev: 1, updatedAt: iso(made[0]!.updated_at) };
    }
    // Another computer saved first: hand its copy back to merge with.
    const current = await getWhiteboard(sql, userId, boardId);
    if (current) return { ok: false, board: current };
    // Removed between the two statements: try again.
  }
  throw new Error("whiteboard save kept racing");
}

export async function listWhiteboardVersions(sql: Sql, userId: string, boardId: string): Promise<WhiteboardVersion[]> {
  const rows = await sql`
    SELECT id, rev, card_count, titles, reason, started_at, saved_at
    FROM buzzy_whiteboard_versions
    WHERE user_id = ${userId} AND session_id = ${boardId}
      AND saved_at > now() - ${VERSIONS_MAX_DAYS}::int * interval '1 day'
    ORDER BY id DESC
    LIMIT ${VERSIONS_KEPT}`;
  return rows.map((r) => ({
    id: Number(r.id),
    rev: Number(r.rev),
    cards: Number(r.card_count),
    titles: String(r.titles ?? "").split("\n").filter(Boolean),
    reason: r.reason === "restore" ? "restore" : "save",
    startedAt: iso(r.started_at),
    savedAt: iso(r.saved_at),
  }));
}

/**
 * Go back to an earlier entry: the board becomes that entry, whatever it holds now.
 * The board as it was stays in the history (it is the entry before this one).
 */
export async function restoreWhiteboardVersion(
  sql: Sql,
  userId: string,
  boardId: string,
  versionId: number,
): Promise<StoredWhiteboard | null> {
  const rows = await sql`
    SELECT state FROM buzzy_whiteboard_versions
    WHERE id = ${versionId} AND user_id = ${userId} AND session_id = ${boardId}
      AND saved_at > now() - ${VERSIONS_MAX_DAYS}::int * interval '1 day'
    LIMIT 1`;
  if (!rows.length) return null;
  const checked = cleanWhiteboard(stateOf(rows[0]!.state));
  if (!checked.ok) return null;
  const json = JSON.stringify(checked.state);
  const saved = await sql`
    INSERT INTO buzzy_whiteboards (user_id, session_id, state, rev, card_count, bytes)
    VALUES (${userId}, ${boardId}, ${json}::jsonb, 1, ${checked.cards}, ${checked.bytes})
    ON CONFLICT (user_id, session_id) DO UPDATE
      SET state = EXCLUDED.state, rev = buzzy_whiteboards.rev + 1, card_count = EXCLUDED.card_count,
          bytes = EXCLUDED.bytes, updated_at = now()
    RETURNING rev, updated_at`;
  const rev = Number(saved[0]!.rev);
  await recordVersion(sql, userId, boardId, rev, json, checked, "restore");
  return { id: boardId, state: checked.state, rev, updatedAt: iso(saved[0]!.updated_at) };
}

export interface WhiteboardReply { status: number; body: Record<string, unknown> }
const reply = (status: number, body: Record<string, unknown>): WhiteboardReply => ({ status, body });
const notYours = () =>
  reply(404, { ok: false, error: "That conversation isn't on your account, so its board stays on this computer.", code: "not_your_conversation" });

/**
 * A short code for the signed-in account, on every answer. The browser notes which
 * account each local copy was saved to, so on a shared computer one person's unsaved
 * board is never sent into another person's account. One-way: it names no one.
 */
export function whoOf(userId: string): string {
  return createHash("sha256").update("bz-whiteboard:" + userId).digest("hex").slice(0, 16);
}

/**
 * /api/buzzy/whiteboards/<id>… for a signed-in person (chat.nitro.ts checks the
 * session and reads the body; `rest` is the path after /api/buzzy/whiteboards/).
 *
 *   GET  <id>                          the board, or null when the account has none
 *   PUT  <id>                          { state, baseRev } → { rev } (409 + the account's
 *                                      copy when another computer saved since baseRev)
 *   GET  <id>/versions                 the history, newest first
 *   POST <id>/versions/<vid>/restore   go back to that entry → { board }
 *
 * Every answer carries `who` (whoOf).
 */
export async function whiteboardRoute(
  sql: Sql,
  userId: string,
  method: string,
  rest: string,
  body: unknown,
): Promise<WhiteboardReply> {
  const out = await answer(sql, userId, method, rest, body);
  out.body.who = whoOf(userId);
  return out;
}

async function answer(
  sql: Sql,
  userId: string,
  method: string,
  rest: string,
  body: unknown,
): Promise<WhiteboardReply> {
  const parts = rest.split("/");
  let boardId = "";
  try { boardId = decodeURIComponent(parts[0] ?? ""); } catch { boardId = ""; }
  if (!BOARD_ID.test(boardId)) return reply(404, { ok: false, error: "There is no board with that name.", code: "not_found" });

  if (parts.length === 1) {
    if (method === "GET") return reply(200, { ok: true, board: await getWhiteboard(sql, userId, boardId) });
    if (method !== "PUT") return reply(405, { ok: false, error: "Use GET or PUT.", code: "method_not_allowed" });
    if (!(await ownsBoard(sql, userId, boardId))) return notYours();
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const checked = cleanWhiteboard(b.state);
    if (!checked.ok) return reply(checked.status, { ok: false, error: checked.error, code: checked.code });
    const baseRev = b.baseRev === undefined || b.baseRev === null ? null : Number(b.baseRev);
    if (baseRev !== null && !(Number.isInteger(baseRev) && baseRev >= 0)) {
      return reply(400, { ok: false, error: "baseRev is the board's revision number, or null for a new board.", code: "bad_rev" });
    }
    const saved = await saveWhiteboard(sql, userId, boardId, checked, baseRev);
    if (!saved.ok) {
      return reply(409, {
        ok: false,
        code: "conflict",
        error: "This board was changed on another computer. Merge the two, then save again.",
        board: saved.board,
      });
    }
    return reply(200, { ok: true, rev: saved.rev, updatedAt: saved.updatedAt });
  }

  if (parts[1] === "versions" && parts.length === 2) {
    if (method !== "GET") return reply(405, { ok: false, error: "Use GET.", code: "method_not_allowed" });
    return reply(200, {
      ok: true,
      versions: await listWhiteboardVersions(sql, userId, boardId),
      keeps: { entries: VERSIONS_KEPT, days: VERSIONS_MAX_DAYS },
    });
  }

  if (parts[1] === "versions" && parts.length === 4 && parts[3] === "restore") {
    if (method !== "POST") return reply(405, { ok: false, error: "Use POST.", code: "method_not_allowed" });
    if (!/^\d{1,15}$/.test(parts[2] ?? "")) return reply(404, { ok: false, error: "There is no such version.", code: "not_found" });
    if (!(await ownsBoard(sql, userId, boardId))) return notYours();
    const board = await restoreWhiteboardVersion(sql, userId, boardId, Number(parts[2]));
    if (!board) return reply(404, { ok: false, error: "That version is no longer in this board's history.", code: "version_gone" });
    return reply(200, { ok: true, board });
  }

  return reply(404, { ok: false, error: "There is no such board page.", code: "not_found" });
}
