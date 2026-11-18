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
 *     then arrive, two computers' changes merge card by card, and the board in front
 *     of a new conversation joins it without drawing a step twice.
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
import { deleteAccountData } from "../src/lib/buzzy/portability";
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
  for (const [id, user] of [["sess_a1", "u1"], ["sess_a2", "u1"], ["sess_a3", "u1"], ["sess_b1", "u2"]]) {
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
  await ok("deleting the account deletes its boards and their history", async () => {
    await route("u3", "PUT", "talk", { state: board([card("bye")]), baseRev: null });
    const receipt = await deleteAccountData(sql, "u3");
    eq([receipt.buzzy_whiteboards, receipt.buzzy_whiteboard_versions], [1, 1]);
    eq((await route("u3", "GET", "talk")).body.board, null);
    truthy(((await route("u1", "GET", "sess_a1")).body.board), "someone else's boards are untouched");
  });

  // ── Two computers, running the real browser code ───────────────────────
  console.log("\nTwo computers — public/buzzy/whiteboard.js against the route\n");

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const user = String(req.headers["x-test-user"] || "");
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!user) return send(401, { ok: false, code: "signed_out" });
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
  const code = readFileSync(join(process.cwd(), "public/buzzy/whiteboard.js"), "utf8");

  type Api = {
    sync(id: string): Promise<unknown>;
    carry(from: string, to: string): Promise<unknown>;
    sweep(gap?: number): Promise<number>;
    merge(b: unknown, m: unknown, t: unknown): { cards: Card[]; links: Array<Record<string, unknown>> };
    instructionsFor(id: string): string;
  };
  function computer(user: string | null, shared?: Map<string, string>) {
    const store = shared ?? new Map<string, string>();
    const net = { online: true, calls: [] as string[] };
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
        const headers: Record<string, string> = { ...(init.headers || {}) };
        if (user) headers["x-test-user"] = user;
        return fetch(base + url, { method: init.method, headers, body: init.body });
      },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "whiteboard.js" });
    const api = sandbox.BeeZillaWhiteboard as Api;
    return {
      api,
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
    eq(ids(u2.read("talk")), ["saved-by-u1", "unsaved-by-u1"], "u1's unsaved card is still here for u1");
    // u1 comes back: their card reaches their own account.
    const back = computer("u1", disk);
    await back.api.sync("talk");
    eq(ids(await account("u1", "talk")), ["saved-by-u1", "unsaved-by-u1"]);
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
  await ok("the merge on its own: two copies that never met don't land on top of each other", () => {
    const m = A.api.merge(null, { cards: [card("mine", { x: 0, y: 0 })], links: [] }, { cards: [card("theirs", { x: 0, y: 0 })], links: [] });
    const mine = m.cards.find((c) => c.id === "mine")!;
    const theirs = m.cards.find((c) => c.id === "theirs")!;
    truthy(Number(mine.y) >= Number(theirs.y) + 160, `moved below (${mine.y})`);
  });

  server.close();
  await db.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
