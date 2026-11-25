/**
 * Sharing a page — only after the person says yes.
 *
 * Owner, 2026-11-21: "When you use a QR code or copy a page link, you have to be given a
 * prompt to say, first you have to know that you're going to open this up… everything on
 * this page… becomes available. Make sure that's clear. Give people a little pop-up to say
 * yes and confirm before they do that. And it should say, to anyone with a link or
 * searching it via the internet. A sub option that's small that says block searches by
 * default. Should be a tickable option."
 *
 * What was wrong underneath: the QR code and Copy page link handed out the page's own
 * address, which opens nothing for anyone else (every page asks for a sign-in), so there
 * was nothing to confirm and nothing for "block searches" to block. Now:
 *
 *   GET    /api/buzzy/page-shares/preview?board=<id>   what a link WOULD show, and the live
 *                                                      link for this board, if there is one
 *   POST   /api/buzzy/page-shares                      { board, searchBlocked, confirm:true }
 *                                                      → makes or updates the link. Without
 *                                                      `confirm: true` nothing is made.
 *   DELETE /api/buzzy/page-shares/<id>                 turns it off and empties the copy
 *   GET    /buzzy/p/<token>                            the public page (pageShare.nitro.ts)
 *
 * What a link shows is a COPY made at the moment of confirming, built here from the
 * person's own rows (never from what the browser sends): the cards on the Idea Board in
 * front of them and the conversation beside it, as text. Nothing is read from their account
 * when someone opens the link, so what is public is what the window listed; later changes
 * stay private until they choose Update. Left out, and said so in the window: pictures,
 * music, 3D models, files and drawings (only their names show), the Memory and the Library,
 * and anything about the account.
 *
 * The "Block searches" tick is on unless the request says `searchBlocked: false`. While it
 * is on the page is served `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and says
 * so in a robots meta tag too; a crawler can read both because /robots.txt does not shut
 * /buzzy/p/ out. Unticked, the page says `index, follow`.
 *
 * Privacy modes keep their word: only Open shares. Advocate ("nothing is published") and
 * Lockdown ("nothing extra leaves BeeZilla") refuse and say how to switch. The desktop app
 * has no public address, so it refuses too.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import { getWhiteboard, ownsBoard, SCRATCH_BOARD } from "./whiteboards";

/** Live links one person may hold at once: a public host is not free storage. */
export const MAX_LIVE_SHARES = 20;
/** One copy, as JSON. A full board is about 700 KB; this keeps the page to what reads well. */
export const MAX_SNAPSHOT_BYTES = 600_000;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 6000;
const MAX_CARDS = 400;
const BOARD_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const TOKEN_RE = /^ps_[A-Za-z0-9_-]{43}$/;

export interface SharedCard {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** A web address (http or https) the card points at. Never a private path of ours. */
  url: string;
  /** Titles of the cards this one leads to. */
  to: string[];
}
export interface SharedMessage { who: "Owner" | "BeeZilla"; text: string; at: string }
export interface PageSnapshot {
  v: 1;
  title: string;
  sharedAt: string;
  cards: SharedCard[];
  lines: number;
  messages: SharedMessage[];
  /** More messages existed than the copy keeps (the latest MAX_MESSAGES are kept). */
  messagesCut: boolean;
}
export interface IncludeLine { key: "board" | "conversation"; label: string; detail: string }

/** Said in the window, word for word, and held true by test-page-share.ts. */
export const NOT_INCLUDED = [
  "pictures, music, 3D models, files and drawings (only their names show)",
  "your Memory and your Library",
  "your account details",
];

export interface Reply { status: number; body: Record<string, unknown> }
const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });

// ── making the copy ──────────────────────────────────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function clip(v: unknown, max: number): string {
  return String(v ?? "").split(String.fromCharCode(0)).join("").slice(0, max).replace(LONE_SURROGATE, "�");
}
/** Only a web address survives as a link; a path on this site is somebody's private file. */
function outsideLink(v: unknown): string {
  const s = clip(v, 2048).trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : "";
}
const n = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

