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
import { takeBoardPictures, takeBoardSeen, boardReferencePrompt, BOARD_PICTURES_MAX } from "../src/lib/buzzy/pictureChange";

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
    graft(into: { cards: Card[]; links: Link[] }, from: { cards: Card[]; links: Link[] }) {
      return (sandbox.BeeZillaWhiteboard as { graft(a: unknown, b: unknown): { cards: Card[]; links: Array<Link & { user?: boolean }> } }).graft(into, from);
    },
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
// A stale clone can hand back a whiteboard.js from before instructionsFor() existed:
// loading it succeeds and the throw only lands inside the assert. Probe once here so
// "main is not comparable from this checkout" degrades to the skipped path instead.
if (before) { try { before.summary([]); } catch { before = null; } }

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
  // The label moved once (owner, 2026-11-20: "People aren't going to know what an
  // agent.md is") and main carries the new wording now, so a one-way shim made the
  // comparison fail on CI where origin/main is the commit under test. Hold BOTH
  // sides to one token: the assert is about everything except the wording, and the
  // wording itself is pinned below.
  const labelStep = (t: string) => t.replace(/^(?:Core identity \(how BeeZilla works here\)|agent\.md \(how to work\)): /gm, "AGENT STEP: ");
  // The one addition with no lines: every picture is named on a line the server takes
  // off before the model reads the board (takeBoardSeen), so BeeZilla can look at it.
  const unseen = (t: string) => t.replace(/^\[\[board-seen: [^\]\n]*\]\]\n/, "");
  for (const b of boards) {
    const text = unseen(now.summary(b));
    if (before) eq(labelStep(text), labelStep(before.summary(b)), "same as main:");
    truthy(!/Connected to BeeZilla/.test(text), "no Connected section without lines");
    truthy(!/\[\[board-pictures/.test(text), "no pictures line without lines");
  }
  // The wording itself is product copy: pin it, so a silent re-rename fails here.
  truthy(now.summary([{ ...agent, body: "Be brief", user: true }]).includes("Core identity (how BeeZilla works here): Be brief"),
    "the step is still called Core identity");
  // A long board without lines is cut where main cuts it.
  const many: Card[] = Array.from({ length: 24 }, (_, i) => ({ id: "z" + i, kind: "note", title: "Idea " + i, body: "word ".repeat(60), x: 0, y: i * 150 }));
  if (before) eq(now.summary(many), before.summary(many), "a long board, cut at the same place:");
  truthy(now.summary(many).length <= 4000, "no lines: at most 4,000 characters, as on main");
  // Lines that lead to no step add only how the cards are joined (testers, 2026-11-24:
  // "it should understand the sequence of how they're connected"); the rest is main's.
  const noStep = now.summary([note, photo, web], [L("n", "p"), L("p", "w")]);
  truthy(noStep.includes("1) Note “Palette” → Picture “beach.jpg” → Link “Fair poster ideas”"), noStep);
  const withoutFlow = unseen(noStep).replace(/^How the cards are joined[^\n]*\n(?:\d+\) [^\n]*\n)+\n/, "");
  if (before) eq(withoutFlow, before.summary([note, photo, web], [L("n", "p"), L("p", "w")]), "lines between things only, apart from the flow:");
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

ok("every picture on the board is named for the server to look at, joined ones first", () => {
  const pics: Card[] = [1, 2, 3].map((i) => ({ id: "v" + i, kind: "image", title: `view ${i}.png`, url: `/api/buzzy/assets/${200 + i}`, contentType: "image/png", x: i * 300, y: 0 }));
  const madePic: Card = { id: "m", kind: "image", title: "art-2026-11-20-abc.png", url: "/api/buzzy/assets/299", contentType: "image/png", x: 50, y: 900 };
  const webPic: Card = { id: "o", kind: "image", title: "far.png", url: "https://example.com/far.png", x: 0, y: 2000 };
  const loose = now.summary([...pics, madePic, webPic]);
  eq(loose.split("\n")[0], "[[board-seen: 299:made here; 201:view 1.png; 202:view 2.png; 203:view 3.png]]", "board order (left to right), made ones by kind:");
  const joined = now.summary([skill, ...pics], [L("v3", "s")]);
  eq(joined.split("\n")[0], "[[board-pictures: 203]]", "the joined picture is still the one to draw from:");
  eq(joined.split("\n")[1], "[[board-seen: 203:view 3.png; 201:view 1.png; 202:view 2.png]]", "joined first, then the rest:");
  const tricky: Card = { id: "t", kind: "image", title: "a; b: [c]]", url: "/api/buzzy/assets/7", contentType: "image/png", x: 0, y: 0 };
  eq(now.summary([tricky]).split("\n")[0], "[[board-seen: 7:a b c]]", "names can't break the line:");
  const nine: Card[] = Array.from({ length: 9 }, (_, i) => ({ id: "n" + i, kind: "image", title: `n${i}`, url: `/api/buzzy/assets/${300 + i}`, contentType: "image/png", x: i * 10, y: 0 }));
  eq((now.summary(nine).split("\n")[0].match(/\d+:/g) || []).length, 8, "at most eight:");
});

ok("the order follows the lines, not where the cards sit (testers: \"the sequence of how they're connected\")", () => {
  // Concept art at the start of a string of cards, laid out right to left and up and down.
  const concept: Card = { id: "c", kind: "image", title: "Ark Titan concept", url: "/api/buzzy/assets/55", contentType: "image/png", x: 900, y: 0 };
  const s1: Card = { id: "s1", kind: "skill", title: "Look closely at the concept art", body: "List every part, colour and material", user: true, x: 600, y: 400 };
  const s2: Card = { id: "s2", kind: "skill", title: "Make it a 3D model", body: "Keep the shape of the concept art", user: true, x: 0, y: 0 };
  const s3: Card = { id: "s3", kind: "skill", title: "Check the textures", body: "Every face has colour", user: true, x: 300, y: 800 };
  const text = now.summary([s3, s2, concept, s1], [L("c", "s1"), L("s1", "s2"), L("s2", "s3")]);
  const steps = text.split("\n").filter((l) => /^Step \d/.test(l));
  eq(steps.map((l) => l.replace(/:.*/, "")), ["Step 1 — Look closely at the concept art", "Step 2 — Make it a 3D model", "Step 3 — Check the textures"], "steps in line order:");
  truthy(/How the cards are joined — the order the work flows in/.test(text), text);
  truthy(text.includes("1) Picture “Ark Titan concept” → Skill “Look closely at the concept art” → Skill “Make it a 3D model” → Skill “Check the textures”"), text);
  // A fork reads as drawn: one chain, then the branch.
  const fork = now.summary([s1, s2, s3], [L("s1", "s2"), L("s1", "s3")]);
  truthy(/1\) Skill “Look closely at the concept art” → Skill “Make it a 3D model”\n2\) Skill “Look closely at the concept art” → Skill “Check the textures”/.test(fork), fork);
  // Without lines, board order as before.
  const plain = now.summary([s3, s2, s1]).split("\n").filter((l) => /^Step \d/.test(l)).map((l) => l.replace(/:.*/, ""));
  eq(plain, ["Step 1 — Make it a 3D model", "Step 2 — Check the textures", "Step 3 — Look closely at the concept art"], "no lines: left to right:");
  // A loop of lines can't be ordered, and still lists every card once.
  const loop = now.summary([s1, s2], [L("s1", "s2"), L("s2", "s1")]);
  eq(loop.split("\n").filter((l) => /^Step \d/.test(l)).length, 2, "a loop keeps both steps:");
});

