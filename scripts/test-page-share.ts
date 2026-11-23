/**
 * Sharing a page: only after the person says yes (owner, 2026-11-21).
 *
 *   "When you use a QR code or copy a page link, you have to be given a prompt… everything
 *    on this page… becomes available. Give people a little pop-up to say yes and confirm
 *    before they do that. And it should say, to anyone with a link or searching it via the
 *    internet. A sub option that's small that says block searches by default. Should be a
 *    tickable option."
 *
 * Part 1 — the logic, on an in-memory database with every migration:
 *   - nothing is made without `confirm: true`; a blank page has nothing to share;
 *   - "Block searches" is on unless the request says `searchBlocked: false`, and while it is
 *     on the public page carries the noindex header AND the noindex meta tag; unticked it
 *     says index, follow;
 *   - a copy holds exactly what the window listed: board cards and the conversation, as text.
 *     Never private paths of ours, thumbnails, drawings, the "sell" settings, ids, system
 *     messages, other people's rows; everything from the person is escaped; only web links
 *     are links;
 *   - sharing again keeps the address and refreshes the copy; turning off empties the copy,
 *     the address says "turned off" (410), and a later share is a new address;
 *   - only the person's own conversation and links; Advocate, Lockdown and the desktop app
 *     refuse; 20 live links at most; a page too big to read is refused;
 *   - deleting the account deletes the copies.
 * Part 2 — the real handler (pageShare.nitro.ts) with a real sign-in: 401 signed out, the
 *   public address needs no cookie and sets none, crawler headers on every answer.
 *
 * Run: npx tsx scripts/test-page-share.ts   (wired into test:ci)
 */
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { H3 } from "h3";
import * as wb from "../src/lib/buzzy/whiteboards";
import {
  MAX_LIVE_SHARES, MAX_SNAPSHOT_BYTES, NOT_INCLUDED, TOKEN_RE,
  pageShareRoute, publicHeaders, readPublicPage, renderSharedPage,
} from "../src/lib/buzzy/pageShare";
import { deleteAccountData, DELETION_STATEMENTS } from "../src/lib/buzzy/portability";
import type { Sql } from "../src/lib/db";

let pass = 0;
let fail = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};

// ── Part 1: an in-memory database, every migration ───────────────────────
const db = new PGlite();
const dir = join(process.cwd(), "migrations");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
  try { await db.exec(readFileSync(join(dir, f), "utf8")); }
  catch (e) { console.error(`migration ${f} failed: ${(e as Error).message}`); process.exit(1); }
}
const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  let text = "";
  strings.forEach((s, i) => { text += s + (i < values.length ? "$" + (i + 1) : ""); });
  return db.query(text, values).then((r) => r.rows);
}) as unknown as Sql;
(sql as unknown as { query: unknown }).query = (text: string, params?: unknown[]) => db.query(text, params ?? []).then((r) => r.rows);

const card = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "note", title: id, body: "", url: "", contentType: "", x: 0, y: 0, ...extra });
const saveBoard = async (user: string, boardId: string, cards: Record<string, unknown>[], links: Record<string, unknown>[] = []) => {
  const clean = wb.cleanWhiteboard({ v: 2, cards, links, view: { x: 0, y: 0, z: 1 } });
  assert.ok(clean.ok, "board cleans");
  const existing = await wb.getWhiteboard(sql, user, boardId);
  const saved = await wb.saveWhiteboard(sql, user, boardId, clean as wb.CleanBoard, existing ? existing.rev : null);
  assert.ok(saved.ok, "board saved");
};
const session = (id: string, user: string, title = "New session") => db.query("INSERT INTO buzzy_sessions (id, user_id, title) VALUES ($1, $2, $3)", [id, user, title]);
let tick = 0;
const say = (sessionId: string, user: string, role: string, content: string) =>
  db.query("INSERT INTO buzzy_chat_messages (user_id, session_id, role, content, created_at) VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)", [user, sessionId, role, content, String(tick++)]);