export function includesOf(s: PageSnapshot): IncludeLine[] {
  const out: IncludeLine[] = [];
  if (s.cards.length) {
    out.push({
      key: "board",
      label: "Your Idea Board",
      detail: n(s.cards.length, "card") + (s.lines ? ` and ${n(s.lines, "line")} between them` : ""),
    });
  }
  if (s.messages.length) {
    out.push({
      key: "conversation",
      label: "This conversation",
      detail: n(s.messages.length, "message") + (s.messagesCut ? " (the latest " + MAX_MESSAGES + ")" : ""),
    });
  }
  return out;
}

type Built = { ok: true; snapshot: PageSnapshot } | { ok: false; status: number; code: string; error: string };

/** The copy of what is in front of this person, from their own rows. */
export async function buildSnapshot(sql: Sql, userId: string, boardId: string, now = new Date()): Promise<Built> {
  if (!BOARD_ID.test(boardId) || !(await ownsBoard(sql, userId, boardId))) {
    return { ok: false, status: 404, code: "not_your_conversation", error: "That conversation isn't on your account, so there is nothing of it to share." };
  }
  const stored = await getWhiteboard(sql, userId, boardId);
  const raw = stored?.state?.cards ?? [];
  const lines = stored?.state?.links ?? [];
  const titleOf = new Map<string, string>();
  for (const c of raw) titleOf.set(String(c.id), clip(c.title, 200));
  const cards: SharedCard[] = raw.slice(0, MAX_CARDS)
    .map((c) => {
      const id = String(c.id);
      const to = [...new Set(lines.filter((l) => l.from === id).map((l) => titleOf.get(String(l.to)) || "").filter(Boolean))].slice(0, 20);
      return {
        id,
        kind: clip(c.kind, 24) || "note",
        title: clip(c.title, 200),
        body: clip(c.body, 4000),
        url: outsideLink(c.url),
        to,
        // Reading order for the page: top to bottom, left to right (x/y are the board's).
        y: Number(c.y) || 0,
        x: Number(c.x) || 0,
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ x: _x, y: _y, ...rest }) => rest);

  let messages: SharedMessage[] = [];
  let messagesCut = false;
  let convoTitle = "";
  if (boardId !== SCRATCH_BOARD) {
    const t = await sql<{ title: string | null }>`SELECT title FROM buzzy_sessions WHERE id = ${boardId} AND user_id = ${userId} LIMIT 1`;
    convoTitle = clip(t[0]?.title, 120).trim();
    const rows = await sql<{ role: string; content: string; created_at: unknown }>`
      SELECT role, content, created_at FROM buzzy_chat_messages
      WHERE user_id = ${userId} AND session_id = ${boardId} AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, id DESC
      LIMIT ${MAX_MESSAGES + 1}`;
    messagesCut = rows.length > MAX_MESSAGES;
    messages = rows.slice(0, MAX_MESSAGES).reverse().map((r) => ({
      who: r.role === "user" ? "Owner" : "BeeZilla",
      text: clip(r.content, MAX_MESSAGE_CHARS),
      at: r.created_at ? new Date(String(r.created_at)).toISOString() : "",
    }));
  }

  if (!cards.length && !messages.length) {
    return { ok: false, status: 409, code: "nothing_to_share", error: "There is nothing on this page to share yet. Put something on the Idea Board or start a conversation first." };
  }
  // The conversation's own name, unless it is still the placeholder.
  let title = convoTitle && !/^new session$/i.test(convoTitle) ? convoTitle : "";
  if (!title) {
    const first = messages.find((m) => m.who === "Owner")?.text.replace(/\s+/g, " ").trim().slice(0, 80);
    title = first || "Idea Board";
  }
  const snapshot: PageSnapshot = { v: 1, title, sharedAt: now.toISOString(), cards, lines: lines.length, messages, messagesCut };
  if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_BYTES) {
    return { ok: false, status: 413, code: "too_big", error: "This page is too big to share as one page. Share a smaller board, or start a new conversation for the part you want to share." };
  }
  return { ok: true, snapshot };
}

// ── who may share, and where ─────────────────────────────────────────────