ok("a line the person drew between two of BeeZilla's cards is theirs, and counts (independent review, 2026-11-25)", () => {
  // Two steps BeeZilla drew as it worked (neither is the person's card).
  const look: Card = { id: "g1", kind: "skill", flow: "skill:look", title: "Looked at your pictures", x: 0, y: 0 };
  const make: Card = { id: "g2", kind: "skill", flow: "skill:model3d", title: "3D maker", x: 300, y: 0 };
  const drawn = now.summary([look, make], [{ ...L("g1", "g2"), user: true } as Link]);
  truthy(drawn.includes("1) Skill “Looked at your pictures” → Skill “3D maker”"), drawn);
  // The same line drawn by BeeZilla as it worked: a record of a past turn, not their order.
  const auto = now.summary([look, make], [L("g1", "g2")]);
  truthy(!/How the cards are joined/.test(auto), auto);
  // Carried from the board in front of a new conversation into the conversation's own: still theirs.
  const carried = now.graft({ cards: [], links: [] }, { cards: [look, make], links: [{ ...L("g1", "g2"), user: true } as Link] });
  eq(carried.links.map((l) => l.user === true), [true], "carried:");
  // An FBX copy dragged onto the board is a 3D model.
  const fbx: Card = { id: "f", kind: "file", title: "model-1234abcd.fbx", url: "/api/buzzy/assets/77", contentType: "model/fbx", x: 0, y: 300 };
  truthy(/3D model “model-1234abcd\.fbx”|3D model/.test(now.summary([fbx])), now.summary([fbx]));
  // The account keeps who drew a line, and nothing else new.
  const c = cleanWhiteboard({ v: 2, cards: [look, make], links: [{ ...L("g1", "g2"), user: true, secret: "x" }, L("g2", "g1")] });
  truthy(c.ok, "clean");
  if (!c.ok) return;
  eq(c.state.links.map((l) => (l as Record<string, unknown>).user ?? null), [true, null], "kept:");
  truthy(!("secret" in (c.state.links[0] as Record<string, unknown>)), "nothing else");
});

