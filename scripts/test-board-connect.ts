/**
 * Connect and share on the Idea Board (owner, 2026-11-20, after "/space" — Slashspace,
 * Flowith, Poppy): "create the same connectors and node system, but within our own
 * framework… cordon off a little piece of what they do, or an entire whiteboard… sell
 * this as an orchestration."
 *
 *   - A line into one of BeeZilla's steps (agent.md, a skill, the end result, the
 *     conversation) sends what it brings in full, under that step, with the next
 *     message; lines chain; an area brings what is inside it; a step's own inputs stay
 *     under it; a thing reached twice counts once; nothing is listed twice.
 *   - With no lines the summary is exactly what it was before (checked against main's
 *     whiteboard.js on the same boards).
 *   - Connected pictures of the person's own Library are named on a first line the
 *     server takes off (takeBoardPictures) and draws from; at most four, ids only.
 *   - An area's size and its "Sell this orchestration" choice survive the account's
 *     cleaning (whiteboards.ts), and nothing else new does.
 *
 *   npx tsx scripts/test-board-connect.ts
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cleanWhiteboard } from "../src/lib/buzzy/whiteboards";
import { takeBoardPictures, boardReferencePrompt, BOARD_PICTURES_MAX } from "../src/lib/buzzy/pictureChange";

let pass = 0;
let fail = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

type Card = Record<string, unknown> & { id: string; x: number; y: number };
type Link = { id: string; from: string; to: string };
type Api = { instructionsFor(id: string): string };

function boardCode(source: string) {
  const store = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    console,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: () => Promise.reject(new TypeError("offline")),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "whiteboard.js" });
  const api = sandbox.BeeZillaWhiteboard as Api;
  let n = 0;
  return {
    summary(cards: Card[], links: Link[] = []) {
      const id = "b" + ++n;
      store.set("bz.board." + id, JSON.stringify({ v: 2, cards, links, view: { x: 0, y: 0, z: 1 }, sync: { rev: null, dirty: false, base: null } }));
      return api.instructionsFor(id);
    },
  };
}

const now = boardCode(readFileSync("public/buzzy/whiteboard.js", "utf8"));
let before: ReturnType<typeof boardCode> | null = null;
try {
  before = boardCode(execFileSync("git", ["show", "upstream/main:public/buzzy/whiteboard.js"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch {
  try { before = boardCode(execFileSync("git", ["show", "origin/main:public/buzzy/whiteboard.js"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { before = null; }
}

const L = (from: string, to: string): Link => ({ id: `l-${from}-${to}`, from, to });
const longNote = "Use the warm palette from the beach photo. " + "Keep the horizon low and the sky wide. ".repeat(12);

const agent: Card = { id: "a", kind: "agent", title: "agent.md", body: "", x: 400, y: 0 };
const skill: Card = { id: "s", kind: "skill", title: "Draw the poster", body: "", x: 700, y: 0 };
const end: Card = { id: "e", kind: "document", title: "End result", body: "A poster for the fair", user: true, x: 1000, y: 0 };
const note: Card = { id: "n", kind: "note", title: "Palette", body: longNote, x: 0, y: 0 };
const photo: Card = { id: "p", kind: "photo", title: "beach.jpg", url: "/api/buzzy/assets/12", contentType: "image/jpeg", x: 0, y: 200 };
const made: Card = { id: "m", kind: "image", title: "art-2026-11-20-10-00-00.png", url: "/api/buzzy/assets/40", contentType: "image/png", x: 1300, y: 0 };
const web: Card = { id: "w", kind: "file", title: "Fair poster ideas", url: "https://example.com/ideas", x: 0, y: 400 };
const song: Card = { id: "t", kind: "track", title: "music-2026-11-20-10-00-00.mp3", url: "/api/buzzy/assets/41", contentType: "audio/mpeg", x: 0, y: 600 };

console.log("Lines into BeeZilla's steps");

ok("with no lines, the summary is exactly main's, on every board", () => {
  if (!before) { console.log("       (main's whiteboard.js not reachable here; compared with the expected text instead)"); }
  const boards: Card[][] = [
    [],
    [note, photo, web, song, made],
    [agent, skill, { ...end }, note, photo],
    [{ ...agent, body: "Be brief", user: true }, { ...skill, body: "Sketch first", user: true }, end, { ...note, user: true }, made, web],
  ];
  // The one intended difference from main: agent.md reads "Core identity" now
  // (owner, 2026-11-20: "People aren't going to know what an agent.md is").
  const renamed = (t: string) => t.replace(/^Core identity \(how BeeZilla works here\): /gm, "agent.md (how to work): ");
  for (const b of boards) {
    const text = now.summary(b);
    if (before) eq(renamed(text), before.summary(b), "same as main:");
    truthy(!/Connected to BeeZilla/.test(text), "no Connected section without lines");
    truthy(!/\[\[board-pictures/.test(text), "no pictures line without lines");
  }
  // A long board without lines is cut where main cuts it.
  const many: Card[] = Array.from({ length: 24 }, (_, i) => ({ id: "z" + i, kind: "note", title: "Idea " + i, body: "word ".repeat(60), x: 0, y: i * 150 }));
  if (before) eq(now.summary(many), before.summary(many), "a long board, cut at the same place:");
  truthy(now.summary(many).length <= 4000, "no lines: at most 4,000 characters, as on main");
  // Lines that lead to no step change nothing either.
  const noStep = now.summary([note, photo, web], [L("n", "p"), L("p", "w")]);
  if (before) eq(noStep, before.summary([note, photo, web], [L("n", "p"), L("p", "w")]), "lines between things only:");
});

ok("a note joined to a step goes in full under that step, and not again below", () => {
  const text = now.summary([agent, skill, end, note, web], [L("n", "s")]);
  truthy(/Connected to BeeZilla's steps — use these where they are joined:/.test(text), text);
  truthy(/Into the step “Draw the poster”:\n- Note — Palette: Use the warm palette/.test(text), text);
  truthy(text.includes(longNote.replace(/\s+/g, " ").trim().slice(0, 400)), "the note is not cut at 240 characters");
  const also = text.split("Also on the board:")[1] || "";
  truthy(!/Palette/.test(also), "the connected note is not listed again under Also on the board");
  truthy(/Link — Fair poster ideas \(https:\/\/example.com\/ideas\)/.test(also), "the rest of the board is still there");
});

ok("the person's own note joined to a step is written out under the step, not above it", () => {
  const own: Card = { ...note, user: true };
  const text = now.summary([skill, own], [L("n", "s")]);
  truthy(!/^Note — /m.test(text), "not among the general instructions");
  truthy(/Into the step “Draw the poster”:\n- Note — Palette: Use the warm palette/.test(text), text);
  const free = now.summary([skill, own]);
  truthy(/^Note — Use the warm palette/m.test(free), "without a line it stays an instruction, as before");
});

ok("lines chain: a note into a picture into a step brings both, nearest first by place", () => {
  const text = now.summary([skill, note, photo], [L("n", "p"), L("p", "s")]);
  const block = text.split("Into the step “Draw the poster”:")[1] || "";
  truthy(/- Note — Palette/.test(block) && /- Picture — beach\.jpg/.test(block), text);
  eq(text.split("\n")[0], "[[board-pictures: 12]]", "the connected picture is named for the server:");
});

ok("a step's own inputs stay under it: a note into agent.md is not repeated for the next step", () => {
  const text = now.summary([agent, skill, note], [L("n", "a"), L("a", "s")]);
  truthy(/Into the core identity:\n- Note — Palette/.test(text), text);
  truthy(!/Into the step/.test(text), "the skill brings nothing of its own");
});

ok("a thing reached twice counts once per step, and is named, not repeated, under a second step", () => {
  const text = now.summary([skill, end, note, photo], [L("n", "s"), L("n", "p"), L("p", "s"), L("n", "e")]);
  const first = (text.split("Into the step “Draw the poster”:")[1] || "").split("Into ")[0];
  eq((first.match(/Note — Palette/g) || []).length, 1, "once under the skill:");
  truthy(/Into the end result “End result”:\n- Note — Palette \(listed above\)/.test(text), text);
});

ok("an area joined to a step brings what is inside it, never itself", () => {
  const area: Card = { id: "ar", kind: "area", title: "Mood", x: -30, y: -40, w: 280, h: 720, user: true };
  const text = now.summary([area, end, note, photo, web, song], [L("ar", "e")]);
  const block = text.split("Into the end result “End result”:")[1] || "";
  for (const want of ["Note — Palette", "Picture — beach.jpg", "Link — Fair poster ideas", "Music made here"]) truthy(block.includes(want), `${want} in ${block}`);
  truthy(!/Mood|Area/.test(text), "the area itself is not a thing on the list");
  truthy(!/art-2026|music-2026|\/api\/buzzy\/assets/.test(text), "made files go by kind; no file names or asset paths");
});

ok("an area outside any line brings nothing; a card moved out of it is out", () => {
  const area: Card = { id: "ar", kind: "area", title: "Mood", x: -30, y: -40, w: 280, h: 300, user: true };
  const text = now.summary([area, end, note, photo, web], [L("ar", "e")]);
  const block = (text.split("Into the end result “End result”:")[1] || "").split("Also on the board:")[0];
  truthy(/Note — Palette/.test(block) && /beach\.jpg/.test(block), "inside: the note at y 0 and the photo at y 200");
  truthy(!/Fair poster ideas/.test(block), "outside: the link at y 400");
});

ok("the conversation card counts as a step where the page has one", () => {
  const chat: Card = { id: "chat", kind: "chat", title: "Conversation", x: 300, y: 300 };
  const text = now.summary([chat, web], [L("w", "chat")]);
  truthy(/Into the conversation:\n- Link — Fair poster ideas/.test(text), text);
});

ok("pictures from the person's Library only, at most four, the first line only", () => {
  const pics: Card[] = [1, 2, 3, 4, 5].map((i) => ({ id: "q" + i, kind: "image", title: `p${i}.png`, url: `/api/buzzy/assets/${100 + i}`, contentType: "image/png", x: i * 10, y: i * 300 }));
  const outside: Card = { id: "o", kind: "image", title: "far.png", url: "https://example.com/far.png", x: 0, y: 2000 };
  const text = now.summary([skill, ...pics, outside], [...pics.map((p) => L(p.id, "s")), L("o", "s")]);
  eq(text.split("\n")[0], "[[board-pictures: 101,102,103,104]]", "first four, in order:");
  eq((text.match(/\[\[board-pictures/g) || []).length, 1, "one pictures line:");
  truthy(/Picture — far\.png/.test(text), "a web picture is listed, but is not one the server can load");
});

ok("a long board stays under the cap, and the pictures line is never cut off", () => {
  const many: Card[] = Array.from({ length: 30 }, (_, i) => ({ id: "x" + i, kind: "note", title: "N" + i, body: "w ".repeat(700), x: 0, y: i * 200 }));
  const text = now.summary([skill, photo, ...many], [L("p", "s"), ...many.map((c) => L(c.id, "s"))]);
  truthy(text.startsWith("[[board-pictures: 12]]\n"), "pictures first");
  truthy(text.length <= 7800 + 40, `capped (${text.length})`);
});

ok("who it serves comes first, in their words, and is never a connected thing", () => {
  const who: Card = { id: "w1", kind: "person", title: "Who it serves", body: "A bakery owner in Lisbon who likes short answers", user: true, x: 900, y: 600 };
  const text = now.summary([who, { ...skill, body: "Sketch first", user: true }, note], [L("w1", "s"), L("n", "s")]);
  truthy(text.startsWith("Who it serves: A bakery owner in Lisbon"), text);
  const block = text.split("Into the step “Draw the poster”:")[1] || "";
  truthy(!/Who it serves/.test(block) && /Note — Palette/.test(block), "joined to a step, it is still read as who BeeZilla works for, once");
});

ok("a drawing is a thing on the board, by what it should become", () => {
  const sk: Card = { id: "d1", kind: "sketch", title: "Drawing", body: "a castle at sunset", drawing: "[]", user: true, x: 0, y: 0 };
  const text = now.summary([skill, sk], [L("d1", "s")]);
  truthy(/Into the step “Draw the poster”:\n- Drawing they added — Drawing: a castle at sunset/.test(text), text);
});

console.log("\nThe server's side");

ok("takeBoardPictures takes the first line off and keeps the ids", () => {
  const t = takeBoardPictures("[[board-pictures: 12, 40,12, 0]]\nConnected to BeeZilla's steps — use these where they are joined:\n- Note");
  eq(t.ids, [12, 40], "ids:");
  truthy(t.text.startsWith("Connected to BeeZilla's steps"), t.text);
  eq(takeBoardPictures("[[board-pictures: 1,2,3,4,5,6]]").ids.length, BOARD_PICTURES_MAX, "at most four:");
  eq(takeBoardPictures("[[board-pictures: 1; DROP]]\nx").ids, [], "anything but numbers: not a pictures line:");
  eq(takeBoardPictures("Note — [[board-pictures: 7]]").ids, [], "only the first line counts:");
  eq(takeBoardPictures("Note — [[board-pictures: 7]]").text, "Note — [[board-pictures: 7]]", "the rest is untouched:");
  eq(takeBoardPictures(undefined).text, "", "nothing is nothing:");
  truthy(/attached picture from the person's board/.test(boardReferencePrompt("draw a poster", 1)), "one reference");
  truthy(/the 3 attached pictures/.test(boardReferencePrompt("draw a poster", 3)), "several references");
});

ok("an area's size and its share choice are kept by the account; nothing else new is", () => {
  const c = cleanWhiteboard({
    v: 2,
    cards: [{ id: "ar", kind: "area", title: "Poster kit", x: 1, y: 2, w: 640, h: 380, share: "open", examples: "yes", shareAt: "2026-11-20T18:00:00.000Z", price: 99, secret: "x" }],
    links: [],
  });
  truthy(c.ok, "clean");
  if (!c.ok) return;
  const card = c.state.cards[0]!;
  eq([card.w, card.h, card.share, card.examples, card.shareAt], [640, 380, "open", "yes", "2026-11-20T18:00:00.000Z"], "kept:");
  truthy(!("price" in card) && !("secret" in card), "unknown fields are dropped");
});

ok("server.ts reads the pictures line before the model sees the board, and draws from them", () => {
  const src = readFileSync("src/lib/buzzy/server.ts", "utf8");
  truthy(/const board = takeBoardPictures\(/.test(src), "takeBoardPictures on the board text");
  truthy(/boardText = board\.text/.test(src), "the model gets the text without the line");
  truthy(/WHERE user_id = \$\{userId\} AND id = \$\{id\}/.test(src), "connected pictures load by the person's own user id");
  truthy(/boardPictureChange/.test(src) && /Drawing from your board/.test(src), "a change or a new picture from the board");
  truthy(/isPictureChange\(message\) && LOOKS\.test\(message\)/.test(src), "a connected picture changes only when the words are about how it looks");
  truthy(/pictureToChange && !boardPictureChange/.test(src) && /could not be read/.test(src), "an unreadable connected picture never falls back to another one, and the reply says so");
  const chat = readFileSync("src/lib/buzzy/chat.nitro.ts", "utf8");
  truthy(/body\.boardInstructions\.slice\(0, 8200\)/.test(chat), "the route keeps the longer summary");
});

console.log(`\nboard connect: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