type Gate = { ok: true } | { ok: false; code: string; error: string };
/** Open shares; the desktop app has no public address; Advocate and Lockdown keep their word. */
export async function mayShare(sql: Sql, userId: string, env: Record<string, string | undefined> = process.env): Promise<Gate> {
  const local = (env.BZ_RUNTIME ?? "").trim().toLowerCase() === "local";
  if (local) {
    return { ok: false, code: "not_available_here", error: "Sharing a page works on beezilla.net. The desktop app has no public address to share from." };
  }
  const rows = await sql<{ mode: string }>`SELECT mode FROM buzzy_privacy_mode WHERE user_id = ${userId} LIMIT 1`;
  const mode = rows[0]?.mode ?? "open";
  if (mode === "advocate") {
    return { ok: false, code: "privacy_advocate", error: "Privacy is set to Advocate, so nothing is published. Switch to Open (the privacy button on the Talk bar) if you want to share this page." };
  }
  if (mode === "lockdown") {
    return { ok: false, code: "privacy_lockdown", error: "Privacy is set to Lockdown, so nothing leaves BeeZilla. Switch to Open (the privacy button on the Talk bar) if you want to share this page." };
  }
  return { ok: true };
}

// ── the person's own side: preview, share, turn off ──────────────────────

interface Row { id: string; token: string; search_blocked: boolean; created_at: unknown; updated_at: unknown; title: string; board_id: string }
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : "");
const shareOf = (r: Row) => ({
  id: r.id,
  /** A path on this site; the page that asked adds its own origin. */
  url: "/buzzy/p/" + r.token,
  title: r.title,
  searchBlocked: r.search_blocked === true,
  sharedAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

async function liveFor(sql: Sql, userId: string, boardId: string): Promise<Row | null> {
  const rows = await sql<Row>`
    SELECT id, token, search_blocked, created_at, updated_at, title, board_id FROM buzzy_page_shares
    WHERE user_id = ${userId} AND board_id = ${boardId} AND revoked_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

function boardOf(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return BOARD_ID.test(s) ? s : SCRATCH_BOARD;
}

/**
 * /api/buzzy/page-shares… for a signed-in person (pageShare.nitro.ts checks the session;
 * `rest` is the path after /api/buzzy/page-shares, without a leading slash).
 */
export async function pageShareRoute(
  sql: Sql,
  userId: string,
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<Reply> {
  if (rest === "preview") {
    if (method !== "GET") return reply(405, { ok: false, error: "Use GET.", code: "method_not_allowed" });
    const boardId = boardOf(query.get("board"));
    const live = await liveFor(sql, userId, boardId);
    const gate = await mayShare(sql, userId, env);
    if (!gate.ok) return reply(200, { ok: true, canShare: false, code: gate.code, message: gate.error, active: live ? shareOf(live) : null });
    const built = await buildSnapshot(sql, userId, boardId);
    if (!built.ok) return reply(200, { ok: true, canShare: false, code: built.code, message: built.error, active: live ? shareOf(live) : null });
    return reply(200, {
      ok: true,
      canShare: true,
      includes: includesOf(built.snapshot),
      notIncluded: NOT_INCLUDED,
      active: live ? shareOf(live) : null,
    });
  }

  if (rest === "") {
    if (method !== "POST") return reply(405, { ok: false, error: "Use POST.", code: "method_not_allowed" });
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    // The window's "Yes" is the only thing that sends this. A request without it is a
    // client that skipped the question, and nothing is made.
    if (b.confirm !== true) {
      return reply(400, { ok: false, error: "Nothing is shared until you confirm.", code: "confirm_needed" });
    }
    const boardId = boardOf(b.board);
    const searchBlocked = b.searchBlocked !== false;
    const gate = await mayShare(sql, userId, env);
    if (!gate.ok) return reply(409, { ok: false, error: gate.error, code: gate.code });
    const live = await liveFor(sql, userId, boardId);
    if (!live) {
      const count = await sql<{ n: string | number }>`SELECT count(*) AS n FROM buzzy_page_shares WHERE user_id = ${userId} AND revoked_at IS NULL`;
      if (Number(count[0]?.n ?? 0) >= MAX_LIVE_SHARES) {
        return reply(429, { ok: false, error: `You already have ${MAX_LIVE_SHARES} pages shared. Turn one off first.`, code: "too_many_shares" });
      }
    }
    const built = await buildSnapshot(sql, userId, boardId);
    if (!built.ok) return reply(built.status, { ok: false, error: built.error, code: built.code });
    const json = JSON.stringify(built.snapshot);
    const token = "ps_" + randomBytes(32).toString("base64url");
    const id = "pgs_" + randomBytes(8).toString("hex");
    // One live link per person and board: a second share updates it and keeps its address.
    const rows = await sql<Row & { created: boolean }>`
      INSERT INTO buzzy_page_shares (id, user_id, board_id, token, title, search_blocked, snapshot, bytes)
      VALUES (${id}, ${userId}, ${boardId}, ${token}, ${built.snapshot.title}, ${searchBlocked}, ${json}::jsonb, ${json.length})
      ON CONFLICT (user_id, board_id) WHERE revoked_at IS NULL DO UPDATE
        SET title = EXCLUDED.title, search_blocked = EXCLUDED.search_blocked,
            snapshot = EXCLUDED.snapshot, bytes = EXCLUDED.bytes, updated_at = now()
      RETURNING id, token, search_blocked, created_at, updated_at, title, board_id, (xmax = 0) AS created`;
    const row = rows[0]!;
    return reply(row.created ? 201 : 200, {
      ok: true,
      created: row.created === true,
      share: shareOf(row),
      includes: includesOf(built.snapshot),
      notIncluded: NOT_INCLUDED,
    });
  }

  if (method === "DELETE" && /^pgs_[a-f0-9]{16}$/.test(rest)) {
    // Turned off AND emptied: the copy does not outlive the link.
    const rows = await sql<{ id: string }>`
      UPDATE buzzy_page_shares SET revoked_at = now(), snapshot = '{}'::jsonb, bytes = 0
      WHERE id = ${rest} AND user_id = ${userId} AND revoked_at IS NULL RETURNING id`;
    return reply(200, { ok: true, revoked: rows.length > 0 });
  }

  return reply(404, { ok: false, error: "There is no such page share.", code: "not_found" });
}

// ── the public page ──────────────────────────────────────────────────────

export interface PublicRead {
  status: 200 | 404 | 410;
  searchBlocked: boolean;
  html: string;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function when(v: string): string {
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const STYLE = `
:root{color-scheme:dark light;--bg:#0E0E0E;--panel:#151515;--line:#262626;--text:#F2F2F2;--muted:#A3A3A3;--accent:#FFC107;--me:#1E1E1E}
@media (prefers-color-scheme:light){:root{--bg:#FAFAF7;--panel:#FFFFFF;--line:#E2E2DC;--text:#1A1A1A;--muted:#5C5C5C;--accent:#8A6D00;--me:#F1F1EA}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
.top{max-width:820px;margin:0 auto;padding:1.1rem 16px 0;display:flex;align-items:center;justify-content:space-between;gap:1rem;color:var(--muted);font-size:.85rem}
.brand{display:inline-flex;align-items:center;gap:.45rem;color:var(--text);font-weight:700;text-decoration:none}
.dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--accent)}
.badge{border:1px solid var(--line);border-radius:999px;padding:.15rem .65rem;color:var(--accent);font-weight:600}
main{max-width:820px;margin:0 auto;padding:1rem 16px 3rem}
h1{margin:.4rem 0 .2rem;font-size:1.8rem;line-height:1.2}
h2{margin:2rem 0 .6rem;font-size:1rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.meta{margin:0 0 1rem;color:var(--muted);font-size:.9rem}
.cards{list-style:none;margin:0;padding:0;display:grid;gap:.7rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.8rem 1rem}
.kind{display:inline-block;margin:0 0 .25rem;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:700}
.card h3{margin:0 0 .2rem;font-size:1.05rem}
.card p{margin:.3rem 0 0;white-space:pre-wrap}
.card a{color:var(--accent)}
.to{margin:.5rem 0 0;font-size:.85rem;color:var(--muted)}
.chat{display:grid;gap:.6rem}
.msg{border:1px solid var(--line);border-radius:12px;padding:.6rem .9rem;background:var(--panel)}
.msg.me{background:var(--me)}
.who{margin:0 0 .15rem;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700}
.msg p{margin:0;white-space:pre-wrap}
.note{margin:2rem 0 0;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
.state{padding:3rem 0;text-align:center;color:var(--muted)}
.state strong{display:block;margin-bottom:.4rem;color:var(--text);font-size:1.2rem}
`.replace(/\n/g, "");

function shell(title: string, searchBlocked: boolean, inner: string): string {
  const robots = searchBlocked ? "noindex, nofollow, noarchive, nosnippet" : "index, follow";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="robots" content="${robots}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<title>${esc(title)} · shared from BeeZilla</title>` +
    `<style>${STYLE}</style></head><body>` +
    '<div class="top"><a class="brand" href="/"><span class="dot" aria-hidden="true"></span>BeeZilla</a><span class="badge">Shared · read only</span></div>' +
    `<main>${inner}</main></body></html>`
  );
}

/** A shared page as HTML. Every word from the person goes through esc(); links are web addresses only. */
export function renderSharedPage(s: PageSnapshot, searchBlocked: boolean): string {
  const cards = s.cards.map((c) =>
    '<li class="card">' +
    `<span class="kind">${esc(c.kind)}</span>` +
    (c.title ? `<h3>${esc(c.title)}</h3>` : "") +
    (c.body ? `<p>${esc(c.body)}</p>` : "") +
    (c.url ? `<p><a href="${esc(c.url)}" target="_blank" rel="nofollow ugc noopener noreferrer">${esc(c.url)}</a></p>` : "") +
    (c.to.length ? `<p class="to">Leads to: ${c.to.map(esc).join(", ")}</p>` : "") +
    "</li>",
  ).join("");
  const chat = s.messages.map((m) =>
    `<div class="msg${m.who === "Owner" ? " me" : ""}"><p class="who">${m.who}</p><p>${esc(m.text)}</p></div>`,
  ).join("");
  const date = when(s.sharedAt);
  const inner =
    `<h1>${esc(s.title)}</h1>` +
    `<p class="meta">Shared${date ? " on " + esc(date) : ""}. This is a copy of the owner's page as it was then; anything changed since is not shown here.</p>` +
    (cards ? `<h2>Idea Board</h2><ul class="cards">${cards}</ul>` : "") +
    (chat ? `<h2>Conversation${s.messagesCut ? " (the latest " + MAX_MESSAGES + " messages)" : ""}</h2><div class="chat">${chat}</div>` : "") +
    `<p class="note">${esc(NOT_INCLUDED_PUBLIC)} BeeZilla did not write or check what is on this page.</p>`;
  return shell(s.title, searchBlocked, inner);
}
const NOT_INCLUDED_PUBLIC = "Pictures, music, 3D models, files and drawings are not part of this copy.";

function gonePage(status: 404 | 410): string {
  return shell(
    status === 410 ? "Turned off" : "Not found",
    true,
    status === 410
      ? '<div class="state"><strong>This page was turned off.</strong>Its owner stopped sharing it.</div>'
      : '<div class="state"><strong>There is nothing here.</strong>This link is wrong, or the page was never shared.</div>',
  );
}

/** What anyone with the link gets. No sign-in; the token is the only key. */
export async function readPublicPage(sql: Sql, token: string): Promise<PublicRead> {
  if (!TOKEN_RE.test(token)) return { status: 404, searchBlocked: true, html: gonePage(404) };
  const rows = await sql<{ snapshot: unknown; search_blocked: boolean; revoked_at: unknown }>`
    SELECT snapshot, search_blocked, revoked_at FROM buzzy_page_shares WHERE token = ${token} LIMIT 1`;
  const r = rows[0];
  if (!r) return { status: 404, searchBlocked: true, html: gonePage(404) };
  if (r.revoked_at) return { status: 410, searchBlocked: true, html: gonePage(410) };
  const snap = (typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot) as PageSnapshot;
  if (!snap || snap.v !== 1 || !Array.isArray(snap.cards) || !Array.isArray(snap.messages)) {
    return { status: 410, searchBlocked: true, html: gonePage(410) };
  }
  const blocked = r.search_blocked !== false;
  return { status: 200, searchBlocked: blocked, html: renderSharedPage(snap, blocked) };
}

/** The headers that tell a crawler what to do, and keep the page from being framed or leaked on. */
export function publicHeaders(status: number, searchBlocked: boolean): Record<string, string> {
  const blocked = searchBlocked || status !== 200;
  return {
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": blocked ? "noindex, nofollow, noarchive, nosnippet" : "index, follow",
    "cache-control": blocked ? "private, no-store" : "public, max-age=60",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}
