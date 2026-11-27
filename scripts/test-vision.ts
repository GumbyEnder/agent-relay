/**
 * BeeZilla looks at pictures (testers, 2026-11-24: "That's actually our biggest request.
 * BeeZilla able to read and analyze a referred or uploaded image. But it should be
 * reading everything on that board").
 *
 *   - The pictures that matter are picked in order — pointed at, just added, joined into
 *     a step, in view, the rest of the board, the newest one made — each once, at most six.
 *   - A plain description is kept per picture and reused; a question about a picture is
 *     asked of the picture itself, every time.
 *   - Only the person's own files are read; Lockdown sends nothing out.
 *   - What each picture shows goes into the turn's instructions, as things BeeZilla saw.
 *
 *   npx tsx scripts/test-vision.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

process.env.BZ_CHAT_KEY = "test-key";
process.env.BZ_CHAT_BASE_URL = "https://provider.test/v1";
process.env.BZ_VISION_MODEL = "vision-model";
process.env.BZ_IMAGE_MODEL = "image-model";

const V = await import("../src/lib/buzzy/vision");

let pass = 0;
let fail = 0;
const tests: Array<[string, () => unknown]> = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// A tiny stand-in for the database: assets and kept descriptions, per user.
type Asset = { id: number; user: string; type: string; body: Buffer };
function fakeSql(assets: Asset[], looks: Map<string, { note: string; model: string }> = new Map()) {
  const log: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?");
    log.push(q);
    if (/FROM buzzy_picture_looks/.test(q)) {
      const [user, id] = vals as [string, number];
      const hit = looks.get(`${user}:${id}`);
      return Promise.resolve(hit ? [hit] : []);
    }
    if (/FROM buzzy_assets/.test(q)) {
      const [user, id] = vals as [string, number];
      const a = assets.find((x) => x.user === user && x.id === id);
      return Promise.resolve(a ? [{ body: a.body, content_type: a.type }] : []);
    }
    if (/INSERT INTO buzzy_picture_looks/.test(q)) {
      const [id, user, note, model] = vals as [number, string, string, string];
      looks.set(`${user}:${id}`, { note, model });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof V.lookAtPicture>[0];
  (sql as unknown as { query: (text: string, params: unknown[]) => Promise<unknown[]> }).query = (text, params) => {
    log.push(text);
    if (/FROM buzzy_picture_looks WHERE user_id = \$1 AND asset_id IN \(/.test(text)) {
      const [user, ...ids] = params as [string, ...number[]];
      return Promise.resolve(ids.filter((id) => looks.has(`${user}:${id}`)).map((id) => ({ asset_id: String(id) })));
    }
    return Promise.resolve([]);
  };
  return { sql, log, looks };
}
// A copy of a fake database whose read of which pictures are kept never answers.
function stalledCheck(db: ReturnType<typeof fakeSql>) {
  const run = db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => run(strings, ...vals)) as unknown as Parameters<typeof V.lookAtPictures>[0];
  (sql as unknown as { query: () => Promise<unknown[]> }).query = () => new Promise(() => {});
  return sql;
}
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function fakeFetch(reply: (body: any, url: string) => { status?: number; json?: unknown; text?: string; delayMs?: number }) {
  const calls: Array<{ url: string; body: any }> = [];
  const f = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const r = reply(body, url);
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    const status = r.status ?? 200;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}
const says = (text: string) => ({ json: { choices: [{ message: { content: text } }] } });

console.log("Which pictures");

ok("picked in order — pointed, added, joined, in view, on the board, made here — each once, at most six", () => {
  const picks = V.pickPictures([
    { id: 5, why: "on the board", label: "five" },
    { id: 3, why: "connected", label: "three" },
    { id: 9, why: "made here" },
    { id: 3, why: "pointed" },
    { id: 4, why: "attached" },
    { id: 7, why: "in view", label: "seven" },
    { id: 8, why: "on the board" },
    { id: 10, why: "on the board" },
    null,
    { id: -1, why: "pointed" },
    { id: 1.5, why: "pointed" },
  ]);
  eq(picks.map((p) => [p.id, p.why]), [[3, "pointed"], [4, "attached"], [7, "in view"], [5, "on the board"], [8, "on the board"], [10, "on the board"]], "order:");
  eq(picks[0]!.label, "three", "the label of a picture named twice is kept:");
});

ok("labels are plain words: no brackets, no line breaks, short", () => {
  const [p] = V.pickPictures([{ id: 1, why: "connected", label: "Ark [[Titan]]\n<b>concept</b> " + "x".repeat(200) }]);
  truthy(!/[[\]<>\n]/.test(p!.label!) && p!.label!.length <= 70, p!.label);
});

ok("a message about the picture itself is told apart from one that only mentions it", () => {
  for (const m of ["what is this?", "Describe this picture", "how many wheels does it have?", "analyze my concept art", "take a look at the helicopter in this picture", "what do you think of this image?"]) truthy(V.asksAboutPicture(m), m);
  for (const m of ["make me a picture of a cat", "thanks!", "save it to my library", ""]) truthy(!V.asksAboutPicture(m), m);
  // With only one picture around and nothing pointed at, a bare "it" is not enough to ask the picture.
  truthy(V.namesAPicture("what's in the concept art?") && !V.namesAPicture("is it going to rain?"), "names a picture");
});

console.log("\nLooking");

ok("a kept description is used as it is: nothing is sent", async () => {
  const db = fakeSql([{ id: 1, user: "u1", type: "image/png", body: PNG }], new Map([["u1:1", { note: "A red tank.", model: "m" }]]));
  const net = fakeFetch(() => says("never"));
  const r = await V.lookAtPicture(db.sql, "u1", { id: 1, why: "connected" }, { fetchImpl: net.f });
  truthy("note" in r && r.note === "A red tank." && r.cached, JSON.stringify(r));
  eq(net.calls.length, 0, "no call:");
});

ok("a new picture is sent inline to the model that can see, in words only, and the description is kept", async () => {
  const db = fakeSql([{ id: 2, user: "u1", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => says("A green helicopter, side view, on white."));
  const r = await V.lookAtPicture(db.sql, "u1", { id: 2, why: "pointed", label: "heli" }, { fetchImpl: net.f });
  truthy("note" in r && r.note.startsWith("A green helicopter") && !r.cached, JSON.stringify(r));
  const call = net.calls[0]!;
  eq(call.url, "https://provider.test/v1/chat/completions", "url:");
  eq(call.body.model, "vision-model", "model:");
  eq(call.body.modalities, ["text"], "words only:");
  const parts = call.body.messages[0].content;
  truthy(parts[0].type === "text" && /BeeZilla's eyes/.test(parts[0].text), "the prompt");
  truthy(parts[1].type === "image_url" && parts[1].image_url.url === "data:image/png;base64," + PNG.toString("base64"), "the picture inline");
  eq(db.looks.get("u1:2")?.note, "A green helicopter, side view, on white.", "kept:");
});

ok("a question is asked of the picture itself, every time, and its answer is not kept", async () => {
  const db = fakeSql([{ id: 3, user: "u1", type: "image/jpeg", body: PNG }], new Map([["u1:3", { note: "old", model: "m" }]]));
  const net = fakeFetch(() => says("A tank with four wheels.\n" + V.ANSWER_MARK + " It has four wheels on each side."));
  const r = await V.lookAtPicture(db.sql, "u1", { id: 3, why: "pointed" }, { question: "how many wheels?", fetchImpl: net.f });
  truthy("note" in r && r.answer === "It has four wheels on each side." && r.note === "A tank with four wheels.", JSON.stringify(r));
  truthy(net.calls[0]!.body.messages[0].content[0].text.includes(V.ANSWER_MARK) && /how many wheels\?/.test(net.calls[0]!.body.messages[0].content[0].text), "the question goes with the picture");
  eq(db.looks.get("u1:3")?.note, "A tank with four wheels.", "the description is kept, the answer is not:");
});

ok("only the person's own pictures are read", async () => {
  const db = fakeSql([{ id: 4, user: "someone-else", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => says("x"));
  const r = await V.lookAtPicture(db.sql, "u1", { id: 4, why: "connected" }, { fetchImpl: net.f });
  truthy("code" in r && r.code === "not_found", JSON.stringify(r));
  eq(net.calls.length, 0, "nothing sent:");
});

ok("Lockdown sends nothing: kept descriptions only", async () => {
  const db = fakeSql([{ id: 5, user: "u1", type: "image/png", body: PNG }, { id: 6, user: "u1", type: "image/png", body: PNG }], new Map([["u1:6", { note: "kept", model: "m" }]]));
  const net = fakeFetch(() => says("x"));
  const a = await V.lookAtPicture(db.sql, "u1", { id: 5, why: "connected" }, { cachedOnly: true, fetchImpl: net.f });
  const b = await V.lookAtPicture(db.sql, "u1", { id: 6, why: "connected" }, { cachedOnly: true, question: "what is it?", fetchImpl: net.f });
  truthy("code" in a && a.code === "lockdown", JSON.stringify(a));
  truthy("note" in b && b.note === "kept", JSON.stringify(b));
  eq(net.calls.length, 0, "nothing sent:");
});

ok("the account's own rules, said as they are — never \"Lockdown\" when it isn't (independent review, 2026-11-25)", async () => {
  const db = fakeSql([{ id: 5, user: "u1", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => says("x"));
  for (const [blocked, words] of [["provider", /different provider/], ["local-only", /local models/], ["budget", /spending limit/], ["unknown", /couldn't be read/]] as const) {
    const r = await V.lookAtPicture(db.sql, "u1", { id: 5, why: "connected" }, { cachedOnly: true, blocked, fetchImpl: net.f });
    truthy("code" in r && r.code === "blocked" && words.test(r.error), JSON.stringify(r));
    const said = V.picturesSeenBlock([], { failed: "code" in r ? [r] : [], blocked });
    truthy(words.test(said) && !/Lockdown/.test(said), said);
  }
  eq(net.calls.length, 0, "nothing sent:");
});

ok("the picture a question is about is looked at even past the limit of six", async () => {
  const assets = Array.from({ length: 7 }, (_, i) => ({ id: 40 + i, user: "u1", type: "image/png", body: PNG }));
  const db = fakeSql(assets);
  const net = fakeFetch(() => says("A picture.\nANSWER TO THE QUESTION: It is the seventh."));
  const picks = assets.map((a, i) => ({ id: a.id, why: "on the board" as const, label: i === 6 ? "wiring diagram" : "pic " + i }));
  const r = await V.lookAtPictures(db.sql, "u1", picks, { question: "read the wiring diagram", questionFor: 46, fetchImpl: net.f, budgetMs: 5000 });
  const seen = r.looks.map((l) => l.id);
  truthy(seen.includes(46), JSON.stringify(seen));
  eq(seen[0], 46, "first, so its answer is never past the room:");
  truthy(V.picturesSeenBlock(r.looks).split("\n")[1]!.includes("It is the seventh."), "said first");
  eq(seen.length, V.LOOK_MAX, "still six in all:");
  truthy(r.looks.find((l) => l.id === 46)?.answer === "It is the seventh.", JSON.stringify(r.looks.find((l) => l.id === 46)));
});

ok("a conversation's pictures come back newest first, a recovered one older than a fresh one (final review)", async () => {
  const C = await import("../src/lib/buzzy/chatPictures");
  const pg = new PGlite();
  for (const f of ["0048_buzzy_assets.sql", "0073_buzzy_chat_pictures.sql"]) await pg.exec(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => { text += s + (i < values.length ? "$" + (i + 1) : ""); });
    return pg.query(text, values).then((r) => r.rows);
  }) as unknown as Parameters<typeof C.keepConversationPictures>[0];
  for (const [id, user] of [[1, "u1"], [2, "u1"], [3, "u1"], [4, "u2"]] as const) {
    await pg.query("INSERT INTO buzzy_assets (id, user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES ($1, $2, $3, 'p.png', 'p.png', 'image/png', 1, $4)", [id, user, "sha" + id, new Uint8Array([1])]);
  }
  // Photo A's send failed before it reached the server; the next send carries photo B, and
  // the page still holds A: B is the newest, A just before it.
  await C.keepConversationPictures(sql, "u1", "s1", [2], [1]);
  eq(await C.conversationPictures(sql, "u1", "s1"), [2, 1], "B, then A:");
  // A later photo C; A held again changes nothing; someone else's picture is never kept.
  await C.keepConversationPictures(sql, "u1", "s1", [3, 4], [2, 1]);
  eq(await C.conversationPictures(sql, "u1", "s1"), [3, 2, 1], "C, B, A:");
  eq(await C.conversationPictures(sql, "u2", "s1"), [], "nothing for anyone else:");
  // Added A, then B, then A again before sending: A is the newest (the last time counts).
  await pg.query("INSERT INTO buzzy_assets (id, user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES (5, 'u1', 'sha5', 'p.png', 'p.png', 'image/png', 1, $1), (6, 'u1', 'sha6', 'p.png', 'p.png', 'image/png', 1, $1)", [new Uint8Array([1])]);
  await C.keepConversationPictures(sql, "u1", "s2", [5, 6, 5], []);
  eq(await C.conversationPictures(sql, "u1", "s2"), [5, 6], "A again is the newest:");
  // A kept a moment ago; a retry then brings back B, newer than A on the page ([B, A], newest
  // first): B goes after A, however close in time.
  await C.keepConversationPictures(sql, "u1", "s3", [1], []);
  await C.keepConversationPictures(sql, "u1", "s3", [], [2, 1]);
  eq(await C.conversationPictures(sql, "u1", "s3"), [2, 1], "B after A:");
});

ok("a missing vision model falls back to the picture maker's model", async () => {
  const db = fakeSql([{ id: 7, user: "u1", type: "image/webp", body: PNG }]);
  const net = fakeFetch((b) => (b.model === "vision-model" ? { status: 404, text: "no such model" } : says("A blue robot.")));
  const r = await V.lookAtPicture(db.sql, "u1", { id: 7, why: "connected" }, { fetchImpl: net.f });
  truthy("note" in r && r.note === "A blue robot." && r.model === "image-model", JSON.stringify(r));
  eq(net.calls.map((c) => c.body.model), ["vision-model", "image-model"], "tried:");
});

ok("not a picture, or a failure: said plainly, never guessed", async () => {
  const db = fakeSql([{ id: 8, user: "u1", type: "model/gltf-binary", body: PNG }, { id: 9, user: "u1", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => ({ status: 500, text: "boom" }));
  const a = await V.lookAtPicture(db.sql, "u1", { id: 8, why: "connected" }, { fetchImpl: net.f });
  const b = await V.lookAtPicture(db.sql, "u1", { id: 9, why: "connected" }, { fetchImpl: net.f });
  truthy("code" in a && a.code === "not_a_picture", JSON.stringify(a));
  truthy("code" in b && b.code === "provider_error", JSON.stringify(b));
});

ok("a picture that shows the word ANSWER: keeps all of its description when no question was asked", () => {
  const t = "A form. It reads: ANSWER: 42 and NAME: Bob.";
  eq(V.splitAnswer(t, false), { note: t }, "no question:");
  eq(V.splitAnswer("A dog.\n" + V.ANSWER_MARK + " Brown.", true), { note: "A dog.", answer: "Brown." }, "asked:");
});

ok("two turns on the same board share one look at a new picture", async () => {
  const db = fakeSql([{ id: 11, user: "u1", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => ({ ...says("A red bike."), delayMs: 60 }));
  const [a, b] = await Promise.all([
    V.lookAtPicture(db.sql, "u1", { id: 11, why: "on the board" }, { fetchImpl: net.f }),
    V.lookAtPicture(db.sql, "u1", { id: 11, why: "pointed", label: "bike" }, { fetchImpl: net.f }),
  ]);
  eq(net.calls.length, 1, "sent out once:");
  truthy("note" in a && "note" in b && a.note === "A red bike." && b.why === "pointed", JSON.stringify([a, b]));
});

ok("several at once, inside a time budget: what is late is counted, not waited for", async () => {
  const db = fakeSql([1, 2, 3].map((id) => ({ id, user: "u1", type: "image/png", body: PNG })));
  const net = fakeFetch((b) => {
    const isSlow = /data:image\/png/.test(b.messages[0].content[1].image_url.url) && net.calls.length === 3;
    return { ...says("seen"), delayMs: isSlow ? 400 : 5 };
  });
  const r = await V.lookAtPictures(db.sql, "u1", [{ id: 1, why: "connected" }, { id: 2, why: "connected" }, { id: 3, why: "connected" }], { budgetMs: 150, fetchImpl: net.f });
  eq(r.looks.length + r.late, 3, "every picture is either seen or counted late:");
  truthy(r.late === 1, `one late, got ${r.late}`);
});

console.log("\nA picture put on the board");

// What server.ts does for a turn: wait (up to the budget) for the pictures waitsForLook names.
const turnLooks = (sql: Parameters<typeof V.lookAtPictures>[0], user: string, picks: Parameters<typeof V.lookAtPictures>[2], about: boolean, net: ReturnType<typeof fakeFetch>) =>
  V.lookAtPictures(sql, user, picks, { budgetMs: V.lookBudgetMs({ voice: false }), waitFor: (p) => V.waitsForLook(user, p, { aboutAPicture: about }), fetchImpl: net.f });

ok("a turn waits for the pictures on the board, whatever the words; a turn about a picture waits for all of them", () => {
  for (const why of ["on the board", "in view", "connected", "pointed"] as const) {
    truthy(V.waitsForLook("w1", { id: 1, why }, { aboutAPicture: false }), `"${why}", words not about a picture`);
  }
  for (const why of ["in the conversation", "made here", "attached"] as const) {
    truthy(!V.waitsForLook("w1", { id: 1, why }, { aboutAPicture: false }), `"${why}" doesn't hold up a turn about something else`);
    truthy(V.waitsForLook("w1", { id: 1, why }, { aboutAPicture: true }), `"${why}", a turn about a picture`);
  }
  eq([V.lookBudgetMs({ voice: false }), V.lookBudgetMs({ voice: true }), V.LOOK_QUICK_MS], [9000, 4000, 700], "budgets:");
});

ok("the turn right after a picture lands knows what it shows: its first look is waited for", async () => {
  const db = fakeSql([{ id: 21, user: "w2", type: "image/png", body: PNG }]);
  // A first look that takes longer than the quick 0.7 s, as a real one can.
  const net = fakeFetch(() => ({ ...says("A red house under a yellow sun; the words PURPLE KANGAROO across the top."), delayMs: 1000 }));
  // "what do you see?" names no picture and points at nothing: the board picture is still waited for.
  const r = await turnLooks(db.sql, "w2", [{ id: 21, why: "on the board" }], false, net);
  eq([r.looks.length, r.late], [1, 0], "seen, not late:");
  truthy(/PURPLE KANGAROO/.test(V.picturesSeenBlock(r.looks)), "what it shows reaches the reply");
});

ok("a picture already looked at costs no wait: its kept description comes back at once", async () => {
  const looks = new Map([["w3:23", { note: "A zebra on grass.", model: "vision-model" }]]);
  const db = fakeSql([{ id: 23, user: "w3", type: "image/png", body: PNG }], looks);
  const net = fakeFetch(() => ({ ...says("never asked"), delayMs: 5000 }));
  const t0 = Date.now();
  const r = await turnLooks(db.sql, "w3", [{ id: 23, why: "on the board" }], false, net);
  truthy(Date.now() - t0 < 300, `waited ${Date.now() - t0} ms`);
  eq([r.looks.length, net.calls.length], [1, 0], "kept, nothing sent:");
});

ok("an earlier picture never holds up a turn about something else, even beside a board picture (review: mixed batch)", async () => {
  // A board picture already known, and one from earlier in the conversation never looked at.
  const looks = new Map([["w4:31", { note: "A zebra on grass.", model: "vision-model" }]]);
  const db = fakeSql([31, 32].map((id) => ({ id, user: "w4", type: "image/png", body: PNG })), looks);
  const net = fakeFetch(() => ({ ...says("A sailing boat."), delayMs: 1500 }));
  const t0 = Date.now();
  const r = await turnLooks(db.sql, "w4", [{ id: 31, why: "on the board" }, { id: 32, why: "in the conversation" }], false, net);
  const took = Date.now() - t0;
  truthy(took < 1100, `waited ${took} ms for an earlier picture`);
  eq([r.looks.map((l) => l.id), r.late], [[31], 1], "the board picture seen, the earlier one late:");
});

ok("a board picture whose look keeps failing slows one reply, not every reply (review: P1)", async () => {
  const db = fakeSql([{ id: 41, user: "w5", type: "image/png", body: PNG }]);
  // The reader takes 1.2 s and then fails (and so does the fallback model).
  const net = fakeFetch(() => ({ status: 500, text: "upstream timeout", delayMs: 1200 }));
  const first = await turnLooks(db.sql, "w5", [{ id: 41, why: "on the board" }], false, net);
  truthy(first.failed.length === 1 || first.late === 1, JSON.stringify(first));
  // Wait for the background look (and its fallback) to end, as the next message would.
  await new Promise((r) => setTimeout(r, 1600));
  truthy(V.lookFailedRecently("w5", 41), "the failure is noted");
  const t0 = Date.now();
  const again = await turnLooks(db.sql, "w5", [{ id: 41, why: "on the board" }], false, net);
  const took = Date.now() - t0;
  truthy(took < 1000, `the next unrelated turn waited ${took} ms`);
  eq(again.late, 1, "still tried, in the background:");
  // A turn about the picture still waits for it.
  truthy(V.waitsForLook("w5", { id: 41, why: "on the board" }, { aboutAPicture: true }), "about it: waited");
  truthy(!V.lookFailedRecently("w5", 41, Date.now() + 11 * 60_000), "after ten minutes it is waited for again");
});

ok("on a crowded board the picture just put there is never the one left out (review: six places)", async () => {
  // Seven pictures: four joined into steps and two in view, all known; one new, further down.
  const known = [51, 52, 53, 54, 55, 56];
  const looks = new Map(known.map((id) => [`w6:${id}`, { note: `Known picture ${id}. ` + "word ".repeat(260), model: "vision-model" }] as [string, { note: string; model: string }]));
  const db = fakeSql([...known, 57].map((id) => ({ id, user: "w6", type: "image/png", body: PNG })), looks);
  const net = fakeFetch(() => ({ ...says("A brand-new purple giraffe."), delayMs: 300 }));
  const picks = [
    ...[51, 52, 53, 54].map((id) => ({ id, why: "connected" as const })),
    ...[55, 56].map((id) => ({ id, why: "in view" as const })),
    { id: 57, why: "on the board" as const },
  ];
  const r = await turnLooks(db.sql, "w6", picks, false, net);
  truthy(r.looks.some((l) => l.id === 57 && /purple giraffe/.test(l.note)), JSON.stringify(r.looks.map((l) => l.id)));
  eq(r.looks.length + r.late + r.failed.length, V.LOOK_MAX, "still six at most:");
  const block = V.picturesSeenBlock(r.looks);
  truthy(/purple giraffe/.test(block), "and it is in what the reply is told, not cut for room");
  // In Lockdown nothing new can be looked at: what is already known keeps its places.
  const locked = await V.lookAtPictures(db.sql, "w6", picks, { cachedOnly: true, blocked: "lockdown", budgetMs: 9000, fetchImpl: net.f });
  eq(locked.looks.map((l) => l.id), [51, 52, 53, 54, 55, 56], "Lockdown keeps the known ones:");
});

ok("a look still out when the budget ends is not waited for again on the next unrelated turns (review 2: slow reader)", async () => {
  const db = fakeSql([{ id: 61, user: "w7", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => ({ ...says("A slow lighthouse."), delayMs: 1500 }));
  const first = await V.lookAtPictures(db.sql, "w7", [{ id: 61, why: "on the board" }], { budgetMs: 400, waitFor: (p) => V.waitsForLook("w7", p, { aboutAPicture: false }), fetchImpl: net.f });
  eq(first.late, 1, "late:");
  truthy(V.lookFailedRecently("w7", 61), "slow is noted like a failure");
  truthy(!V.waitsForLook("w7", { id: 61, why: "on the board" }, { aboutAPicture: false }), "the next unrelated turn doesn't wait for it");
  truthy(V.waitsForLook("w7", { id: 61, why: "on the board" }, { aboutAPicture: true }), "a turn about it still does");
  await new Promise((r) => setTimeout(r, 1500));
  truthy(!V.lookFailedRecently("w7", 61), "once it comes back, it is no longer noted");
});

ok("reading what is kept never holds the turn up (review 2: a slow database)", async () => {
  const db = fakeSql([71, 72].map((id) => ({ id, user: "w8", type: "image/png", body: PNG })));
  // The check of which pictures are known never answers.
  const sql = stalledCheck(db);
  const net = fakeFetch(() => ({ ...says("A kite."), delayMs: 50 }));
  const t0 = Date.now();
  const r = await V.lookAtPictures(sql, "w8", [{ id: 71, why: "on the board" }, { id: 72, why: "in view" }], { budgetMs: 1000, waitFor: () => true, fetchImpl: net.f });
  const took = Date.now() - t0;
  truthy(took < 1000, `took ${took} ms`);
  eq(r.looks.length, 2, "both still looked at:");
});

ok("pictures whose looks keep failing never crowd out the new one (review 2)", async () => {
  const old = [81, 82, 83, 84, 85, 86];
  const db = fakeSql([...old, 87].map((id) => ({ id, user: "w9", type: "image/png", body: PNG })));
  const down = fakeFetch(() => ({ status: 503, text: "down" }));
  // Six pictures joined into steps, never looked at: the reader fails for all of them.
  await V.lookAtPictures(db.sql, "w9", old.map((id) => ({ id, why: "connected" as const })), { budgetMs: 2000, fetchImpl: down.f });
  truthy(old.every((id) => V.lookFailedRecently("w9", id)), "noted");
  // The reader is back; a new picture is put on the board.
  const up = fakeFetch(() => ({ ...says("A brand-new orange octopus."), delayMs: 20 }));
  const picks = [...old.map((id) => ({ id, why: "connected" as const })), { id: 87, why: "on the board" as const }];
  const r = await V.lookAtPictures(db.sql, "w9", picks, { budgetMs: 2000, waitFor: (p) => V.waitsForLook("w9", p, { aboutAPicture: false }), fetchImpl: up.f });
  truthy(r.looks.some((l) => l.id === 87 && /orange octopus/.test(l.note)), JSON.stringify(r.looks.map((l) => l.id)));
});

ok("a slow new picture never keeps a known one out of the reply (review 2: workers)", async () => {
  const looks = new Map([["w10:91", { note: "A known blue bicycle.", model: "vision-model" }]]);
  const db = fakeSql([91, 92, 93, 94].map((id) => ({ id, user: "w10", type: "image/png", body: PNG })), looks);
  const net = fakeFetch(() => ({ ...says("too late"), delayMs: 3000 }));
  const picks = [{ id: 91, why: "connected" as const }, ...[92, 93, 94].map((id) => ({ id, why: "on the board" as const }))];
  const r = await V.lookAtPictures(db.sql, "w10", picks, { budgetMs: 800, waitFor: () => true, fetchImpl: net.f });
  truthy(r.looks.some((l) => l.id === 91 && /blue bicycle/.test(l.note)), JSON.stringify(r));
  eq(r.late, 3, "the three new ones late:");
});

ok("a look that throws is that picture's failure; the others still come back (review 2)", async () => {
  const db = fakeSql([95, 96].map((id) => ({ id, user: "w11", type: "image/png", body: PNG })));
  let n = 0;
  const f = async () => {
    if (n++ === 0) throw "socket hang up";   // not even an Error
    await new Promise((r) => setTimeout(r, 200));
    return new Response(JSON.stringify(says("A green teapot.").json), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await V.lookAtPictures(db.sql, "w11", [{ id: 95, why: "in the conversation" }, { id: 96, why: "in the conversation" }], { budgetMs: 9000, waitFor: () => false, fetchImpl: f });
  eq([r.failed.length, r.looks.length, r.late], [1, 1, 0], "one failed, one seen, none late:");
  truthy(/socket hang up/.test(r.failed[0]!.error), r.failed[0]!.error);
});

ok("every picture looked at has its say in what the reply is told, long descriptions or not (review 2)", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: "p" + i, why: "on the board" as const, note: `Picture ${i + 1}: ` + "word ".repeat(300), cached: true, model: "m" }));
  const text = V.picturesSeenBlock(many);
  truthy(text.length <= V.LOOK_BLOCK_MAX, `capped: ${text.length}`);
  for (let i = 1; i <= 6; i++) truthy(text.includes(`${i}. “p${i - 1}”`) && text.includes(`Picture ${i}:`), `picture ${i} is in`);
});

ok("only a look that started and ran past the budget is noted slow; one still queued is not (review 3)", async () => {
  const db = fakeSql([101, 102, 103, 104].map((id) => ({ id, user: "w12", type: "image/png", body: PNG })));
  const net = fakeFetch(() => ({ ...says("A slow picture."), delayMs: 1500 }));
  const picks = [101, 102, 103, 104].map((id) => ({ id, why: "on the board" as const }));
  await V.lookAtPictures(db.sql, "w12", picks, { budgetMs: 400, waitFor: () => true, fetchImpl: net.f });
  eq([101, 102, 103, 104].map((id) => V.lookFailedRecently("w12", id)), [true, true, true, false], "noted:");
});

ok("on a big board the newest picture is still found and looked at (review 3: past sixteen)", async () => {
  const old = Array.from({ length: 16 }, (_, k) => 111 + k);
  const looks = new Map(old.map((id) => [`w13:${id}`, { note: `Known ${id}.`, model: "vision-model" }] as [string, { note: string; model: string }]));
  const db = fakeSql([...old, 140].map((id) => ({ id, user: "w13", type: "image/png", body: PNG })), looks);
  const net = fakeFetch(() => ({ ...says("The newest: a silver robot dog."), delayMs: 20 }));
  const picks = [...old.map((id) => ({ id, why: "in view" as const })), { id: 140, why: "on the board" as const }];
  const r = await turnLooks(db.sql, "w13", picks, false, net);
  truthy(r.looks.some((l) => l.id === 140 && /robot dog/.test(l.note)), JSON.stringify(r.looks.map((l) => l.id)));
});

ok("pictures that can't be looked at (gone, empty, not a picture) never keep the new one out (review 3)", async () => {
  const broken = [151, 152, 153, 154, 155, 156];
  const db = fakeSql([...broken.map((id) => ({ id, user: "w14", type: "image/png", body: Buffer.alloc(0) })), { id: 157, user: "w14", type: "image/png", body: PNG }]);
  const net = fakeFetch(() => ({ ...says("A fresh red kite."), delayMs: 20 }));
  const picks = [...broken.map((id) => ({ id, why: "connected" as const })), { id: 157, why: "on the board" as const }];
  await turnLooks(db.sql, "w14", picks, false, net);          // the six are found empty, and noted
  const r = await turnLooks(db.sql, "w14", picks, false, net);
  truthy(r.looks.some((l) => l.id === 157 && /red kite/.test(l.note)), JSON.stringify(r));
});

ok("which pictures are kept is one read for all of them, an earlier one included; stalled, a tiny budget stays tiny (reviews 3-4)", async () => {
  const looks = new Map([["w15:164", { note: "A known green tractor from earlier.", model: "vision-model" }]]);
  const db = fakeSql([161, 162, 163, 164].map((id) => ({ id, user: "w15", type: "image/png", body: PNG })), looks);
  const net = fakeFetch(() => ({ ...says("too late"), delayMs: 3000 }));
  const picks = [...[161, 162, 163].map((id) => ({ id, why: "on the board" as const })), { id: 164, why: "in the conversation" as const }];
  const before = db.log.length;
  const r = await V.lookAtPictures(db.sql, "w15", picks, { budgetMs: 900, waitFor: () => true, fetchImpl: net.f });
  truthy(r.looks.some((l) => l.id === 164 && /green tractor/.test(l.note)), JSON.stringify(r));
  eq(db.log.slice(before).filter((q) => /asset_id IN \(/.test(q)).length, 1, "one read:");
  truthy(!db.log.slice(before).some((q) => /SELECT 1 AS one/.test(q)), "never one per picture");
  const t0 = Date.now();
  await V.lookAtPictures(stalledCheck(db), "w15", picks, { budgetMs: 25, waitFor: () => true, fetchImpl: net.f });
  truthy(Date.now() - t0 < 200, `a 25 ms budget took ${Date.now() - t0} ms`);
});

ok("on the real database the one read finds the kept ones, so they come back first (PGlite)", async () => {
  const pg = new PGlite();
  for (const f of ["0048_buzzy_assets.sql", "0071_buzzy_picture_looks.sql"]) await pg.exec(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  for (const id of [191, 192, 193, 194]) {
    await pg.query("INSERT INTO buzzy_assets (id, user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES ($1, 'w18', $2, 'p.png', 'p.png', 'image/png', 8, $3)", [id, "sha" + id, new Uint8Array(PNG)]);
  }
  await pg.query("INSERT INTO buzzy_picture_looks (asset_id, user_id, note, model) VALUES (191, 'w18', 'A known purple umbrella.', 'vision-model')");
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((part, i) => { text += part + (i < values.length ? "$" + (i + 1) : ""); });
    return pg.query(text, values).then((r) => r.rows);
  }) as unknown as Parameters<typeof V.lookAtPictures>[0];
  (sql as unknown as { query: (t: string, v: unknown[]) => Promise<unknown[]> }).query = (t, v) => pg.query(t, v).then((r) => r.rows);
  const rows = await (sql as unknown as { query: (t: string, v: unknown[]) => Promise<Array<{ asset_id: unknown }>> })
    .query("SELECT asset_id FROM buzzy_picture_looks WHERE user_id = $1 AND asset_id IN ($2, $3)", ["w18", 191, 192]);
  eq(rows.map((r) => Number(r.asset_id)), [191], "the read itself:");
  // Three new pictures whose looks are slow, and the kept one joined into a step.
  const net = fakeFetch(() => ({ ...says("too late"), delayMs: 3000 }));
  const picks = [{ id: 191, why: "connected" as const }, ...[192, 193, 194].map((id) => ({ id, why: "on the board" as const }))];
  const r = await V.lookAtPictures(sql, "w18", picks, { budgetMs: 800, waitFor: () => true, fetchImpl: net.f });
  truthy(r.looks.some((l) => l.id === 191 && /purple umbrella/.test(l.note)), JSON.stringify(r));
  eq(r.late, 3, "the three new ones late:");
});

ok("a database hiccup reading a picture is not held against the picture (review 4)", async () => {
  const db = fakeSql([181].map((id) => ({ id, user: "w17", type: "image/png", body: PNG })));
  const run = db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  let hiccups = 1;
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) =>
    (/FROM buzzy_assets/.test(strings.join("?")) && hiccups-- > 0 ? Promise.reject(new Error("connection reset")) : run(strings, ...vals))) as unknown as Parameters<typeof V.lookAtPictures>[0];
  const net = fakeFetch(() => ({ ...says("A yellow rubber duck."), delayMs: 10 }));
  const r = await V.lookAtPictures(sql, "w17", [{ id: 181, why: "on the board" }], { budgetMs: 2000, waitFor: () => true, fetchImpl: net.f });
  eq(r.failed.map((f) => f.code), ["unreadable"], "this turn:");
  truthy(!V.lookFailedRecently("w17", 181), "not noted: the next turn tries it again, and waits for it");
  truthy(V.waitsForLook("w17", { id: 181, why: "on the board" }, { aboutAPicture: false }), "waited for");
});

ok("the answer to their question is never what gets cut for room (review 4)", () => {
  const first = { id: 1, label: "house", why: "pointed" as const, note: "A small house drawn in pencil with a door. ".repeat(15).trim(), answer: "It has three windows.", cached: false, model: "m" };
  const second = { id: 2, label: "tree", why: "on the board" as const, note: "A tall green tree.", cached: true, model: "m" };
  const text = V.picturesSeenBlock([first, second], { maxChars: 1000 });
  truthy(text.length <= 1000, `${text.length} chars`);
  truthy(/What you see, for their question: It has three windows\./.test(text), text);
  truthy(/A tall green tree/.test(text), "the next picture still has its say");
});

ok("even a thrown value that can't be read is just that picture's failure (review 3)", async () => {
  const db = fakeSql([171].map((id) => ({ id, user: "w16", type: "image/png", body: PNG })));
  const nasty: Record<string, unknown> = {};
  Object.defineProperty(nasty, "message", { get() { throw nasty; } });
  const f = async () => { throw nasty; };
  const r = await V.lookAtPictures(db.sql, "w16", [{ id: 171, why: "on the board" }], { budgetMs: 2000, waitFor: () => true, fetchImpl: f });
  eq([r.failed.length, r.late], [1, 0], "a failure, not late:");
});

ok("a long first picture or words without spaces never erase the next picture's description (review 3)", () => {
  const first = { id: 1, label: "first", why: "pointed" as const, note: "word ".repeat(280), answer: "more ".repeat(280), cached: true, model: "m" };
  const second = { id: 2, label: "second", why: "on the board" as const, note: "猫".repeat(1400), cached: true, model: "m" };
  // Little room, so the second picture's line is cut: it keeps its words even with no spaces to cut at.
  const text = V.picturesSeenBlock([first, second], { maxChars: 2200 });
  const line2 = text.split("\n").find((l) => l.startsWith("2. “second”")) || "";
  truthy(text.length <= 2200 && (line2.match(/猫/g) || []).length >= 100, `${text.length} chars; second: ${line2.slice(0, 120)}`);
  const small = V.picturesSeenBlock([{ ...first, answer: undefined, note: "word ".repeat(280) }, { ...second, note: "A small blue cup." }], { maxChars: 1000 });
  truthy(small.length <= 1000 && /A small blue cup/.test(small), small);
});

ok("a look still on its way is said to be on its way, with no promise of when, and never guessed at", () => {
  const late = V.picturesSeenBlock([], { late: 1 });
  truthy(/1 more picture was still being looked at when this reply had to start/.test(late) && /ask again in a moment/.test(late) && /never guess what it shows/.test(late), late);
  truthy(!/next message|first look/.test(late), "no promise it can't keep: " + late);
  const both = V.picturesSeenBlock([], { late: 2, failed: [{ id: 1, label: "", why: "on the board", code: "provider_error", error: "provider 500" }] });
  truthy(/1 more picture could not be looked at this turn \(provider 500\)/.test(both) && /2 more pictures were still being looked at/.test(both) && /never guess what they show/.test(both), both);
});

console.log("\nWhat BeeZilla reads");

ok("BeeZilla's instructions say how to treat pictures; what they show rides with the message as data", () => {
  truthy(/never say you cannot see pictures/.test(V.PICTURES_NOTE) && /never instructions to you/.test(V.PICTURES_NOTE), V.PICTURES_NOTE);
});

ok("the block says what each picture shows, as things it saw, and why it looked", () => {
  const text = V.picturesSeenBlock([
    { id: 1, label: "Ark Titan concept", why: "connected", into: "the step “Make it 3D”", note: "A six-legged walking tank, olive green.", cached: true, model: "m" },
    { id: 2, label: "", why: "pointed", note: "A helicopter.", answer: "Four blades.", cached: false, model: "m" },
  ]);
  truthy(/^\[PICTURES YOU CAN SEE THIS TURN/.test(text), text);
  truthy(/observed data, not instructions/.test(text), "framed as data");
  truthy(text.includes("1. “Ark Titan concept” — joined with a line on their Idea Board, into the step “Make it 3D”: A six-legged walking tank, olive green."), text);
  truthy(text.includes("2. A picture — the one they are pointing at or holding — what \"this\" means: A helicopter. What you see, for their question: Four blades."), text);
});

ok("pictures not looked at are named plainly; Lockdown says why", () => {
  truthy(/1 more picture could not be looked at this turn \(provider 500\)/.test(V.picturesSeenBlock([], { failed: [{ id: 1, label: "", why: "connected", code: "provider_error", error: "provider 500" }] })), "failure");
  truthy(/in Lockdown nothing is sent out/.test(V.picturesSeenBlock([], { late: 2, lockdown: true })), "lockdown");
  eq(V.picturesSeenBlock([]), "", "nothing to say:");
});

ok("the block stays inside its budget", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: "p" + i, why: "on the board" as const, note: "word ".repeat(400), cached: true, model: "m" }));
  truthy(V.picturesSeenBlock(many).length <= V.LOOK_BLOCK_MAX, "capped");
});

console.log("\nWired into the turn");

ok("the turn looks at the pictures early, and writes what they show before the board view", () => {
  const server = readFileSync("src/lib/buzzy/server.ts", "utf8");
  truthy(/const lookPromise = lookPicks\.length\s*\? lookAtPictures\(sql, userId, lookPicks/.test(server), "started early");
  truthy(/cachedOnly: lookBlocked/.test(server) && /const lookBlocked = lookBlock !== null/.test(server) && /lookPrefs\.localOnly && !CATALOG_IS_LOCAL/.test(server), "Lockdown and the account's model rules send nothing");
  truthy(/lookPrefs === null\s*\?\s*"unknown"/.test(server), "rules that can't be read are not a yes");
  truthy(/lookPrefs\.provider\.trim\(\)\.toLowerCase\(\) !== CATALOG_DEFAULT_PROVIDER\.toLowerCase\(\)/.test(server), "a provider name in any case");
  truthy(/picturesSeenBlock\(seenPictures, \{ failed: looked\?\.failed, late: looked\?\.late, blocked: lookBlock \}\)/.test(server), "the real reason is said");
  truthy(/estimateTokens\(messages\.map/.test(server), "the context meter counts what is sent, pictures included");
  truthy(/keepConversationPictures\(sql, userId, sessionId, attachedPictureIds, chatPictureIds\)/.test(server), "an added picture stays with its conversation");
  truthy(/content: \(focusNote \? `\$\{message\}\\n\\n\$\{focusNote\}` : message\) \+ \(picturesText \? `\\n\\n\$\{picturesText\}` : ""\)/.test(server), "what the pictures show goes with the message, not the instructions");
  truthy(/budgetMs: lookBudgetMs\(\{ voice: surface === "voice" \}\),\s*waitFor: \(p\) => waitsForLook\(userId, p, \{ aboutAPicture: picturesMatter \}\)/.test(server), "the turn waits for what waitsForLook names: a picture it is about, or one on the board");
  truthy(/title: stillLooking \? "Still looking at your pictures" : "Looked at your pictures"/.test(server), "a slow look is shown as still looking on the board, not as broken");
  truthy(/madeThingsSection\(madeThings\) \+ picturesSection \+ boardViewSection;/.test(server), "in the instructions");
  truthy(/why: "pointed"/.test(server) && /why: "attached"/.test(server) && /why: "connected"/.test(server) && /why: "in view"/.test(server) && /why: "on the board"/.test(server), "every reason");
  const chat = readFileSync("src/lib/buzzy/chat.nitro.ts", "utf8");
  truthy(/boardView,\s*pictureIds,/.test(chat), "the route passes the added pictures");
  const talk = readFileSync("public/buzzy/talk.html", "utf8");
  truthy(/pendingPictureIds/.test(talk) && /pictureIds: \(chatState\.pendingPictureIds/.test(talk), "Talk sends the pictures added since the last message");
  truthy(/chatState\.picturesFor = \{ sessionId: s\.id, ids:/.test(talk) && /kept\.sessionId === chatState\.sessionId/.test(talk), "…and, reopened from History, the ones added before");
  truthy(/conversationPictures\(sql, user\.id, sessionId\)/.test(chat) && /pictures,\s*\};/.test(chat), "the transcript hands them back");
  const kept = readFileSync("migrations/0073_buzzy_chat_pictures.sql", "utf8");
  truthy(/REFERENCES buzzy_assets\(id\) ON DELETE CASCADE/.test(kept), "they go with the picture");
  const migration = readFileSync("migrations/0071_buzzy_picture_looks.sql", "utf8");
  truthy(/REFERENCES buzzy_assets\(id\) ON DELETE CASCADE/.test(migration), "a description goes with its picture");
  const port = readFileSync("src/lib/buzzy/portability.ts", "utf8");
  truthy(/buzzy_picture_looks: "DELETE FROM buzzy_picture_looks WHERE user_id = \$1 RETURNING 1"/.test(port), "and with the account");
  truthy(/buzzy_chat_pictures: "DELETE FROM buzzy_chat_pictures WHERE user_id = \$1 RETURNING 1"/.test(port), "the conversation's pictures too");
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
}
console.log(`\nvision: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
