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
  return { sql, log, looks };
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
  truthy(/budgetMs: !picturesMatter \? 700 :/.test(server), "a turn not about a picture doesn't wait for new pictures to be looked at");
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