const route = (user: string, method: string, rest: string, body?: unknown, query = "", env: Record<string, string | undefined> = {}) =>
  pageShareRoute(sql, user, method, rest, new URLSearchParams(query), body, env);
const mode = (user: string, m: string) => db.query("INSERT INTO buzzy_privacy_mode (user_id, mode) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode", [user, m]);
const shares = async (user: string) => (await db.query("SELECT * FROM buzzy_page_shares WHERE user_id = $1 ORDER BY created_at", [user])).rows as Array<Record<string, unknown>>;
const tokenOf = (url: unknown) => String(url).replace("/buzzy/p/", "");

console.log("\nSharing a page — the logic\n");

await ok("a blank page has nothing to share, and nothing is made", async () => {
  const r = await route("u1", "GET", "preview", undefined, "board=talk");
  assert.equal(r.status, 200);
  assert.equal(r.body.canShare, false);
  assert.equal(r.body.code, "nothing_to_share");
  const post = await route("u1", "POST", "", { board: "talk", confirm: true });
  assert.equal(post.status, 409);
  assert.equal((await shares("u1")).length, 0);
});

// A conversation with a messy board: private pictures, a drawing, the "sell" settings.
await session("sess_a1", "u1", "Bakery launch");
await say("sess_a1", "u1", "user", "Plan my bakery launch");
await say("sess_a1", "u1", "system", "SECRET system prompt text");
await say("sess_a1", "u1", "assistant", "Here is a plan. <b>Start</b> with the menu.");
await saveBoard("u1", "sess_a1", [
  card("c-low", { title: "Lower down", body: "second", x: 10, y: 400 }),
  card("c-top", { title: "Menu ideas", body: "Sourdough & rye", url: "https://example.com/menu", x: 0, y: 0 }),
  card("c-pic", { kind: "image", title: "Shop front photo", url: "/api/buzzy/assets/9", thumb: "/api/buzzy/assets/9?thumb=1", y: 200 }),
  card("c-sketch", { kind: "sketch", title: "My sketch", drawing: '[{"p":[1,2,3]}]', y: 250 }),
  card("c-area", { kind: "area", title: "The launch", w: 300, h: 200, share: "honey", examples: "yes", shareAt: "2026-11-20T10:00:00Z", y: 300 }),
], [{ id: "l1", from: "c-top", to: "c-low" }, { id: "l2", from: "c-top", to: "c-pic" }]);

await ok("the preview says what a link would show, and what it leaves out", async () => {
  const r = await route("u1", "GET", "preview", undefined, "board=sess_a1");
  assert.equal(r.body.canShare, true);
  assert.deepEqual(r.body.includes, [
    { key: "board", label: "Your Idea Board", detail: "5 cards and 2 lines between them" },
    { key: "conversation", label: "This conversation", detail: "2 messages" },
  ]);
  assert.deepEqual(r.body.notIncluded, NOT_INCLUDED);
  assert.equal(r.body.active, null);
  assert.equal((await shares("u1")).length, 0, "a preview makes nothing");
});

await ok("nothing is shared without the confirmation", async () => {
  for (const body of [{ board: "sess_a1" }, { board: "sess_a1", confirm: "yes" }, { board: "sess_a1", confirm: 1 }, null, "x"]) {
    const r = await route("u1", "POST", "", body);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "confirm_needed");
  }
  assert.equal((await shares("u1")).length, 0);
});

