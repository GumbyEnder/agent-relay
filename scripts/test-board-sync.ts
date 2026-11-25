/**
 * The whiteboard follows the person (2026-11-18): saved to their account, merged when
 * two computers change it, kept on the computer while offline, with a history.
 *
 *   - The account keeps one board per person and conversation; only the person's own
 *     conversations (or "talk") can have one, and only they can read it.
 *   - A save from an old revision is refused with the account's copy, never applied.
 *   - Boards are cleaned and capped (1 MB, 400 cards); only web links survive.
 *   - History: saves within five minutes share an entry; going back always starts a
 *     new one and keeps the board you left; at most 30 entries, none past 90 days.
 *   - The browser code (public/buzzy/whiteboard.js) runs here too, in two sandboxes —
 *     two computers, each with its own localStorage — against the real route logic:
 *     an older board moves up, the other computer gets it, offline edits wait and
 *     then arrive, two computers' changes merge card by card, the board in front of a
 *     new conversation joins it without drawing a step twice, a shared computer never
 *     mixes two people's boards, a late upload lands on its own card, going back keeps
 *     what was drawn meanwhile, and failing saves wait longer each time.
 *   - History covers the settings gear's corner, never the reverse.
 *
 * Hermetic: every migration on an in-memory PGlite and a local HTTP stand-in.
 *   npx tsx scripts/test-board-sync.ts
 */
import { PGlite } from "@electric-sql/pglite";
import http from "node:http";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import * as wb from "../src/lib/buzzy/whiteboards";
import { deleteAccountData, DELETION_STATEMENTS } from "../src/lib/buzzy/portability";
import type { Sql } from "../src/lib/db";

let pass = 0;
let fail = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

type Card = Record<string, unknown> & { id: string };
type Board = { v?: number; cards: Card[]; links: Array<Record<string, unknown>>; view?: unknown; sync?: { rev: number | null; dirty: boolean; base: unknown; off?: boolean } };
const card = (id: string, extra: Record<string, unknown> = {}): Card =>
  ({ id, kind: "note", title: id, body: "", url: "", contentType: "", x: 0, y: 0, ...extra });
const board = (cards: Card[], links: Array<Record<string, unknown>> = []) => ({ v: 2, cards, links, view: { x: 0, y: 0, z: 1 } });