console.log("\nThe server's side");

ok("takeBoardSeen takes the seen line off (first or second) and keeps ids and names", () => {
  const both = takeBoardSeen(takeBoardPictures("[[board-pictures: 12]]\n[[board-seen: 12:Ark Titan; 40:made here]]\nStep 1 — x").text);
  eq(both.seen, [{ id: 12, label: "Ark Titan" }, { id: 40, label: "" }], "ids and names:");
  eq(both.text, "Step 1 — x", "the rest:");
  const alone = takeBoardSeen("[[board-seen: 9:helicopter]]\nAlso on the board:");
  eq(alone.seen, [{ id: 9, label: "helicopter" }], "first line:");
  eq(alone.text, "Also on the board:", "taken off:");
  eq(takeBoardSeen("Note — [[board-seen: 7:x]]").seen, [], "only the first two lines count:");
  eq(takeBoardSeen("[[board-seen: 1:a; x:b; 0:c; 2]]").seen, [{ id: 1, label: "a" }, { id: 2, label: "" }], "only real ids:");
  eq(takeBoardSeen(undefined).text, "", "nothing is nothing:");
});

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
  truthy(/const boardSeen = takeBoardSeen\(board\.text\);/.test(src) && /boardText = boardSeen\.text/.test(src), "the model gets the text without the lines");
  truthy(/WHERE user_id = \$\{userId\} AND id = \$\{id\}/.test(src), "connected pictures load by the person's own user id");
  truthy(/boardPictureChange/.test(src) && /Drawing from your board/.test(src), "a change or a new picture from the board");
  truthy(/isPictureChange\(message\) && LOOKS\.test\(message\)/.test(src), "a connected picture changes only when the words are about how it looks");
  truthy(/pictureToChange && !boardPictureChange/.test(src) && /could not be read/.test(src), "an unreadable connected picture never falls back to another one, and the reply says so");
  const chat = readFileSync("src/lib/buzzy/chat.nitro.ts", "utf8");
  truthy(/body\.boardInstructions\.slice\(0, 8200\)/.test(chat), "the route keeps the longer summary");
});

console.log(`\nboard connect: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