let first: { id: string; url: string };
await ok("Yes makes a link; Block searches is on unless it is unticked", async () => {
  const r = await route("u1", "POST", "", { board: "sess_a1", confirm: true });
  assert.equal(r.status, 201);
  const s = r.body.share as { id: string; url: string; searchBlocked: boolean; title: string };
  assert.equal(s.searchBlocked, true, "no searchBlocked in the request → blocked");
  assert.match(s.url, /^\/buzzy\/p\/ps_[A-Za-z0-9_-]{43}$/);
  assert.ok(TOKEN_RE.test(tokenOf(s.url)));
  assert.equal(s.title, "Bakery launch");
  first = s;
  const rows = await shares("u1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.search_blocked, true);
  // Anything but an explicit false keeps searches blocked.
  for (const v of ["false", 0, null, "no"]) {
    const again = await route("u1", "POST", "", { board: "sess_a1", confirm: true, searchBlocked: v });
    assert.equal((again.body.share as { searchBlocked: boolean }).searchBlocked, true, `searchBlocked ${JSON.stringify(v)} still blocks`);
  }
});

await ok("the public page needs no sign-in and tells search engines to keep out", async () => {
  const page = await readPublicPage(sql, tokenOf(first.url));
  assert.equal(page.status, 200);
  assert.equal(page.searchBlocked, true);
  assert.match(page.html, /<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">/);
  const h = publicHeaders(page.status, page.searchBlocked);
  assert.equal(h["x-robots-tag"], "noindex, nofollow, noarchive, nosnippet");
  assert.equal(h["cache-control"], "private, no-store");
  assert.match(h["content-security-policy"]!, /default-src 'none'/);
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["referrer-policy"], "no-referrer");
});

await ok("the copy holds the cards and the conversation, as text, and nothing else", async () => {
  const { html } = await readPublicPage(sql, tokenOf(first.url));
  for (const must of ["Bakery launch", "Menu ideas", "Sourdough &amp; rye", "Lower down", "Shop front photo", "My sketch", "The launch", "Plan my bakery launch", "Here is a plan."]) {
    assert.ok(html.includes(must), `shows ${must}`);
  }
  assert.ok(html.includes('href="https://example.com/menu"'), "a web link stays a link");
  assert.ok(html.includes('rel="nofollow ugc noopener noreferrer"'), "and is not vouched for");
  for (const never of ["/api/buzzy/", "thumb=1", '"p":', "honey", "SECRET system prompt", "u1", "sess_a1", "c-top", "shareAt", "examples", "w\":"]) {
    assert.ok(!html.includes(never), `the page never carries ${never}`);
  }
  assert.ok(!/<script/i.test(html), "no script at all");
  // Reading order: top to bottom (the card placed lowest on the board comes last).
  const at = (t: string) => html.indexOf(`<h3>${t}</h3>`);
  assert.ok(at("Menu ideas") >= 0 && at("Menu ideas") < at("Shop front photo"), "top card first");
  assert.ok(at("Shop front photo") < at("Lower down"), "lowest card last");
  assert.ok(html.includes("Leads to: Lower down, Shop front photo") || html.includes("Leads to: Shop front photo, Lower down"), "the lines between cards read as 'Leads to'");
});

await ok("what a person wrote can't break the page or smuggle a link", async () => {
  await saveBoard("u1", "sess_a1", [
    card("x1", { title: '<img src=x onerror=alert(1)>', body: '"><script>alert(2)</script>', url: "javascript:alert(3)" }),
    card("x2", { title: "Fine", url: "https://example.com/a?b=1&c=<x>" }),
  ]);
  const r = await route("u1", "POST", "", { board: "sess_a1", confirm: true });
  assert.equal(r.status, 200);
  const { html } = await readPublicPage(sql, tokenOf((r.body.share as { url: string }).url));
  assert.ok(!html.includes("<img"), "markup in a title is text");
  assert.ok(!html.includes("<script"), "markup in a note is text");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!/href="javascript:/i.test(html), "javascript: is not a link");
  assert.ok(!html.includes("javascript:alert(3)"), "and is not shown as one either");
  assert.ok(!html.includes("<x>"));
});

await ok("sharing again keeps the address and refreshes the copy; unticking says index, follow", async () => {
  const before = await shares("u1");
  const r = await route("u1", "POST", "", { board: "sess_a1", confirm: true, searchBlocked: false });
  assert.equal(r.status, 200, "an update, not a new link");
  assert.equal((r.body as { created: boolean }).created, false);
  const s = r.body.share as { url: string; searchBlocked: boolean };
  assert.equal(s.url, first.url, "same address, so a printed QR code keeps working");
  assert.equal(s.searchBlocked, false);
  assert.equal((await shares("u1")).length, before.length, "still one live link");
  const page = await readPublicPage(sql, tokenOf(s.url));
  assert.equal(page.searchBlocked, false);
  assert.match(page.html, /<meta name="robots" content="index, follow">/);
  assert.ok(!/noindex/.test(page.html));
  const h = publicHeaders(page.status, page.searchBlocked);
  assert.equal(h["x-robots-tag"], "index, follow");
  assert.equal(h["cache-control"], "public, max-age=60");
  // and the tick can go back on
  const back = await route("u1", "POST", "", { board: "sess_a1", confirm: true, searchBlocked: true });
  assert.equal((back.body.share as { searchBlocked: boolean }).searchBlocked, true);
  assert.equal((await readPublicPage(sql, tokenOf(s.url))).searchBlocked, true);
});

await ok("later changes stay private until the person updates", async () => {
  await saveBoard("u1", "sess_a1", [card("late", { title: "Added after sharing" })]);
  assert.ok(!(await readPublicPage(sql, tokenOf(first.url))).html.includes("Added after sharing"));
  await route("u1", "POST", "", { board: "sess_a1", confirm: true });
  assert.ok((await readPublicPage(sql, tokenOf(first.url))).html.includes("Added after sharing"));
});

await ok("the preview shows the live link for this board", async () => {
  const r = await route("u1", "GET", "preview", undefined, "board=sess_a1");
  const a = r.body.active as { id: string; url: string };
  assert.equal(a.id, first.id);
  assert.equal(a.url, first.url);
});

await ok("nobody else can share, see or turn off a person's page", async () => {
  const theirs = await route("u2", "POST", "", { board: "sess_a1", confirm: true });
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.code, "not_your_conversation");
  const peek = await route("u2", "GET", "preview", undefined, "board=sess_a1");
  assert.equal(peek.body.canShare, false);
  assert.equal(peek.body.active, null, "another account never learns there is a link");
  const off = await route("u2", "DELETE", first.id);
  assert.equal(off.body.revoked, false);
  assert.equal((await readPublicPage(sql, tokenOf(first.url))).status, 200, "still on");
});