(async () => {
  // ── The database: every migration, in order ────────────────────────────
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
  for (const [id, user] of [["sess_a1", "u1"], ["sess_a2", "u1"], ["sess_a3", "u1"], ["sess_b1", "u2"], ["sess_c6", "u6"]]) {
    await db.query("INSERT INTO buzzy_sessions (id, user_id) VALUES ($1, $2)", [id, user]);
  }
  const route = (user: string, method: string, rest: string, body?: unknown) => wb.whiteboardRoute(sql, user, method, rest, body);
  const versions = async (user: string, id: string) => (await route(user, "GET", `${id}/versions`)).body.versions as wb.WhiteboardVersion[];

  console.log("\nThe whiteboard in the account — the route\n");

  await ok("a conversation starts with no board, then saving creates it at revision 1", async () => {
    const empty = await route("u1", "GET", "sess_a1");
    eq([empty.status, empty.body.ok, empty.body.board], [200, true, null]);
    const r = await route("u1", "PUT", "sess_a1", { state: board([card("a"), card("b")], [{ id: "l1", from: "a", to: "b" }]), baseRev: null });
    eq(r.status, 200);
    eq(r.body.rev, 1);
    const got = (await route("u1", "GET", "sess_a1")).body.board as wb.StoredWhiteboard;
    eq(got.rev, 1);
    eq(got.state.cards.map((c) => c.id), ["a", "b"]);
    eq(got.state.links.length, 1);
  });
  await ok("a save names the revision it started from; an old one is refused with the account's copy", async () => {
    const r = await route("u1", "PUT", "sess_a1", { state: board([card("a"), card("b"), card("c")]), baseRev: 1 });
    eq(r.body.rev, 2);
    const stale = await route("u1", "PUT", "sess_a1", { state: board([card("z")]), baseRev: 1 });
    eq(stale.status, 409);
    eq(stale.body.code, "conflict");
    const theirs = stale.body.board as wb.StoredWhiteboard;
    eq(theirs.rev, 2);
    eq(theirs.state.cards.map((c) => c.id), ["a", "b", "c"], "the account's copy came back");
    eq(((await route("u1", "GET", "sess_a1")).body.board as wb.StoredWhiteboard).state.cards.length, 3, "nothing overwritten");
    const blind = await route("u1", "PUT", "sess_a1", { state: board([card("z")]), baseRev: null });
    eq(blind.status, 409, "a 'new board' save onto an existing one is refused too");
  });
  await ok("only the person's own conversations can have a board; 'talk' is everyone's own scratch board", async () => {
    const theirs = await route("u2", "PUT", "sess_a1", { state: board([card("x")]), baseRev: null });
    eq(theirs.status, 404);
    eq(theirs.body.code, "not_your_conversation");
    const made = await route("u1", "PUT", "sess_nope", { state: board([card("x")]), baseRev: null });
    eq(made.status, 404, "a conversation that doesn't exist");
    eq((await route("u2", "PUT", "talk", { state: board([card("u2-scratch")]), baseRev: null })).status, 200);
    eq((await route("u1", "PUT", "talk", { state: board([card("u1-scratch")]), baseRev: null })).status, 200);
    const t1 = (await route("u1", "GET", "talk")).body.board as wb.StoredWhiteboard;
    eq(t1.state.cards.map((c) => c.id), ["u1-scratch"], "each person has their own 'talk'");
  });
  await ok("nobody else can read a board, its history, or bring a version back", async () => {
    eq((await route("u2", "GET", "sess_a1")).body.board, null);
    eq((await versions("u2", "sess_a1")).length, 0);
    const mine = await versions("u1", "sess_a1");
    truthy(mine.length >= 1, "u1 has history");
    const r = await route("u2", "POST", `sess_a1/versions/${mine[0]!.id}/restore`);
    eq(r.status, 404);
    const sideways = await route("u2", "POST", `sess_b1/versions/${mine[0]!.id}/restore`);
    eq(sideways.status, 404, "a version id from someone else's board, under one's own conversation");
  });
  await ok("every answer names the account by a short one-way code, the same each time", async () => {
    const a = (await route("u1", "GET", "sess_a1")).body.who;
    const b = (await route("u1", "PUT", "sess_nope", { state: board([]) })).body.who;
    const c = (await route("u2", "GET", "sess_a1")).body.who;
    truthy(typeof a === "string" && /^[0-9a-f]{16}$/.test(String(a)), String(a));
    eq(a, b, "same account, same code");
    truthy(a !== c, "another account, another code");
    truthy(!String(a).includes("u1"), "it names no one");
  });
  await ok("odd names and methods are refused plainly", async () => {
    eq((await route("u1", "GET", "../etc")).status, 404);
    eq((await route("u1", "GET", "a%2Fb")).status, 404);
    eq((await route("u1", "GET", "x".repeat(81))).status, 404);
    eq((await route("u1", "DELETE", "sess_a1")).status, 405);
    eq((await route("u1", "PUT", "sess_a1/versions")).status, 405);
    eq((await route("u1", "GET", "sess_a1/versions/1/restore")).status, 405);
    eq((await route("u1", "POST", "sess_a1/versions/abc/restore")).status, 404);
    eq((await route("u1", "PUT", "sess_a1", { state: { cards: "no" } })).status, 400);
    eq((await route("u1", "PUT", "sess_a1", { state: board([card("a")]), baseRev: -1 })).status, 400);
  });
  await ok("a board over 1 MB, or over 400 cards, is refused with a plain reason", async () => {
    const big = board(Array.from({ length: 300 }, (_, i) => card("c" + i, { body: "x".repeat(4000) })));
    const r = await route("u1", "PUT", "sess_a2", { state: big, baseRev: null });
    eq(r.status, 413);
    eq(r.body.code, "too_big");
    truthy(/1 MB/.test(String(r.body.error)), String(r.body.error));
    const many = await route("u1", "PUT", "sess_a2", { state: board(Array.from({ length: 401 }, (_, i) => card("n" + i))), baseRev: null });
    eq(many.status, 413);
    eq(many.body.code, "too_many_cards");
    eq((await route("u1", "GET", "sess_a2")).body.board, null, "nothing was kept");
  });
  await ok("what a card carries is cleaned: web links only, no stray fields, no broken text", async () => {
    const dirty = board([
      card("j", { url: "javascript:alert(1)", thumb: "data:image/png;base64,AAAA", secret: "kept?", title: "a\u0000b" }),
      card("w", { url: "https://example.com/x.png", thumb: "/api/buzzy/assets/7", body: "half an emoji \uD83D" }),
      card("p", { url: "//evil.example/x", user: true, x: Infinity, y: "12" }),
      card("q", { url: "/\\evil.example" }),
    ], [{ id: "l", from: "j", to: "w" }, { id: "dangling", from: "j", to: "ghost" }, { id: "self", from: "w", to: "w" }]);
    const r = await route("u1", "PUT", "sess_a3", { state: dirty, baseRev: null });
    eq(r.status, 200);
    const got = ((await route("u1", "GET", "sess_a3")).body.board as wb.StoredWhiteboard).state;
    const [j, w, p, q] = got.cards;
    eq(j!.url, "");
    eq(j!.thumb, "");
    eq(j!.secret, undefined, "unknown fields are not kept");
    eq(j!.title, "ab");
    eq(w!.url, "https://example.com/x.png");
    eq(w!.thumb, "/api/buzzy/assets/7");
    eq(w!.body, "half an emoji �");
    eq(p!.url, "");
    eq(p!.user, true);
    eq([p!.x, p!.y], [0, 12]);
    eq(q!.url, "");
    eq(got.links.map((l) => l.id), ["l"], "lines to missing cards, or to themselves, are dropped");
  });

  console.log("\nHistory\n");

  await ok("saves within five minutes share one entry; a later save starts a new one", async () => {
    const before = (await versions("u1", "sess_a1")).length;
    await route("u1", "PUT", "sess_a1", { state: board([card("a"), card("b"), card("c"), card("d")]), baseRev: 2 });
    eq((await versions("u1", "sess_a1")).length, before, "merged into the newest entry");
    const newest = (await versions("u1", "sess_a1"))[0]!;
    eq(newest.rev, 3);
    eq(newest.cards, 4);
    eq(newest.titles, ["d", "c", "b"], "the last few titles, newest first");
    await db.query("UPDATE buzzy_whiteboard_versions SET started_at = now() - interval '6 minutes', saved_at = now() - interval '6 minutes' WHERE user_id = 'u1' AND session_id = 'sess_a1'");
    await route("u1", "PUT", "sess_a1", { state: board([card("a")]), baseRev: 3 });
    const list = await versions("u1", "sess_a1");
    eq(list.length, before + 1);
    eq(list.map((v) => v.cards).slice(0, 2), [1, 4], "newest first");
  });
  await ok("going back brings an earlier version back, and the board you left stays in the history", async () => {
    const list = await versions("u1", "sess_a1");
    const four = list.find((v) => v.cards === 4)!;
    const r = await route("u1", "POST", `sess_a1/versions/${four.id}/restore`);
    eq(r.status, 200);
    const b = r.body.board as wb.StoredWhiteboard;
    eq(b.state.cards.map((c) => c.id), ["a", "b", "c", "d"]);
    eq(b.rev, 5);
    const after = await versions("u1", "sess_a1");
    eq(after[0]!.reason, "restore");
    eq(after[0]!.cards, 4);
    truthy(after.some((v) => v.cards === 1 && v.reason === "save"), "the one-card board you left is still there");
    // A save right after going back starts its own entry instead of rewriting the restore.
    await route("u1", "PUT", "sess_a1", { state: board([card("a"), card("b"), card("c"), card("d"), card("e")]), baseRev: 5 });
    const again = await versions("u1", "sess_a1");
    eq([again[0]!.reason, again[1]!.reason], ["save", "restore"]);
  });
  await ok("two saves that finish out of order never step the history back", async () => {
    const latest = (await versions("u1", "sess_a1"))[0]!;
    const late = wb.cleanWhiteboard(board([card("stale")]));
    if (!late.ok) throw new Error("clean");
    await wb.recordVersion(sql, "u1", "sess_a1", latest.rev - 1, JSON.stringify(late.state), late, "save");
    const after = (await versions("u1", "sess_a1"))[0]!;
    eq([after.id, after.rev, after.cards], [latest.id, latest.rev, latest.cards], "the newest entry is untouched");
    eq((await versions("u1", "sess_a1")).length, (await versions("u1", "sess_a1")).length);
    const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buzzy_whiteboard_versions WHERE user_id = 'u1' AND session_id = 'sess_a1' AND titles = 'stale'");
    eq(n.rows[0]!.n, 0, "and no entry was added for it");
  });
  await ok("at most 30 entries are kept, and none older than 90 days", async () => {
    let rev = ((await route("u1", "GET", "sess_a1")).body.board as wb.StoredWhiteboard).rev;
    for (let i = 0; i < 35; i++) {
      await db.query("UPDATE buzzy_whiteboard_versions SET started_at = now() - interval '10 minutes' WHERE user_id = 'u1' AND session_id = 'sess_a1'");
      const r = await route("u1", "PUT", "sess_a1", { state: board([card("k" + i)]), baseRev: rev });
      rev = Number(r.body.rev);
    }
    const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buzzy_whiteboard_versions WHERE user_id = 'u1' AND session_id = 'sess_a1'");
    eq(n.rows[0]!.n, 30);
    eq((await versions("u1", "sess_a1")).length, 30);
    const oldest = (await versions("u1", "sess_a1")).at(-1)!;
    await db.query("UPDATE buzzy_whiteboard_versions SET saved_at = now() - interval '91 days' WHERE id = $1", [oldest.id]);
    eq((await versions("u1", "sess_a1")).length, 29, "past 90 days it is no longer listed");
    eq((await route("u1", "POST", `sess_a1/versions/${oldest.id}/restore`)).status, 404, "or brought back");
    await db.query("UPDATE buzzy_whiteboard_versions SET started_at = now() - interval '10 minutes' WHERE user_id = 'u1' AND session_id = 'sess_a1'");
    await route("u1", "PUT", "sess_a1", { state: board([card("last")]), baseRev: rev });
    const left = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM buzzy_whiteboard_versions WHERE id = $1", [oldest.id]);
    eq(left.rows[0]!.n, 0, "and the next save clears it out");
  });
  await ok("closing an account removes its boards and their history, and no one else's", async () => {
    const tables = ["buzzy_whiteboard_versions", "buzzy_whiteboards"];
    const order = Object.keys(DELETION_STATEMENTS);
    for (const t of tables) truthy(DELETION_STATEMENTS[t], `${t} is not removed with the account`);
    truthy(order.indexOf("buzzy_whiteboard_versions") < order.indexOf("buzzy_whiteboards"), "the history goes first");
    for (const who of ["u3", "u4"]) {
      eq((await route(who, "PUT", "talk", { state: board([card("bye-" + who)]), baseRev: null })).status, 200, who);
    }
    const count = async (t: string, who: string) =>
      (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [who])).rows[0]!.n;
    const othersBefore = await Promise.all(tables.map((t) => count(t, "u1")));
    const receipt = await deleteAccountData(sql, "u3");
    eq([receipt.buzzy_whiteboard_versions, receipt.buzzy_whiteboards], [1, 1], "the receipt counts them");
    for (const t of tables) {
      eq(await count(t, "u3"), 0, `${t} left behind:`);
      eq(await count(t, "u4"), 1, `${t} someone else's rows:`);
    }
    eq(await Promise.all(tables.map((t) => count(t, "u1"))), othersBefore, "and u1's untouched");
    eq((await route("u3", "GET", "talk")).body.board, null);
  });

  // ── Two computers, running the real browser code ───────────────────────
  console.log("\nTwo computers — public/buzzy/whiteboard.js against the route\n");

  const trouble = { failSaves: false };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const user = String(req.headers["x-test-user"] || "");
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!user) return send(401, { ok: false, code: "signed_out" });
    if (trouble.failSaves && req.method === "PUT") return send(500, { ok: false, error: "boom" });
    const path = new URL(req.url || "/", "http://x").pathname;
    const prefix = "/api/buzzy/whiteboards/";
    if (!path.startsWith(prefix)) return send(404, { ok: false });
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { return send(400, { ok: false, code: "bad_json" }); }
    const out = await wb.whiteboardRoute(sql, user, String(req.method), path.slice(prefix.length), body);
    send(out.status, out.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = readFileSync(join(process.cwd(), "public/buzzy/whiteboard.js"), "utf8");
  const HOOK = "  window.BeeZillaWhiteboard = {";
  if (!page.includes(HOOK)) throw new Error("whiteboard.js no longer ends with window.BeeZillaWhiteboard = {");
  // For the test only: a handle on the inner engine (the page exposes none of this).
  const code = page.replace(HOOK, "  window.__test = { engine: engine, patchCard: patchCard, restoreVersion: restoreVersion };\n" + HOOK);

  type Engine = { backoff: number; status: string; off: boolean };
  type Inner = {
    engine(id: string): Engine;
    patchCard(board: string, card: string, fields: Record<string, unknown>): void;
    restoreVersion(e: Engine, versionId: number): Promise<{ ok: boolean; error?: string }>;
  };
  type Api = {
    sync(id: string): Promise<unknown>;
    carry(from: string, to: string): Promise<unknown>;
    sweep(gap?: number): Promise<number>;
    reset(id: string): Promise<unknown>;
    merge(b: unknown, m: unknown, t: unknown): { cards: Card[]; links: Array<Record<string, unknown>> };
    instructionsFor(id: string): string;
  };
  function computer(user: string | null, shared?: Map<string, string>) {
    const store = shared ?? new Map<string, string>();
    const net = { online: true, calls: [] as string[], during: null as null | ((call: string) => void | Promise<void>), user };
    const sandbox: Record<string, unknown> = {
      console,
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
      },
      // Timers are the page's to run; here retries and debounces never fire on their own.
      setTimeout: () => 0,
      clearTimeout: () => {},
      fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        net.calls.push(`${init.method || "GET"} ${url}`);
        if (!net.online) return Promise.reject(new TypeError("Failed to fetch"));
        const waited = net.during ? net.during(`${init.method || "GET"} ${url}`) : undefined;
        return Promise.resolve(waited).then(() => {
          const headers: Record<string, string> = { ...(init.headers || {}) };
          if (net.user) headers["x-test-user"] = net.user;
          return fetch(base + url, { method: init.method, headers, body: init.body });
        });
      },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "whiteboard.js" });
    const api = sandbox.BeeZillaWhiteboard as Api;
    const inner = sandbox.__test as Inner;
    return {
      api,
      inner,
      net,
      store,
      read(id: string): Board | null { const v = store.get("bz.board." + id); return v ? JSON.parse(v) : null; },
      write(id: string, v: unknown) { store.set("bz.board." + id, JSON.stringify(v)); },
      // A change made on the board, as the page writes it down: the content changes,
      // and the first change since the account last confirmed it keeps what it was.
      edit(id: string, fn: (b: Board) => void) {
        const v = this.read(id) ?? { ...board([]), sync: { rev: null, dirty: false, base: null } };
        const before = JSON.parse(JSON.stringify({ cards: v.cards, links: v.links }));
        fn(v);
        if (!v.sync!.dirty) { v.sync!.dirty = true; v.sync!.base = v.sync!.rev == null ? null : before; }
        this.write(id, v);
      },
    };
  }
  const account = async (user: string, id: string) => (await route(user, "GET", id)).body.board as wb.StoredWhiteboard | null;
  const ids = (b: { cards?: unknown[]; state?: { cards: unknown[] } } | null | undefined) =>
    ((b && (b.state ? b.state.cards : b.cards)) || []).map((c) => (c as Card).id);

  const A = computer("u1");
  const B = computer("u1");

  await ok("a board that was only ever in this browser moves up to the account", async () => {
    // Saved before boards went to the account: no sync note at all.
    A.write("sess_a2", board([card("agent", { kind: "agent", flow: "agent", title: "agent.md" }), card("s1", { kind: "skill", flow: "skill:art", title: "Picture maker" })],
      [{ id: "l1", from: "agent", to: "s1" }]));
    eq(await A.api.sweep(0), 1, "one board sent up");
    const got = await account("u1", "sess_a2");
    eq(ids(got), ["agent", "s1"]);
    eq(got!.rev, 1);
    const local = A.read("sess_a2")!;
    eq([local.sync!.rev, local.sync!.dirty], [1, false]);
  });
  await ok("the other computer gets it", async () => {
    eq(B.read("sess_a2"), null);
    await B.api.sync("sess_a2");
    const b = B.read("sess_a2")!;
    eq(ids(b), ["agent", "s1"]);
    eq([b.sync!.rev, b.sync!.dirty], [1, false]);
    eq(b.links.length, 1);
  });
  await ok("offline, edits wait on this computer; back online, they arrive", async () => {
    A.net.online = false;
    A.edit("sess_a2", (b) => { b.cards.push(card("offline-note", { body: "written on the train" })); });
    await A.api.sync("sess_a2");
    eq(ids(await account("u1", "sess_a2")), ["agent", "s1"], "the account hasn't got it yet");
    eq(A.read("sess_a2")!.sync!.dirty, true, "still waiting here");
    truthy(ids(A.read("sess_a2")).includes("offline-note"), "and kept here");
    A.net.online = true;
    await A.api.sync("sess_a2");
    eq(ids(await account("u1", "sess_a2")), ["agent", "s1", "offline-note"]);
    eq(A.read("sess_a2")!.sync!.dirty, false);
  });
  await ok("two computers change the same board: both changes are kept, field by field", async () => {
    // B is still at revision 1. A moves the skill; B rewrites its words and adds a card.
    A.edit("sess_a2", (b) => { const s = b.cards.find((c) => c.id === "s1")!; s.x = 400; s.y = 80; b.cards.push(card("from-A")); });
    B.edit("sess_a2", (b) => { const s = b.cards.find((c) => c.id === "s1")!; s.body = "Draw it in pencil"; s.user = true; b.cards.push(card("from-B")); });
    await A.api.sync("sess_a2");
    await B.api.sync("sess_a2");
    const got = await account("u1", "sess_a2");
    eq(ids(got).sort(), ["agent", "from-A", "from-B", "offline-note", "s1"]);
    const s = got!.state.cards.find((c) => c.id === "s1")!;
    eq([s.x, s.y, s.body, s.user], [400, 80, "Draw it in pencil", true], "A's move and B's words");
    eq(B.read("sess_a2")!.sync!.dirty, false, "B is settled");
    await A.api.sync("sess_a2");
    eq(ids(A.read("sess_a2")).sort(), ids(got).sort(), "A has B's changes now");
    eq(A.read("sess_a2")!.sync!.rev, got!.rev);
  });
  await ok("removed on one computer: gone, unless the other changed it meanwhile", async () => {
    A.edit("sess_a2", (b) => { b.cards = b.cards.filter((c) => c.id !== "from-A" && c.id !== "from-B"); });
    B.edit("sess_a2", (b) => { const c = b.cards.find((x) => x.id === "from-B")!; c.body = "B still wants this"; });
    await A.api.sync("sess_a2");
    await B.api.sync("sess_a2");
    const got = await account("u1", "sess_a2");
    truthy(!ids(got).includes("from-A"), "from-A: removed on A, untouched on B — gone");
    const kept = got!.state.cards.find((c) => c.id === "from-B");
    eq(kept?.body, "B still wants this", "from-B: removed on A, changed on B — kept");
  });
  await ok("the person's own words on the board travel with it as instructions", async () => {
    await A.api.sync("sess_a2");
    truthy(/Draw it in pencil/.test(A.api.instructionsFor("sess_a2")), A.api.instructionsFor("sess_a2"));
  });
  // Owner, 2026-11-19: "anything that's in the whiteboard, it should be able to see in its context."
  await ok("everything on the board reaches BeeZilla: their words as instructions, the rest to see", () => {
    const C = computer("u9");
    C.write("ctx", { ...board([
      card("agent", { kind: "agent", title: "agent.md", body: "BeeZilla's own words", x: 0 }),
      card("agent-mine", { kind: "agent", title: "agent.md", body: "Keep it friendly", user: true, x: 10 }),
      card("skill-art", { kind: "skill", title: "Picture maker", body: "draws pictures", x: 20 }),
      card("pic-made", { kind: "image", title: "art-2026-11-19-17-13-40.png", url: "/api/buzzy/assets/5", contentType: "image/png", x: 30 }),
      card("pic-theirs", { kind: "image", title: "beach.jpg", url: "/api/buzzy/assets/6", contentType: "image/jpeg", user: true, x: 40 }),
      card("song", { kind: "audio", title: "music-2026-11-19-17-20-00.mp3", url: "/api/buzzy/assets/7", contentType: "audio/mpeg", x: 50 }),
      card("link", { kind: "link", title: "Recipe ideas", url: "https://example.com/ideas", user: true, x: 60 }),
      card("plan", { kind: "note", title: "Plan", body: "Two steps", x: 70 }),
    ]), sync: { rev: null, dirty: false, base: null } });
    const raw = C.api.instructionsFor("ctx");
    // Every picture is named first on a line the server takes off before the model reads
    // the board (takeBoardSeen), so BeeZilla can look at it: made ones by kind, never by name.
    truthy(raw.startsWith("[[board-seen: 5:made here; 6:beach.jpg]]\n"), "the pictures line: " + raw);
    const text = raw.replace(/^\[\[board-seen: [^\]\n]*\]\]\n/, "");
    truthy(/^Core identity \(how BeeZilla works here\): Keep it friendly\n/.test(text), "their words first: " + text);
    truthy(/Also on the board:\n- Picture made here\n- Picture they added — beach\.jpg\n- Music made here\n- Link they added — Recipe ideas \(https:\/\/example\.com\/ideas\)\n- Note — Plan: Two steps$/.test(text), "then the rest: " + text);
    truthy(!/art-2026|music-2026|\/api\/buzzy\/assets|BeeZilla's own words|Picture maker/.test(text), "no made file names, inside links or untouched process cards: " + text);
    eq(C.api.instructionsFor("nothing-here"), "", "an empty board says nothing");
  });
  await ok("the board in front of a new conversation joins it, without drawing a step twice", async () => {
    // B worked in sess_a3's conversation first: agent.md in the person's words, and the
    // picture maker still running.
    await route("u1", "PUT", "sess_a3", {
      state: board([
        card("agentB", { kind: "agent", flow: "agent", title: "agent.md", body: "Be brief.", user: true, x: 0, y: 0 }),
        card("artB", { kind: "skill", flow: "skill:art", title: "Picture maker", state: "running", x: 320, y: 0 }),
      ], [{ id: "lb", from: "agentB", to: "artB" }]),
      baseRev: ((await account("u1", "sess_a3"))?.rev ?? null),
    });
    // On A, "talk" opened with the account's copy (a note drawn there earlier), then a
    // new turn drew on it: agent.md, the picture maker (done) and the picture.
    await A.api.sync("talk");
    eq(ids(A.read("talk")), ["u1-scratch"]);
    A.edit("talk", (b) => {
      b.cards.push(
        card("agentT", { kind: "agent", flow: "agent", title: "agent.md", body: "BeeZilla's own instructions" }),
        card("artT", { kind: "skill", flow: "skill:art", title: "Picture maker", state: "", x: 320 }),
        card("outT", { kind: "image", flow: "out:9", title: "House by a lake", url: "/api/buzzy/assets/9", x: 640 }),
      );
      b.links.push({ id: "t1", from: "agentT", to: "artT" }, { id: "t2", from: "artT", to: "outT" });
    });
    await A.api.carry("talk", "sess_a3");
    const got = (await account("u1", "sess_a3"))!.state;
    eq(got.cards.filter((c) => c.flow === "agent").length, 1, "one agent.md");
    eq(got.cards.filter((c) => c.flow === "skill:art").length, 1, "one picture maker");
    const agent = got.cards.find((c) => c.flow === "agent")!;
    eq([agent.id, agent.body], ["agentB", "Be brief."], "the person's own words kept");
    const art = got.cards.find((c) => c.flow === "skill:art")!;
    eq([art.id, art.state], ["artB", ""], "finished beats still working");
    truthy(got.cards.some((c) => c.flow === "out:9"), "the picture joined");
    const out = got.cards.find((c) => c.flow === "out:9")!;
    truthy(got.links.some((l) => l.from === "artB" && l.to === out.id), "its line now starts at the existing picture maker");
    eq(got.links.filter((l) => (l.from === "agentB" && l.to === "artB") || (l.from === "artB" && l.to === "agentB")).length, 1, "no doubled line");
    truthy(got.cards.some((c) => c.id === "u1-scratch"), "the note on 'talk' went along");
    eq(A.read("talk")!.cards.length, 0, "'talk' is empty again here");
    eq((await account("u1", "talk"))!.state.cards.length, 0, "and in the account");
  });
  await ok("a board from another account's conversation stays on this computer, and isn't sent again", async () => {
    A.write("sess_b1", board([card("theirs")]));
    await A.api.sync("sess_b1");
    const puts = () => A.net.calls.filter((c) => c === "PUT /api/buzzy/whiteboards/sess_b1").length;
    eq(puts(), 1, "tried once");
    await A.api.sync("sess_b1");
    eq(puts(), 1, "not again on this page");
    eq(ids(A.read("sess_b1")), ["theirs"], "kept here");
    eq(await account("u2", "sess_b1"), null, "nothing reached the other account");
  });
  await ok("on a shared computer, one person's unsaved board never goes into the next person's account", async () => {
    // u1 draws on the scratch board, saves once, then adds a card the account never gets.
    const disk = new Map<string, string>();
    const u1 = computer("u1", disk);
    await route("u1", "PUT", "talk", { state: board([]), baseRev: (await account("u1", "talk"))?.rev ?? null });
    u1.edit("talk", (b) => { b.cards.push(card("saved-by-u1")); });
    await u1.api.sync("talk");
    eq(ids(await account("u1", "talk")), ["saved-by-u1"]);
    u1.net.online = false;
    u1.edit("talk", (b) => { b.cards.push(card("unsaved-by-u1")); });
    await u1.api.sync("talk");
    // u1 signs out; u2 signs in on the same browser and opens Talk.
    const u2 = computer("u2", disk);
    await u2.api.sync("talk");
    const theirs = await account("u2", "talk");
    truthy(!ids(theirs).includes("unsaved-by-u1") && !ids(theirs).includes("saved-by-u1"), `u2's account: ${ids(theirs).join(", ")}`);
    eq(ids(u2.read("talk")), ids(theirs), "u2 sees u2's own scratch board");
    const aside = [...disk.keys()].filter((k) => k.startsWith("bz.board.talk~"));
    eq(aside.length, 1, "u1's unsaved copy is set aside under u1's code");
    eq(ids(JSON.parse(disk.get(aside[0]!)!)), ["saved-by-u1", "unsaved-by-u1"]);
    // u2 starts a conversation: nothing of u1's goes with it.
    u2.edit("talk", (b) => { b.cards.push(card("u2-first-turn")); });
    await u2.api.carry("talk", "sess_b1");
    truthy(!ids(await account("u2", "sess_b1")).some((x) => /u1/.test(x)), "u1's cards never reach u2's conversation");
    // u1 comes back: their unsaved card reaches their own account.
    const back = computer("u1", disk);
    await back.api.sync("talk");
    eq(ids(await account("u1", "talk")), ["saved-by-u1", "unsaved-by-u1"]);
    eq([...disk.keys()].filter((k) => k.startsWith("bz.board.talk~")).length, 0, "and nothing is set aside any more");
  });
  await ok("when the account no longer has a board this computer had saved, this copy follows", async () => {
    // B last saw "talk" with a card in it; it was carried into a conversation since.
    B.write("talk", { ...board([card("old-scratch")]), sync: { rev: 1, dirty: false, base: null } });
    await db.query("DELETE FROM buzzy_whiteboards WHERE user_id = 'u1' AND session_id = 'talk'");
    await B.api.sync("talk");
    eq(B.read("talk")!.cards.length, 0, "not sent back up as if it were new");
    eq(await account("u1", "talk"), null);
  });
  await ok("signed out, nothing is sent and the board stays here", async () => {
    const C = computer(null);
    C.write("sess_a1", board([card("signed-out")]));
    await C.api.sync("sess_a1");
    eq(ids(C.read("sess_a1")), ["signed-out"]);
    eq(C.net.calls, ["GET /api/buzzy/whiteboards/sess_a1"], "one read, no save");
  });
  await ok("an upload that finishes after its board was put away lands on its card only", async () => {
    // A's copy is stale (B changed the board since) and holds a card still uploading.
    A.edit("sess_a2", (b) => { b.cards.push(card("uploading", { state: "running", body: "Adding to your Library…" })); });
    await A.api.sync("sess_a2");
    await B.api.sync("sess_a2");
    B.edit("sess_a2", (b) => { b.cards.push(card("from-B-later")); });
    await B.api.sync("sess_a2");
    A.inner.patchCard("sess_a2", "uploading", { url: "/api/buzzy/assets/77", state: "", body: "" });
    await A.api.sync("sess_a2");
    const got = (await account("u1", "sess_a2"))!.state;
    const up = got.cards.find((c) => c.id === "uploading")!;
    eq([up.url, up.state], ["/api/buzzy/assets/77", ""], "the upload landed");
    truthy(got.cards.some((c) => c.id === "from-B-later"), "and B's newer card is still there");
  });
  await ok("going back keeps what was drawn while the request was out", async () => {
    await db.query("UPDATE buzzy_whiteboard_versions SET started_at = now() - interval '10 minutes' WHERE user_id = 'u1' AND session_id = 'sess_a2'");
    A.edit("sess_a2", (b) => { b.cards.push(card("later-version")); });
    await A.api.sync("sess_a2");
    const older = (await versions("u1", "sess_a2")).find((v) => !v.titles.includes("later-version"))!;
    A.net.during = (call) => {
      if (!/\/restore$/.test(call)) return;
      A.net.during = null;
      A.edit("sess_a2", (b) => { b.cards.push(card("drawn-meanwhile")); });
    };
    const r = await A.inner.restoreVersion(A.inner.engine("sess_a2"), older.id);
    eq(r.ok, true);
    const got = ids(await account("u1", "sess_a2"));
    truthy(!got.includes("later-version"), "the board went back");
    truthy(got.includes("drawn-meanwhile"), "and kept what was drawn meanwhile");
    eq(A.read("sess_a2")!.sync!.dirty, false);
  });
  await ok("saves that keep failing wait longer each time, even when reads work", async () => {
    trouble.failSaves = true;
    A.edit("sess_a2", (b) => { b.cards.push(card("while-the-server-fails")); });
    const e = A.inner.engine("sess_a2");
    await A.api.sync("sess_a2");
    const first = e.backoff;
    await A.api.sync("sess_a2");
    const second = e.backoff;
    trouble.failSaves = false;
    truthy(first > 0 && second > first, `waits ${first} then ${second} ms`);
    eq(e.status, "offline");
    await A.api.sync("sess_a2");
    eq([e.backoff, e.status], [0, "saved"], "and starts over once it saves");
    truthy(ids(await account("u1", "sess_a2")).includes("while-the-server-fails"));
  });
  // A visit empties the board in front of a new conversation, and its comment promises
  // the earlier versions stay in History. A blank save inside the five-minute window
  // used to roll into the entry the drawing had just made, so the drawing was gone.
  await ok("a new visit starts blank, and the board drawn a minute ago is still in History", async () => {
    const disk = new Map<string, string>();
    const drew = computer("u6", disk);
    await drew.api.sync("talk");
    drew.edit("talk", (b) => { b.cards.push(card("two-1"), card("two-2")); });
    await drew.api.sync("talk");
    eq(ids(await account("u6", "talk")), ["two-1", "two-2"]);
    const reloaded = computer("u6", disk);       // the same browser, opened again
    await reloaded.api.reset("talk");
    eq(ids(await account("u6", "talk")), [], "a new visit starts blank");
    const hist = await versions("u6", "talk");
    const drawn = hist.find((v) => v.cards === 2);
    truthy(drawn, `the two cards are still in History (cards: ${JSON.stringify(hist.map((v) => v.cards))})`);
    const r = await route("u6", "POST", `talk/versions/${drawn!.id}/restore`);
    eq(ids(r.body.board as wb.StoredWhiteboard), ["two-1", "two-2"], "and going back to it brings them back");
  });
  // New conversation empties the board in front of a new conversation at once, and loses
  // nothing (testers, 2026-11-24; reviews of the New conversation fix): a copy the account
  // hadn't got is kept here and sent first, each emptied drawing gets an entry of its own.
  await ok("a save can name its account: another account's copy is refused, nothing saved", async () => {
    const mine = await route("u7", "GET", "talk");
    const other = await route("u7", "PUT", "talk", { state: board([card("not-yours")]), baseRev: null, owner: String((await route("u8", "GET", "talk")).body.who) });
    eq([other.status, other.body.code], [403, "other_account"]);
    eq(ids(await account("u7", "talk")), [], "nothing was saved");
    const big = board(Array.from({ length: 300 }, (_, i) => card("c" + i, { body: "x".repeat(4000) })));
    const bigOther = await route("u7", "PUT", "talk", { state: big, baseRev: null, owner: String((await route("u8", "GET", "talk")).body.who) });
    eq([bigOther.status, bigOther.body.code], [403, "other_account"], "the account is checked first: no other answer is taken as being about that copy");
    const own = await route("u7", "PUT", "talk", { state: board([]), baseRev: null, owner: String(mine.body.who) });
    eq(own.status, 200, "its own account's copy is saved");
  });
  await ok("New conversation offline: each emptied drawing keeps its own History entry once back online", async () => {
    const disk = new Map<string, string>();
    const c = computer("u13", disk);
    await c.api.sync("talk");
    c.edit("talk", (b) => { b.cards.push(card("saved-1")); });
    await c.api.sync("talk");
    eq(ids(await account("u13", "talk")), ["saved-1"]);
    c.net.online = false;
    await c.api.reset("talk");                  // saved already: nothing to keep aside
    eq(ids(c.read("talk")), [], "blank at once");
    c.edit("talk", (b) => { b.cards.push(card("offline-1")); });
    await c.api.reset("talk");
    c.edit("talk", (b) => { b.cards.push(card("offline-2")); });
    await c.api.reset("talk");
    eq(ids(c.read("talk")), [], "blank each time, offline too");
    eq((JSON.parse(disk.get("bz.board.talk~left") || "[]") as Board[]).map((d) => ids(d)), [["offline-1"], ["offline-2"]], "kept on this computer meanwhile");
    c.net.online = true;
    await c.api.sync("talk");
    eq(ids(await account("u13", "talk")), [], "the board itself stays blank");
    const hist = await versions("u13", "talk");
    const alone = (t: string) => hist.some((v) => v.cards === 1 && (v.titles || []).includes(t));
    truthy(alone("saved-1") && alone("offline-1") && alone("offline-2"), `each has its own entry: ${JSON.stringify(hist.map((v) => v.titles))}`);
    eq(disk.has("bz.board.talk~left"), false, "nothing is left only on this computer");
  });
  await ok("another computer's save while a kept copy goes up keeps its own History entry", async () => {
    const disk = new Map<string, string>();
    const c = computer("u14", disk);
    await c.api.sync("talk");
    c.net.online = false;
    c.edit("talk", (b) => { b.cards.push(card("waiting-1")); });
    await c.api.reset("talk");
    c.net.online = true;
    let once = false;
    c.net.during = async (call: string) => {
      if (once || !call.startsWith("PUT ")) return;
      once = true;
      const now = await account("u14", "talk");
      eq((await route("u14", "PUT", "talk", { state: board([card("other-device")]), baseRev: now ? now.rev : null })).status, 200);
    };
    await c.api.sync("talk");
    c.net.during = null;
    const hist = await versions("u14", "talk");
    const alone = (t: string) => hist.some((v) => v.cards === 1 && (v.titles || []).includes(t));
    truthy(alone("other-device") && alone("waiting-1"), `both keep their own entry: ${JSON.stringify(hist.map((v) => v.titles))}`);
    eq(ids(await account("u14", "talk")), [], "and the board is blank");
  });
  await ok("a kept copy never goes into an account that signed in meanwhile", async () => {
    const disk = new Map<string, string>();
    const c = computer("u15", disk);
    await c.api.sync("talk");
    c.edit("talk", (b) => { b.cards.push(card("u15-draft")); });
    await c.api.sync("talk");                   // saved once: the copy knows its account
    c.net.online = false;
    c.edit("talk", (b) => { b.cards.push(card("u15-more")); });
    await c.api.reset("talk");
    c.net.online = true;
    c.net.during = (call: string) => { if (call.startsWith("PUT ")) c.net.user = "u16"; };   // someone else signs in, mid-way
    await c.api.sync("talk");
    c.net.during = null;
    const theirs = ids(await account("u16", "talk"));
    truthy(!theirs.includes("u15-draft") && !theirs.includes("u15-more"), `nothing of u15's in u16's account: ${JSON.stringify(theirs)}`);
    truthy((JSON.parse(disk.get("bz.board.talk~left") || "[]") as Board[]).some((d) => ids(d).includes("u15-more")), "still kept here for u15");
  });
  await ok("a kept copy the account won't keep (too big) goes back on the board, never lost", async () => {
    const disk = new Map<string, string>();
    const c = computer("u17", disk);
    await c.api.sync("talk");
    c.net.online = false;
    c.edit("talk", (b) => { for (let i = 0; i < 300; i++) b.cards.push(card("big" + i, { body: "x".repeat(4000) })); });
    await c.api.reset("talk");
    eq(ids(c.read("talk")), [], "blank at once");
    c.net.online = true;
    await c.api.sync("talk");
    eq(ids(c.read("talk")).length, 300, "all 300 cards are back on the board");
    eq(ids(await account("u17", "talk")), []);
  });
  await ok("the board inside a conversation survives a reload", async () => {
    // "talk" is emptied on a visit; a conversation's board is only read back.
    const disk = new Map<string, string>();
    const drew = computer("u6", disk);
    await route("u6", "PUT", "sess_c6", { state: board([card("kept-1"), card("kept-2")]), baseRev: null });
    await drew.api.sync("sess_c6");
    eq(ids(drew.read("sess_c6")), ["kept-1", "kept-2"], "read on this computer");
    const reloaded = computer("u6", disk);       // the same browser, opened again
    await reloaded.api.sync("sess_c6");          // what voice-stage.js does for a conversation
    eq(ids(reloaded.read("sess_c6")), ["kept-1", "kept-2"], "still there after the reload");
    eq(ids(await account("u6", "sess_c6")), ["kept-1", "kept-2"]);
  });
  await ok("the merge on its own: two copies that never met don't land on top of each other", () => {
    const m = A.api.merge(null, { cards: [card("mine", { x: 0, y: 0 })], links: [] }, { cards: [card("theirs", { x: 0, y: 0 })], links: [] });
    const mine = m.cards.find((c) => c.id === "mine")!;
    const theirs = m.cards.find((c) => c.id === "theirs")!;
    truthy(Number(mine.y) >= Number(theirs.y) + 160, `moved below (${mine.y})`);
  });

  // The settings gear (#326) sits fixed in the bottom-right corner of every page, and on
  // a short window History reaches that corner. A panel covers the gear, never the
  // reverse; the page's own menus still cover the board.
  // The board follows the conversation in front of the person: voice-stage.js reads
  // bz_session_id, so every path that puts a conversation on screen has to say which
  // one it is. A new conversation did; opening one from the list did not, and the
  // board stayed on the blank new-conversation board while its cards sat in the account.
  await ok("opening a conversation from the list moves the board to that conversation", () => {
    const page = readFileSync(join(process.cwd(), "public/buzzy/talk.html"), "utf8");
    const body = page.slice(page.indexOf("async function openSession("), page.indexOf("function renameSession(s, card)"));
    truthy(/localStorage\.setItem\("bz_session_id", s\.id\)/.test(body), "openSession names the conversation to the board");
  });
  await ok("History covers the settings gear, and the page's menus still cover History", () => {
    const read = (f: string) => readFileSync(join(process.cwd(), "public/buzzy", f), "utf8");
    const css = read("whiteboard.css");
    const z = (sel: string) => {
      const m = css.match(new RegExp("(?:^|\\n)" + sel.replace(/\./g, "\\.") + " \\{[^}]*?z-index: (\\d+)"));
      if (!m) throw new Error(`no z-index for ${sel}`);
      return Number(m[1]);
    };
    const gear = Number((read("nav.js").match(/#bzDock\{[^}]*z-index:(\d+)/) || [])[1]);
    const menu = Number((read("talk.html").match(/\.account-menu \{[^}]*z-index: (\d+)/) || [])[1]);
    truthy(gear > 0 && menu > 0, `found the gear (${gear}) and the account menu (${menu})`);
    const [hist, selbar, editor, toast] = [".wb-history", ".wb-selbar", ".wb-editor", ".wb-toast"].map(z);
    truthy(hist > gear, `History (${hist}) over the gear (${gear})`);
    truthy(hist < selbar && selbar < editor && editor < toast, `the board's order is kept: History ${hist} < selection bar ${selbar} < editor ${editor} < message ${toast}`);
    truthy(toast < menu, `all under the account menu (${menu})`);
  });

  server.close();
  await db.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