await ok("Advocate, Lockdown and the desktop app refuse, in plain words; Open shares", async () => {
  await session("sess_m1", "u3");
  await say("sess_m1", "u3", "user", "hello");
  assert.equal((await route("u3", "GET", "preview", undefined, "board=sess_m1")).body.canShare, true, "no choice made yet: the website's default, Open");
  await mode("u3", "advocate");
  let r = await route("u3", "GET", "preview", undefined, "board=sess_m1");
  assert.equal(r.body.canShare, false);
  assert.equal(r.body.code, "privacy_advocate");
  assert.match(String(r.body.message), /nothing is published/);
  assert.match(String(r.body.message), /Switch to Open/);
  r = await route("u3", "POST", "", { board: "sess_m1", confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "privacy_advocate");
  await mode("u3", "lockdown");
  r = await route("u3", "POST", "", { board: "sess_m1", confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "privacy_lockdown");
  assert.match(String(r.body.error), /nothing leaves BeeZilla/);
  assert.equal((await shares("u3")).length, 0, "nothing was made");
  await mode("u3", "open");
  r = await route("u3", "POST", "", { board: "sess_m1", confirm: true });
  assert.equal(r.status, 201);
  const local = await route("u3", "POST", "", { board: "sess_m1", confirm: true }, "", { BZ_RUNTIME: "local" });
  assert.equal(local.status, 409);
  assert.equal(local.body.code, "not_available_here");
});

await ok("Messages: only what was said, only this conversation, the latest 200", async () => {
  await session("sess_big", "u4");
  for (let i = 0; i < 205; i++) await say("sess_big", "u4", i % 2 ? "assistant" : "user", `message ${i}`);
  await session("sess_other", "u4");
  await say("sess_other", "u4", "user", "a different conversation");
  const r = await route("u4", "POST", "", { board: "sess_big", confirm: true });
  const inc = r.body.includes as Array<{ key: string; detail: string }>;
  assert.equal(inc.find((l) => l.key === "conversation")!.detail, "200 messages (the latest 200)");
  const { html } = await readPublicPage(sql, tokenOf((r.body.share as { url: string }).url));
  assert.ok(html.includes("message 204") && html.includes("message 5") && !html.includes("message 4<"), "the latest 200");
  assert.ok(!html.includes("a different conversation"));
  assert.ok(html.includes("the latest 200 messages"));
});

await ok("the board in front of a new conversation ('talk') can be shared without a conversation", async () => {
  await saveBoard("u5", "talk", [card("t1", { title: "Loose idea", body: "just a note" })]);
  const r = await route("u5", "POST", "", { board: "talk", confirm: true });
  assert.equal(r.status, 201);
  const { html } = await readPublicPage(sql, tokenOf((r.body.share as { url: string }).url));
  assert.ok(html.includes("Loose idea"));
  assert.ok(html.includes("<h1>Idea Board</h1>"));
  assert.ok(!html.includes("Conversation"));
});

await ok("a page too big to read is refused", async () => {
  await session("sess_huge", "u6");
  const cards = Array.from({ length: 160 }, (_, i) => card("h" + i, { title: "t" + i, body: "x".repeat(4000), y: i }));
  await db.query("INSERT INTO buzzy_whiteboards (user_id, session_id, state) VALUES ($1, $2, $3::jsonb)", ["u6", "sess_huge", JSON.stringify({ v: 2, cards, links: [], view: { x: 0, y: 0, z: 1 } })]);
  assert.ok(160 * 4000 > MAX_SNAPSHOT_BYTES);
  const r = await route("u6", "POST", "", { board: "sess_huge", confirm: true });
  assert.equal(r.status, 413);
  assert.equal(r.body.code, "too_big");
  assert.equal((await shares("u6")).length, 0);
});

await ok("at most 20 live links; updating one at the limit still works", async () => {
  for (let i = 0; i < MAX_LIVE_SHARES; i++) {
    await session("sess_cap" + i, "u7");
    await say("sess_cap" + i, "u7", "user", "hello " + i);
    const r = await route("u7", "POST", "", { board: "sess_cap" + i, confirm: true });
    assert.equal(r.status, 201, `link ${i + 1}`);
  }
  await session("sess_cap_over", "u7");
  await say("sess_cap_over", "u7", "user", "one too many");
  const over = await route("u7", "POST", "", { board: "sess_cap_over", confirm: true });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "too_many_shares");
  assert.equal((await route("u7", "POST", "", { board: "sess_cap0", confirm: true })).status, 200);
});

let offId = "";
let offToken = "";
await ok("turning a link off empties the copy; the address says so; sharing again is a new address", async () => {
  await session("sess_off", "u8");
  await say("sess_off", "u8", "user", "private thoughts");
  const made = await route("u8", "POST", "", { board: "sess_off", confirm: true, searchBlocked: false });
  offId = (made.body.share as { id: string }).id;
  offToken = tokenOf((made.body.share as { url: string }).url);
  assert.equal((await readPublicPage(sql, offToken)).status, 200);
  const off = await route("u8", "DELETE", offId);
  assert.deepEqual([off.status, off.body.revoked], [200, true]);
  const gone = await readPublicPage(sql, offToken);
  assert.equal(gone.status, 410);
  assert.ok(!gone.html.includes("private thoughts"));
  assert.match(gone.html, /<meta name="robots" content="noindex/);
  const h = publicHeaders(gone.status, gone.searchBlocked);
  assert.equal(h["x-robots-tag"], "noindex, nofollow, noarchive, nosnippet", "a turned-off page that WAS indexable is never offered to search engines");
  const row = (await db.query("SELECT snapshot, bytes, revoked_at FROM buzzy_page_shares WHERE id = $1", [offId])).rows[0] as { snapshot: unknown; bytes: number; revoked_at: unknown };
  assert.deepEqual(row.snapshot, {});
  assert.equal(row.bytes, 0);
  assert.ok(row.revoked_at);
  assert.equal((await route("u8", "DELETE", offId)).body.revoked, false, "turning off twice is harmless");
  assert.equal((await route("u8", "GET", "preview", undefined, "board=sess_off")).body.active, null);
  const again = await route("u8", "POST", "", { board: "sess_off", confirm: true });
  assert.equal(again.status, 201);
  assert.notEqual(tokenOf((again.body.share as { url: string }).url), offToken, "a new address; the old one stays off");
  assert.equal((await readPublicPage(sql, offToken)).status, 410);
});

await ok("a wrong or unknown address is a 404 that keeps search engines out", async () => {
  for (const bad of ["", "nope", "ps_short", "ps_" + "A".repeat(43), "ps_" + "A".repeat(44), "../../etc/passwd", "ps_" + "!".repeat(43)]) {
    const r = await readPublicPage(sql, bad);
    assert.equal(r.status, 404, `"${bad}"`);
    assert.equal(publicHeaders(r.status, r.searchBlocked)["x-robots-tag"], "noindex, nofollow, noarchive, nosnippet");
  }
});

await ok("a copy that was damaged is never shown", async () => {
  await db.query("UPDATE buzzy_page_shares SET snapshot = '{\"v\":2}'::jsonb WHERE id = $1", [first.id]);
  assert.equal((await readPublicPage(sql, tokenOf(first.url))).status, 410);
});

await ok("a bad request can't make a mess: odd board names fall back to the blank board", async () => {
  for (const b of ["../x", "a b", "x".repeat(200), 5, null, undefined]) {
    const r = await route("u9", "POST", "", { board: b, confirm: true });
    assert.ok([409, 404].includes(r.status), `board ${JSON.stringify(b)} → ${r.status}`);
  }
  assert.equal((await route("u9", "PATCH", "", {})).status, 405);
  assert.equal((await route("u9", "GET", "", undefined)).status, 405);
  assert.equal((await route("u9", "DELETE", "preview")).status, 405, "preview is GET only");
  assert.equal((await route("u9", "DELETE", "pgs_nothere")).status, 404);
  assert.equal((await shares("u9")).length, 0);
});

await ok("deleting the account deletes the copies", async () => {
  assert.ok(DELETION_STATEMENTS["buzzy_page_shares"], "the table is in the deletion list");
  const before = (await shares("u1")).length;
  assert.ok(before > 0);
  const receipt = await deleteAccountData(sql, "u1");
  assert.equal(receipt["buzzy_page_shares"], before);
  assert.equal((await shares("u1")).length, 0);
  assert.equal((await readPublicPage(sql, tokenOf(first.url))).status, 404, "and the address stops existing");
});

await ok("the page can be drawn on its own", () => {
  const html = renderSharedPage({ v: 1, title: "T", sharedAt: "2026-11-21T10:00:00Z", cards: [], lines: 0, messages: [{ who: "Owner", text: "hi", at: "" }], messagesCut: false }, true);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("Shared on 21 November 2026"));
});

// ── Part 2: the real handler, a real sign-in ─────────────────────────────
console.log("\nSharing a page — the real handler\n");
const { handleAuthRequest } = await import("../src/lib/auth/server");
const { latestDevMailFor } = await import("../src/lib/mailer");
const { getSessionUserFromHeaders } = await import("../src/lib/auth/verify.server");
const { getSql } = await import("../src/lib/db");
const handler = (await import("../src/lib/buzzy/pageShare.nitro")).default;
const ORIGIN = "http://127.0.0.1:8090";
const app = new H3();
app.all("/**", handler);
const ask = async (path: string, opts: { cookie?: string; method?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = { host: "127.0.0.1:8090" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(new Request(ORIGIN + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const email = `page-share-${Date.now()}@example.com`;
const send = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
  method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, accept: "application/json" },
  body: JSON.stringify({ email, callbackURL: "/buzzy/talk" }),
}));
assert.ok(send.ok, `magic link send: ${send.status}`);
const link = latestDevMailFor(email)?.actionUrl;
assert.ok(link, "magic link captured in the dev inbox");
const verify = await handleAuthRequest(new Request(link!, { headers: { accept: "text/html" } }));
const cookie = verify.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => /session_token=./.test(c) || /session_data=./.test(c)).join("; ");
assert.ok(/session_token=/.test(cookie), "the link signs in");
const me = await getSessionUserFromHeaders(new Headers({ cookie }));
assert.ok(me?.id, "a real user");
const realSql = await getSql();

await ok("signed out: nothing can be asked, made or turned off", async () => {
  for (const [method, path, body] of [
    ["GET", "/api/buzzy/page-shares/preview?board=talk", undefined],
    ["POST", "/api/buzzy/page-shares", { board: "talk", confirm: true }],
    ["DELETE", "/api/buzzy/page-shares/pgs_0123456789abcdef", undefined],
  ] as const) {
    const r = await ask(path, { method, body });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(JSON.parse(r.text).code, "signed_out");
  }
});

await ok("signed in: preview, confirm, share, read with no cookie, turn off", async () => {
  const board = wb.cleanWhiteboard({ v: 2, cards: [card("k1", { title: "Real card", body: "hello from the handler" })], links: [], view: { x: 0, y: 0, z: 1 } });
  assert.ok(board.ok);
  await wb.saveWhiteboard(realSql, me!.id, "talk", board as wb.CleanBoard, null);

  const pre = await ask("/api/buzzy/page-shares/preview?board=talk", { cookie });
  assert.equal(pre.status, 200);
  assert.equal(JSON.parse(pre.text).canShare, true);

  const refused = await ask("/api/buzzy/page-shares", { cookie, method: "POST", body: { board: "talk" } });
  assert.equal(refused.status, 400);
  assert.equal(JSON.parse(refused.text).code, "confirm_needed");

  const made = await ask("/api/buzzy/page-shares", { cookie, method: "POST", body: { board: "talk", confirm: true } });
  assert.equal(made.status, 201);
  const share = JSON.parse(made.text).share as { id: string; url: string; searchBlocked: boolean };
  assert.equal(share.searchBlocked, true);

  // Anyone: no cookie.
  const pub = await ask(share.url);
  assert.equal(pub.status, 200);
  assert.ok(pub.text.includes("hello from the handler"));
  assert.equal(pub.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
  assert.match(pub.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(pub.headers.get("set-cookie"), null, "a visitor is never given a cookie");
  assert.match(pub.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const head = await ask(share.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal(head.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
  assert.equal((await ask(share.url, { method: "POST", body: {} })).status, 405);

  // Unticked, through the real handler.
  const open = await ask("/api/buzzy/page-shares", { cookie, method: "POST", body: { board: "talk", confirm: true, searchBlocked: false } });
  assert.equal(open.status, 200);
  const pub2 = await ask(share.url);
  assert.equal(pub2.headers.get("x-robots-tag"), "index, follow");
  assert.match(pub2.text, /<meta name="robots" content="index, follow">/);

  const off = await ask("/api/buzzy/page-shares/" + share.id, { cookie, method: "DELETE" });
  assert.equal(JSON.parse(off.text).revoked, true);
  const gone = await ask(share.url);
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
  assert.ok(!gone.text.includes("hello from the handler"));
});

await ok("an address that was never shared is a 404 with the crawler headers, trailing slash or not", async () => {
  for (const p of ["/buzzy/p/ps_" + "B".repeat(43), "/buzzy/p/ps_" + "B".repeat(43) + "/", "/buzzy/p/nonsense"]) {
    const r = await ask(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
  }
});

await ok("/robots.txt does not shut /buzzy/p/ out, so a crawler can read its noindex", () => {
  const robots = readFileSync(join(process.cwd(), "public/robots.txt"), "utf8");
  const disallowed = robots.split("\n").filter((l) => /^disallow:/i.test(l.trim())).map((l) => l.split(":")[1]!.trim());
  assert.ok(!disallowed.some((d) => d && "/buzzy/p/x".startsWith(d)), `robots.txt disallows ${disallowed.join(", ")}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
