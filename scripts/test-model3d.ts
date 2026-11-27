/**
 * 3D models from their pictures, textured, with a clean mesh (testers, 2026-11-24: concept
 * art came back as "normal, realistic army looking tanks", stage lights and bookshelves,
 * "textureless", "a soup of triangles").
 *
 *   - What a model is made from: the picture pointed at, added, joined into the step or
 *     named ("the helicopter"); with nothing of its own in the words, the picture in play;
 *     else words rewritten into one object, never the sentence as typed.
 *   - The Meshy requests follow Meshy's documented API (docs.meshy.ai, read 2026-11-24):
 *     Image to 3D / Multi-Image to 3D with the picture, its look kept; Text to 3D shape then
 *     paint; textured with PBR; quad remesh at ~30k faces; low-poly, detailed and print.
 *   - The poll moves a job along: a shape gets its paint, a bare model is painted again
 *     once, and a .glb is checked for a texture before it is kept.
 *
 *   npx tsx scripts/test-model3d.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

process.env.BZ_MESHY_KEY = "msy_test";

const M = await import("../src/lib/buzzy/models3d");
const P = await import("../src/lib/buzzy/model3dPlan");

// The jobs go to a database of the test's own, in memory, empty on every run — never the
// one DATABASE_URL names. `failInserts` makes the next writes of a job fail (a hiccup).
const pg = new PGlite();
await pg.exec(readFileSync(join(process.cwd(), "migrations", "0072_buzzy_model3d_jobs.sql"), "utf8"));
let failInserts = 0;
const jobsSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  let text = "";
  strings.forEach((s, i) => { text += s + (i < values.length ? "$" + (i + 1) : ""); });
  if (failInserts > 0 && /^\s*INSERT INTO buzzy_model3d_jobs/.test(text)) { failInserts--; return Promise.reject(new Error("database hiccup")); }
  return pg.query(text, values).then((r) => r.rows);
}) as unknown;
M.__setModelSqlForTests(async () => jobsSql as Awaited<ReturnType<typeof import("../src/lib/db").getSql>>);

let pass = 0;
let fail = 0;
const tests: Array<[string, () => unknown]> = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const PIC = "data:image/png;base64,iVBORw0KGgo=";
const look = (id: number, label: string, note: string) => ({ id, label, why: "on the board" as const, note, cached: true, model: "m" });
// Not plain which picture: nothing is started; the reply asks (and names the candidates).
const asks = (c: unknown, names?: string[]) => {
  const a = c as { ask?: boolean; candidates?: Array<{ name: string }> } | null;
  if (!a || a.ask !== true) throw new Error("expected a question, got " + JSON.stringify(c));
  if (names) eq(a.candidates!.map((x) => x.name), names, "asks about:");
};

console.log("What a model is made from");

ok("the picture they point at, add or join wins — in that order", () => {
  const base = { message: "make it a 3D model", seen: [], onBoard: [], newestMade: null };
  eq(P.choosePictures({ ...base, pointed: 7, attached: [8], connected: [9] })?.ids, [7], "pointed:");
  eq(P.choosePictures({ ...base, pointed: null, attached: [8], connected: [9] })?.ids, [8], "added:");
  eq(P.choosePictures({ ...base, pointed: null, attached: [], connected: [9] })?.why, "connected", "joined:");
});

ok("\"take a look at the helicopter … make it a 3D model\" finds the picture of a helicopter by what is in it", () => {
  const seen = [look(1, "IMG_2041.png", "A city street at night."), look(2, "IMG_2042.png", "A green military helicopter, side view, two rotors.")];
  const c = P.choosePictures({ message: "Take a look at the helicopter in front of you and make it a three D model", pointed: null, attached: [], connected: [], seen, onBoard: [1, 2], newestMade: null });
  eq(c?.ids, [2], "the helicopter:");
  eq(c?.why, "named", "why:");
});

ok("a picture they added or point at wins over a guess (independent review, 2026-11-25)", () => {
  const heli = look(8, "IMG_0042.jpg", "A green military helicopter, side view, two rotors.");
  // "from my uploaded helicopter photo", the photo just added: that photo, never words.
  eq(P.choosePictures({ message: "Make a 3D model from my uploaded helicopter photo", pointed: null, attached: [8], connected: [], seen: [heli], onBoard: [], newestMade: null })?.ids, [8], "the photo they added:");
  // Pointing at the helicopter while photos named as views sit joined nearby: the helicopter.
  const views = [look(21, "front view", "A red car from the front."), look(22, "side view", "A red car from the side.")];
  const seen = [look(7, "helicopter", "A helicopter."), ...views];
  eq(P.choosePictures({ message: "Make this a 3D model", pointed: 7, attached: [], connected: [21, 22], seen, onBoard: [7, 21, 22], newestMade: null })?.ids, [7], "what they point at:");
  // …unless the words ask for the views.
  eq(P.choosePictures({ message: "Make a 3D model from the front and side views", pointed: 7, attached: [], connected: [21, 22], seen, onBoard: [7, 21, 22], newestMade: null })?.ids, [21, 22], "the views, when asked for:");
  // A look is not another thing ("in gold"); a picture not looked at yet can't be told apart.
  eq(P.choosePictures({ message: "Make a 3D model in gold", pointed: null, attached: [8], connected: [], seen: [heli], onBoard: [], newestMade: null })?.ids, [8], "a look:");
  eq(P.choosePictures({ message: "make a 3D model of my dog", pointed: null, attached: [9], connected: [], seen: [], onBoard: [], newestMade: null })?.ids, [9], "not seen yet:");
  // Another thing named, which the added picture plainly is not: which one is meant isn't plain — ask.
  asks(P.choosePictures({ message: "make a 3D model of a red dragon", pointed: null, attached: [8], connected: [], seen: [heli], onBoard: [], newestMade: null }), ["IMG_0042.jpg"]);
});

ok("only words that ask for views send several pictures; the right one of several is picked (second review)", () => {
  const legs = [look(41, "IMG_1.jpg", "A wooden table leg."), look(42, "IMG_2.jpg", "A wooden table top, round.")];
  const top = P.choosePictures({ message: "Make a 3D model of a table top", pointed: null, attached: [], connected: [41, 42], seen: legs, onBoard: [41, 42], newestMade: null });
  eq(top && "ids" in top ? top.ids : top, [42], "the table top, alone:");
  truthy(!P.asksForViews("the back of the chair") && !P.asksForViews("a table top") && P.asksForViews("from the front and side views") && P.asksForViews("make it from these views"), "views asked for");
  // A beach photo, then a car photo, added together: "the car" is the car.
  const two = [look(51, "IMG_a.jpg", "A sandy beach with palm trees."), look(52, "IMG_b.jpg", "A red sports car, side view.")];
  eq(P.choosePictures({ message: "make a 3D model of the car", pointed: null, attached: [51, 52], connected: [], seen: two, onBoard: [], newestMade: null })?.ids, [52], "the car, not the first:");
  // A car photo from earlier in the conversation, a beach joined on the board: "the car photo" is the car.
  const both = [look(61, "", "A blue hatchback car."), look(62, "beach.jpg", "A beach at sunset.")];
  eq(P.choosePictures({ message: "Make a 3D model of the car photo", pointed: null, attached: [], connected: [62], seen: both, onBoard: [62], inChat: [61], newestMade: null })?.ids, [61], "the named photo before the joined one:");
});

ok("never a photo the words didn't point at: the reviewer's cases (final review, 2026-11-25)", () => {
  // Two cars on the board, named like a camera names them: "the red car photo" is the red one.
  const cars = [look(71, "IMG_0001.jpg", "A blue sedan car on a street."), look(72, "IMG_0002.jpg", "A red sports car on a street.")];
  eq(P.choosePictures({ message: "make a 3D model of the red car photo", pointed: null, attached: [], connected: [], seen: cars, onBoard: [71, 72], newestMade: null })?.ids, [72], "the red car:");
  // …and two red cars is not a pick: it asks, never a guess.
  const twoRed = [look(73, "IMG_0003.jpg", "A red car."), look(74, "IMG_0004.jpg", "A red car, parked.")];
  asks(P.choosePictures({ message: "make a 3D model of the red car", pointed: null, attached: [], connected: [], seen: twoRed, onBoard: [73, 74], newestMade: null }), ["IMG_0003.jpg", "IMG_0004.jpg"]);
  // "a crystal" names a thing: an unrelated photo on the board is not it — words.
  eq(P.choosePictures({ message: "make a 3D model of a crystal", pointed: null, attached: [], connected: [], seen: [look(75, "beach.jpg", "A sandy beach.")], onBoard: [75], newestMade: null }), null, "a crystal:");
  // A table leg (not looked at: too big) then a tabletop, added together: never the tabletop — it asks.
  asks(P.choosePictures({ message: "make a 3D model of the table leg", pointed: null, attached: [76, 77], connected: [], seen: [look(77, "IMG_0006.jpg", "A round wooden tabletop.")], onBoard: [], newestMade: null }));
  // "from both sides", two camera-named uploads: both pictures, one model.
  const sides = [look(78, "IMG_1234.jpg", "A wooden chair."), look(79, "IMG_1235.jpg", "A wooden chair from behind.")];
  eq(P.choosePictures({ message: "make a 3D model from both sides", pointed: null, attached: [78, 79], connected: [], seen: sides, onBoard: [], newestMade: null })?.ids, [78, 79], "both sides:");
  truthy(P.asksForViews("use all four of these photos") && P.asksForViews("from both sides") && !P.asksForViews("the side of the barn"), "views asked for");
  // "this robot" with Robot front and Robot side wired into the step: views only when the
  // words ask for them, so it asks; "from both views" makes one model of both, front first.
  const robot = [look(81, "Robot side", "A grey robot seen from the side."), look(82, "Robot front", "A grey robot seen from the front.")];
  asks(P.choosePictures({ message: "make a 3D model of this robot", pointed: null, attached: [], connected: [81, 82], seen: robot, onBoard: [81, 82], newestMade: null }), ["Robot side", "Robot front"]);
  const both = P.choosePictures({ message: "make a 3D model of this robot from both views", pointed: null, attached: [], connected: [81, 82], seen: robot, onBoard: [81, 82], newestMade: null });
  eq(both && "ids" in both ? both.ids : both, [82, 81], "both views, front first:");
  // A look asked for is a look: the photo added stays ("in gold", "low poly").
  eq(P.choosePictures({ message: "make a low poly version of this in gold", pointed: null, attached: [80], connected: [], seen: [look(80, "IMG_9.jpg", "A helicopter.")], onBoard: [], newestMade: null })?.ids, [80], "a look:");
});

ok("the latest review's cases: the right picture, or a question — never another picture (review of 461c6ce)", () => {
  const A = look(91, "IMG_0091.jpg", "A wooden chair."), B = look(92, "IMG_0092.jpg", "A wooden chair from behind.");
  // "from the first photo, not both photos": the first, alone.
  eq((P.choosePictures({ message: "make a 3D model from the first photo, not both photos", pointed: null, attached: [91, 92], connected: [], seen: [A, B], onBoard: [], newestMade: null }) as { ids?: number[] })?.ids, [91], "the first, not both:");
  // "these two photos I just attached", with two other pictures joined on the board: the two added.
  const linked = [look(93, "lake.jpg", "A lake."), look(94, "tree.jpg", "A tree.")];
  eq((P.choosePictures({ message: "make a 3D model from these two photos I just attached", pointed: null, attached: [91, 92], connected: [93, 94], seen: [A, B, ...linked], onBoard: [93, 94], newestMade: null }) as { ids?: number[] })?.ids, [91, 92], "the two added:");
  asks(P.choosePictures({ message: "make a 3D model from these two photos I just attached", pointed: null, attached: [], connected: [93, 94], seen: linked, onBoard: [93, 94], newestMade: null }));
  // "Chair front" and "Robot side" joined: "the robot" is the robot, alone.
  const mixed = [look(95, "Chair front", "A chair from the front."), look(96, "Robot side", "A robot from the side.")];
  eq((P.choosePictures({ message: "make a 3D model of the robot", pointed: null, attached: [], connected: [95, 96], seen: mixed, onBoard: [95, 96], newestMade: null }) as { ids?: number[] })?.ids, [96], "the robot alone:");
  // Two robot views joined, nothing asked about views: a question, never words.
  const robots = [look(97, "Robot A", "A robot."), look(98, "Robot B", "A robot, standing.")];
  asks(P.choosePictures({ message: "make a 3D model of the robot", pointed: null, attached: [], connected: [97, 98], seen: robots, onBoard: [97, 98], newestMade: null }), ["Robot A", "Robot B"]);
  // A red wooden table is not a red wooden chair: words.
  eq(P.choosePictures({ message: "make a 3D model of a red wooden chair", pointed: null, attached: [], connected: [], seen: [look(99, "IMG_0099.jpg", "A red wooden table.")], onBoard: [99], newestMade: null }), null, "a chair from words:");
  // "in gold from the chair photo", a lake before the chair on the board: the chair.
  const lakeChair = [look(101, "lake.jpg", "A lake at dawn."), look(102, "IMG_0102.jpg", "A wooden chair.")];
  eq((P.choosePictures({ message: "make a 3D model in gold from the chair photo", pointed: null, attached: [], connected: [], seen: lakeChair, onBoard: [101, 102], newestMade: null }) as { ids?: number[] })?.ids, [102], "the chair:");
  // Two red cars and a beach joined into the step: "the red car photo" asks — never the beach.
  const carsBeach = [look(103, "IMG_0103.jpg", "A red car."), look(104, "IMG_0104.jpg", "A red car, parked."), look(105, "beach.jpg", "A beach.")];
  asks(P.choosePictures({ message: "make a 3D model of the red car photo", pointed: null, attached: [], connected: [105], seen: carsBeach, onBoard: [103, 104, 105], newestMade: null }), ["IMG_0103.jpg", "IMG_0104.jpg"]);
  // A beach, then the same car photo twice (one Library file): the car.
  const beachCar = [look(106, "IMG_0106.jpg", "A beach."), look(107, "IMG_0107.jpg", "A blue car.")];
  eq((P.choosePictures({ message: "make a 3D model of the car photo", pointed: null, attached: [106, 107, 107], connected: [], seen: beachCar, onBoard: [], newestMade: null }) as { ids?: number[] })?.ids, [107], "the car:");
  // Reopened: the conversation's only photo, 12 MB, never looked at: "my uploaded helicopter photo" is it.
  eq((P.choosePictures({ message: "make a 3D model from my uploaded helicopter photo", pointed: null, attached: [], connected: [], seen: [], onBoard: [], inChat: [108], newestMade: null }) as { ids?: number[] })?.ids, [108], "the photo:");
  // "a low-poly 3D model of this photo", one photo in the conversation: that photo.
  eq((P.choosePictures({ message: "make a low-poly 3D model of this photo", pointed: null, attached: [], connected: [], seen: [look(109, "", "A brass lantern.")], onBoard: [], inChat: [109], newestMade: null }) as { ids?: number[] })?.ids, [109], "low-poly is how, not what:");
  truthy(P.limitsPictures("only the first one") && P.limitsPictures("not both photos") && !P.limitsPictures("make a 3D model from both photos"), "limits");
});

ok("the focused review's wrong-photo cases (review of dc18c1b): never an excluded or unrelated photo", async () => {
  const { is3dRequest } = await import("../src/lib/buzzy/intent");
  const ids = (c: unknown) => (c && typeof c === "object" && "ids" in c ? (c as { ids: number[] }).ids : c);
  // Two earlier photos (newest first: B, then A): "my photo, not the first photo" is B.
  eq(ids(P.choosePictures({ message: "Make a 3D model from my photo, not the first photo", pointed: null, attached: [], connected: [], seen: [], onBoard: [], inChat: [112, 111], newestMade: null })), [112], "not the first:");
  // Two uploads and two pictures joined on the board: "the second photo I uploaded" is the second upload.
  eq(ids(P.choosePictures({ message: "Make a 3D model from the second photo I uploaded", pointed: null, attached: [], connected: [113, 114], seen: [], onBoard: [113, 114], inChat: [112, 111], newestMade: null })), [112], "the second upload:");
  // Which set "the first photo" means isn't plain (uploads and board both there): it asks.
  asks(P.choosePictures({ message: "Make a 3D model from the first photo", pointed: null, attached: [], connected: [113, 114], seen: [], onBoard: [113, 114], inChat: [112, 111], newestMade: null }));
  // A lone picture joined to some step, never looked at (9 MB): "a dragon" is words, not that picture.
  eq(P.choosePictures({ message: "Make a 3D model of a dragon", pointed: null, attached: [], connected: [115], seen: [], onBoard: [115], newestMade: null }), null, "a dragon from words:");
  // "from my words" wins over any picture.
  eq(P.choosePictures({ message: "Make a 3D model of a chair from my words", pointed: null, attached: [], connected: [115], seen: [], onBoard: [115], newestMade: null }), null, "words only:");
  // The answers the question suggests are 3D requests, and they resolve.
  const two = [look(116, "IMG_0003.jpg", "A red car."), look(117, "IMG_0004.jpg", "A red car, parked.")];
  const q = P.choosePictures({ message: "make a 3D model of the red car", pointed: null, attached: [], connected: [], seen: two, onBoard: [116, 117], newestMade: null }) as { question: string };
  asks(q, ["IMG_0003.jpg", "IMG_0004.jpg"]);
  const said = /“(make the 3D model from IMG_0003\.jpg)”/.exec(q.question)?.[1] ?? "";
  truthy(said && is3dRequest(said) && is3dRequest("make the 3D model from my words"), q.question);
  eq(ids(P.choosePictures({ message: said, pointed: null, attached: [], connected: [], seen: two, onBoard: [116, 117], newestMade: null })), [116], "the name they were given:");
  eq(P.choosePictures({ message: "make the 3D model from my words", pointed: null, attached: [], connected: [], seen: two, onBoard: [116, 117], newestMade: null }), null, "their words:");
});

ok("what is recorded is the picture actually sent (independent review, 2026-11-25)", async () => {
  const seen = [look(31, "front view", "A robot, front."), look(32, "side view", "A robot, side.")];
  // A view that can't be sent is never quietly left out of the set they chose: nothing is started.
  const r = await P.planModel3d({
    message: "make a 3D model from these views", pointed: null, attached: [31, 32], connected: [], seen, onBoard: [], newestMade: null,
    boardText: "", load: async (id) => (id === 31 ? null : PIC),
  });
  truthy("error" in r && r.code === "picture_unreadable", JSON.stringify(r));
  // All readable: both go, front first, and the front is what is recorded.
  const ok2 = await P.planModel3d({
    message: "make a 3D model from these views", pointed: null, attached: [32, 31], connected: [], seen, onBoard: [], newestMade: null,
    boardText: "", load: async () => PIC,
  });
  truthy(!("error" in ok2) && ok2.from, JSON.stringify(ok2));
  if ("error" in ok2 || !ok2.from) return;
  eq([ok2.from.ids, ok2.from.label, ok2.plan.kind], [[31, 32], "front view", "multi"], "both, front first:");
  // Not plain which picture: no plan at all, and the question names the candidates.
  const which = await P.planModel3d({
    message: "make a 3D model of the robot", pointed: null, attached: [], connected: [31, 32], seen, onBoard: [], newestMade: null,
    boardText: "", load: async () => PIC,
  });
  truthy("error" in which && which.code === "which_picture" && which.candidates?.length === 2 && /Which picture/.test(which.error), JSON.stringify(which));
});

ok("words with a subject of their own and no picture in play are words", () => {
  const seen = [look(1, "beach.jpg", "A sandy beach with palm trees.")];
  eq(P.choosePictures({ message: "make a 3D model of a red dragon", pointed: null, attached: [], connected: [], seen, onBoard: [1], newestMade: null }), null, "a dragon is not the beach:");
});

ok("nothing of its own in the words: the picture on the board, then the newest one made", () => {
  // A picture on the board that nobody points at, added or joined into the step: it asks.
  asks(P.choosePictures({ message: "turn this into a 3D model please", pointed: null, attached: [], connected: [], seen: [look(4, "tank", "A tank.")], onBoard: [4], newestMade: null }), ["tank"]);
  eq(P.choosePictures({ message: "make it 3D", pointed: null, attached: [], connected: [], seen: [], onBoard: [], newestMade: 12 })?.ids, [12], "made here:");
  eq(P.subjectWords("Can you make me a 3D model of this?"), [], "no subject:");
  eq(P.subjectWords("make a 3d model of a big red dragon"), ["big", "red", "dragon"], "a subject:");
});

ok("two to four views of one thing are made into one model; otherwise the first picture", () => {
  const seen = [look(1, "front", ""), look(2, "side", ""), look(3, "back", "")];
  eq(P.choosePictures({ message: "make a 3D model from these views", pointed: null, attached: [], connected: [1, 2, 3], seen, onBoard: [], newestMade: null })?.ids, [1, 2, 3], "views:");
  asks(P.choosePictures({ message: "make a 3D model", pointed: null, attached: [], connected: [5, 6], seen: [look(5, "tank", ""), look(6, "tree", "")], onBoard: [], newestMade: null }), ["tank", "tree"]);
});

ok("words naming a new object of their own beat a picture joined to an earlier step", () => {
  const seen = [look(5, "chair.jpg", "A wooden chair.")];
  // (A picture joined on the board may feed another step: a dragon is words, never the chair.)
  eq(P.choosePictures({ message: "make a 3D model of a red dragon", pointed: null, attached: [], connected: [5], seen, onBoard: [5], newestMade: null }), null, "the chair is not the dragon:");
  eq(P.choosePictures({ message: "make a 3D model of the chair", pointed: null, attached: [], connected: [5], seen, onBoard: [5], newestMade: null })?.ids, [5], "…but the chair is the chair:");
  eq(P.choosePictures({ message: "make this a 3D model but in gold", pointed: 5, attached: [], connected: [], seen, onBoard: [5], newestMade: null })?.ids, [5], "pointing at it with a look: the picture, in gold:");
});

ok("views go together, the front one first", () => {
  const seen = [look(1, "back view", ""), look(2, "front view", ""), look(3, "side view", "")];
  eq(P.choosePictures({ message: "make a 3D model from these views", pointed: 1, attached: [], connected: [1, 2, 3], seen, onBoard: [], newestMade: null })?.ids, [2, 1, 3], "the set, front first, even with one pointed at:");
});

ok("a picture that can't be sent is said plainly — never swapped for words", async () => {
  const r = await P.planModel3d({ message: "make this a 3D model", pointed: 9, attached: [], connected: [], seen: [look(9, "huge.tif", "")], onBoard: [9], newestMade: null, boardText: "", load: async () => null });
  truthy("error" in r && /can't be sent to the 3D maker/.test(r.error) && /huge\.tif/.test(r.error), JSON.stringify(r));
});

ok("a rough sketch is cleaned up; anything else keeps its exact look; a look they ask for is passed on", () => {
  truthy(P.keepsLook("make it 3D", ["Concept art of a six-legged tank, olive green."]), "concept art keeps its look");
  truthy(!P.keepsLook("make it 3D", ["A rough pencil sketch of a car."]), "a sketch is cleaned up");
  truthy(!P.keepsLook("make it look realistic", ["Concept art."]), "realistic asked");
  eq(P.styleAsk("make this tank 3D but in desert camo"), "in desert camo", "but…:");
  eq(P.styleAsk("make it a 3D model in gold"), "gold", "in gold:");
  eq(P.styleAsk("make it a 3D model"), undefined, "nothing asked:");
});

ok("planModel3d: a picture goes to the maker itself; words are rewritten, never sent as typed", async () => {
  const loaded: number[] = [];
  const pic = await P.planModel3d({
    message: "make this a 3D model", pointed: 3, attached: [], connected: [], seen: [look(3, "Ark Titan", "A six-legged walking tank.")],
    onBoard: [3], newestMade: null, boardText: "", load: async (id) => { loaded.push(id); return PIC; },
  });
  if ("error" in pic) throw new Error(pic.error);
  eq([pic.plan.kind, pic.plan.images.length, pic.plan.keepLook, pic.from?.label], ["image", 1, true, "Ark Titan"], "from the picture:");
  eq(loaded, [3], "loaded by id:");
  const asked: string[] = [];
  const words = await P.planModel3d({
    message: "can you make me a 3D model of a low poly fox", pointed: null, attached: [], connected: [], seen: [], onBoard: [], newestMade: null,
    boardText: "Note — the fox is orange and white, chunky shapes", load: async () => null,
    write: async (instruction, ask) => { asked.push(instruction, ask); return "A stylised low-poly fox, orange body, white chest and tail tip, chunky faceted shapes, sitting."; },
  });
  if ("error" in words) throw new Error(words.error);
  eq(words.plan.kind, "text", "words:");
  eq(words.plan.purpose, "lowpoly", "low poly:");
  truthy(/one object|ONE object/.test(asked[0]!) && /No scene/.test(asked[0]!) && /say realistic only if they did/.test(asked[0]!), "the writer's rules");
  truthy(/the fox is orange and white/.test(asked[1]!), "the board's notes go to the writer");
  truthy(!/can you make me/i.test(words.plan.prompt), "not the sentence as typed");
  const fallback = await P.planModel3d({ message: "please make a 3D model of a wooden chair", pointed: null, attached: [], connected: [], seen: [], onBoard: [], newestMade: null, boardText: "", load: async () => null });
  if ("error" in fallback) throw new Error(fallback.error);
  eq(fallback.plan.prompt, "a wooden chair", "no writer: their words minus the asking:");
});

console.log("\nThe Meshy requests");

ok("a picture: Image to 3D, textured with PBR, its look kept, a clean quad mesh, four views", () => {
  const r = M.meshyRequest({ kind: "image", prompt: "tank", images: [PIC], purpose: "game", keepLook: true });
  eq(r.path, "/v1/image-to-3d", "endpoint:");
  const b = r.body;
  eq([b.image_url, b.ai_model, b.should_texture, b.texture_model, b.enable_pbr, b.image_enhancement], [PIC, "meshy-7.1", true, "meshy-7", true, false], "picture, model, paint, look:");
  eq([b.should_remesh, b.topology, b.target_polycount], [true, "quad", 30000], "mesh:");
  eq([b.target_formats, b.multi_view_thumbnails], [["glb", "fbx"], true], "glb, an fbx that keeps the quads, and views:");
  truthy(!("art_style" in b) && !("texture_prompt" in b), "no art_style (ignored by Meshy since January 2026), no words over the picture");
});

ok("low poly, detailed and 3D printing choose their own mesh; a look they asked for paints over the picture", () => {
  const low = M.meshyRequest({ kind: "image", prompt: "", images: [PIC], purpose: "lowpoly", keepLook: true }).body;
  eq([low.model_type, low.ai_model, low.target_polycount, low.texture_model], ["smart-topology", "meshy-t2.5", 5000, "meshy-n1"], "low poly:");
  truthy(!("enable_pbr" in low) && !("image_enhancement" in low) && !("topology" in low), "N1 takes no PBR; Smart Topology takes no image_enhancement or quads");
  const detailed = M.meshyRequest({ kind: "image", prompt: "", images: [PIC], purpose: "detailed", keepLook: true }).body;
  eq([detailed.should_remesh, detailed.texture_resolution], [false, "4k"], "detailed:");
  eq(M.meshyRequest({ kind: "image", prompt: "", images: [PIC], purpose: "print", keepLook: true }).body.should_remesh, false, "print:");
  eq(M.meshyRequest({ kind: "image", prompt: "", images: [PIC], purpose: "game", keepLook: true, texturePrompt: "desert camo" }).body.texture_prompt, "desert camo", "asked look:");
  eq(M.modelPurpose("a low-poly fox"), "lowpoly", "");
  eq(M.modelPurpose("something I can 3D print"), "print", "");
  eq(M.modelPurpose("a highly detailed hero asset"), "detailed", "");
  eq(M.modelPurpose("a tank for my game"), "game", "");
});

ok("image enhancement only where the shape model takes it", () => {
  truthy(M.takesEnhancement("meshy-7.1") && M.takesEnhancement("meshy-6") && M.takesEnhancement("latest"), "7.1, 6, latest");
  truthy(!M.takesEnhancement("meshy-6-lite") && !M.takesEnhancement("meshy-t2.5"), "not 6 Lite or Smart Topology (400)");
  const multi = M.meshyRequest({ kind: "multi", prompt: "", images: [PIC, PIC], purpose: "game", keepLook: true }).body;
  eq(multi.image_enhancement, false, "views keep their look too (Meshy turns it on by default):");
});

ok("several views: Multi-Image to 3D with up to four pictures", () => {
  const r = M.meshyRequest({ kind: "multi", prompt: "", images: [PIC, PIC, PIC, PIC, PIC], purpose: "game", keepLook: true });
  eq(r.path, "/v1/multi-image-to-3d", "endpoint:");
  eq((r.body.image_urls as string[]).length, 4, "four at most:");
  truthy(!("multi_view_thumbnails" in r.body), "only options Multi-Image to 3D lists");
});

ok("words: the shape first (preview, no art_style), the paint next (refine with PBR and the words)", () => {
  const r = M.meshyRequest({ kind: "text", prompt: "A stylised fox. ".repeat(80), images: [], purpose: "game", keepLook: true });
  eq(r.path, "/v2/text-to-3d", "endpoint:");
  eq([r.body.mode, r.body.should_remesh, r.body.topology], ["preview", true, "quad"], "shape:");
  truthy(String(r.body.prompt).length <= 800 && !("art_style" in r.body), "at most 800 characters, no art_style");
  const refine = M.refineRequest("abc12345", { userId: "u", prompt: "A fox", purpose: "game", at: 0 });
  eq([refine.body.mode, refine.body.preview_task_id, refine.body.enable_pbr, refine.body.texture_prompt], ["refine", "abc12345", true, "A fox"], "paint:");
  const repaint = M.retextureRequest("abc12345", { userId: "u", prompt: "A fox", purpose: "game", image: PIC, at: 0 });
  eq([repaint?.path, repaint?.body.image_style_url, repaint?.body.enable_original_uv], ["/v1/retexture", PIC, true], "repaint from the picture, keeping the UVs:");
});

ok("a job id says which endpoint it lives on; ids from before still work", () => {
  eq(M.parseJobId("img.018a210d-8ba4-705c-b111-1f1776f7f578")?.path, "/v1/image-to-3d", "picture:");
  eq(M.parseJobId("mimg.018a210d-8ba4")?.path, "/v1/multi-image-to-3d", "views:");
  eq(M.parseJobId("ref.018a210d-8ba4")?.path, "/v2/text-to-3d", "paint:");
  eq(M.parseJobId("rtx.018a210d-8ba4")?.path, "/v1/retexture", "repaint:");
  eq(M.parseJobId("018a210d-8ba4-705c")?.kind, "legacy", "from before:");
  eq(M.parseJobId("../etc/passwd"), null, "nothing else:");
});

console.log("\nMeshzilla's skill");

ok("the skill is there on 3D turns only, and carries what testers ran into", async () => {
  const K = await import("../src/lib/buzzy/model3dSkill");
  truthy(K.needsModel3dSkill({ message: "make it 3D", wants3d: true }), "a 3D request");
  truthy(K.needsModel3dSkill({ message: "why is my mesh a triangle soup?", wants3d: false }), "words about meshes");
  truthy(K.needsModel3dSkill({ message: "what is this?", wants3d: false, pointedKind: "3D model" }), "a 3D model pointed at");
  truthy(K.needsModel3dSkill({ message: "hi", wants3d: false, history: [{ role: "user", content: "Context: the user came from the model3d experts page.\n\nhello" }] }), "from the 3D Models expert");
  truthy(!K.needsModel3dSkill({ message: "write a letter to my landlord about the faces on the wall", wants3d: false }), "not an ordinary turn");
  eq(K.model3dSkillBlock(false), "", "nothing when off:");
  const s = K.MODEL3D_SKILL;
  for (const must of ["Textureless", "soup of triangles", "windshield", "Image to 3D", "Multi-Image to 3D", "remesh", "meshy-7.1", "meshy-n1", "800 characters", "Never regenerate or retexture the whole model", "alphaMode BLEND", "402", "Sources:"]) {
    truthy(s.toLowerCase().includes(must.toLowerCase()), `the skill covers: ${must}`);
  }
  eq([K.MESHZILLA.name, K.MESHZILLA.creature, K.MESHZILLA.color], ["Meshzilla", "bull", "#8B6CFF"], "the bot:");
  const server = readFileSync("src/lib/buzzy/server.ts", "utf8");
  truthy(/boardSection \+ model3dSection \+ madeThingsSection/.test(server), "in the turn's instructions");
  const experts = readFileSync("public/buzzy/experts-data.js", "utf8");
  truthy(/id: "model3d", name: "3D Models"/.test(experts) && /id: "pictures"/.test(experts) && /id: "seeing", name: "Picture Analysis"/.test(experts), "the Experts page");
  const icons = readFileSync("public/buzzy/icons/bz-icons.svg", "utf8");
  truthy(/id="expert-model3d"/.test(icons) && /id="expert-pictures"/.test(icons) && /id="expert-seeing"/.test(icons), "their icons");
});

console.log("\nMoving a job along, against a stand-in Meshy");

ok("start → shape done → paint (claimed once) → bare? repaint once; only the starter owns the job", async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  M.__setMeshyFetchForTests(async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: String(init.method || "GET"), body });
    if (init.method === "POST") { await new Promise((r) => setTimeout(r, 30)); return new Response(JSON.stringify({ result: "task" + calls.length + "-aaaaaaaa" }), { status: 202 }); }
    return new Response(JSON.stringify({ status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://assets.meshy.test/m.glb", fbx: "https://assets.meshy.test/m.fbx" },
      thumbnail_urls: { front: "https://t.test/f.png", right: "https://t.test/r.png", back: "https://t.test/b.png", left: "https://t.test/l.png" } }), { status: 200 });
  });
  const started = await M.startModel({ kind: "text", prompt: "A fox", images: [], purpose: "game", keepLook: true }, "u1", { pictureId: null });
  truthy(started.ok && started.taskId.startsWith("txt."), JSON.stringify(started));
  if (!started.ok) return;
  eq(calls[0]!.url, "https://api.meshy.ai/openapi/v2/text-to-3d", "posted to:");
  const meshyId = started.taskId.slice(4);
  eq(await M.jobOwner(meshyId), "u1", "the owner is on record:");
  eq(await M.jobOwner("no-such-job-000"), null, "an unknown job is nobody's:");
  const state = await M.readModelTask(started.taskId);
  eq([state?.status, state?.thumbnailUrls?.length, state?.fbxUrl], ["SUCCEEDED", 4, "https://assets.meshy.test/m.fbx"], "read (Meshy's named views, and the fbx):");
  // Two polls at the same moment: one paint task, the same next id for both.
  const posts = calls.filter((c) => c.method === "POST").length;
  const [a, b] = await Promise.all([M.nextStep(started.taskId, "u1", "shape-done"), M.nextStep(started.taskId, "u1", "shape-done")]);
  const ids = [a, b].map((x) => (x && x.ok && "taskId" in x ? x.taskId : x && x.ok && "pending" in x ? "pending" : "none"));
  eq(calls.filter((c) => c.method === "POST").length - posts, 1, "one paint task started:");
  truthy(ids.includes("pending") || ids[0] === ids[1], JSON.stringify(ids));
  const paint = await M.nextStep(started.taskId, "u1", "shape-done");
  truthy(paint && paint.ok && "taskId" in paint && paint.taskId.startsWith("ref."), JSON.stringify(paint));
  eq(calls.filter((c) => c.method === "POST").length - posts, 1, "asking again gives the same next step, no new task:");
  eq(await M.nextStep(started.taskId, "u2", "shape-done"), null, "someone else can't move it along:");
  const refine = calls.find((c) => c.method === "POST" && c.body && c.body.mode === "refine");
  eq(refine?.body.target_formats, ["glb", "fbx"], "the paint step keeps the fbx:");
  // The paint came back bare: painted again once, from the same words.
  const again = paint && paint.ok && "taskId" in paint ? await M.nextStep(paint.taskId, "u1", "bare") : null;
  truthy(again && again.ok && "taskId" in again && again.taskId.startsWith("rtx."), JSON.stringify(again));
  const rtx = calls.filter((c) => c.method === "POST").pop();
  eq(rtx?.body.text_style_prompt, "A fox", "repainted from the words:");
  eq(again && again.ok && "taskId" in again ? await M.nextStep(again.taskId, "u1", "bare") : "x", null, "never twice:");
  M.__setMeshyFetchForTests(null);
});

ok("a paid step whose start isn't known is never sent again; a next id is handed out only once written down", async () => {
  let mode: "ok" | "lost" | "5xx" | "402" = "ok";
  let posts = 0;
  M.__setMeshyFetchForTests(async (_url, init) => {
    if (init.method === "POST") {
      posts++;
      if (mode === "lost") throw new TypeError("socket hang up");
      if (mode === "5xx") return new Response("upstream timeout", { status: 504 });
      if (mode === "402") return new Response(JSON.stringify({ message: "Insufficient credits" }), { status: 402 });
      return new Response(JSON.stringify({ result: `job${posts}-cccccccc` }), { status: 202 });
    }
    return new Response(JSON.stringify({ status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://assets.meshy.test/m.glb" } }), { status: 200 });
  });
  const shape = async (prompt: string) => {
    mode = "ok";
    const s = await M.startModel({ kind: "text", prompt, images: [], purpose: "game", keepLook: true }, "u7");
    if (!s.ok) throw new Error(JSON.stringify(s));
    return s.taskId;
  };
  const code = (r: unknown) => (r && typeof r === "object" && "code" in r ? (r as { code: string }).code : JSON.stringify(r));
  // The paint is sent, and no answer comes back: maybe started (and paid). Never sent again.
  const t1 = await shape("A boat");
  mode = "lost";
  let before = posts;
  eq(code(await M.nextStep(t1, "u7", "shape-done")), "uncertain", "a lost answer:");
  eq(code(await M.nextStep(t1, "u7", "shape-done")), "uncertain", "asked again:");
  eq(posts - before, 1, "sent once, never again:");
  // A server error from Meshy (or a gateway): the same.
  const t2 = await shape("A kite");
  mode = "5xx";
  before = posts;
  eq(code(await M.nextStep(t2, "u7", "shape-done")), "uncertain", "a 504:");
  eq(code(await M.nextStep(t2, "u7", "shape-done")), "uncertain", "asked again:");
  eq(posts - before, 1, "sent once:");
  // A plain "no" (402): nothing was started, so asking again may send it again.
  const t3 = await shape("A lamp");
  mode = "402";
  eq(code(await M.nextStep(t3, "u7", "shape-done")), "no_credits", "no credits:");
  mode = "ok";
  const next3 = await M.nextStep(t3, "u7", "shape-done");
  truthy(next3 && next3.ok && "taskId" in next3 && next3.taskId.startsWith("ref."), JSON.stringify(next3));
  // Meshy confirms the paint, but writing it down fails: no id nobody could poll is handed
  // out; the next poll writes it down and hands it out, and nothing is sent again.
  const t4 = await shape("A chair");
  before = posts;
  failInserts = 2;
  const waiting = await M.nextStep(t4, "u7", "shape-done");
  truthy(waiting && waiting.ok && "pending" in waiting, JSON.stringify(waiting));
  const linked = await M.nextStep(t4, "u7", "shape-done");
  truthy(linked && linked.ok && "taskId" in linked && linked.taskId.startsWith("ref."), JSON.stringify(linked));
  eq(posts - before, 1, "one paint task:");
  if (linked && linked.ok && "taskId" in linked) eq(await M.jobOwner(linked.taskId.slice(4)), "u7", "the next job has its owner:");
  // A claim that never finished (a crash mid-way): after three minutes it is said, not re-sent.
  const t5 = await shape("A table");
  await pg.query("UPDATE buzzy_model3d_jobs SET next_id = 'pending', next_claimed_at = now() - interval '4 minutes' WHERE meshy_id = $1", [t5.slice(4)]);
  before = posts;
  eq(code(await M.nextStep(t5, "u7", "shape-done")), "uncertain", "an old claim:");
  eq(posts - before, 0, "nothing sent:");
  // A next job written down whose link failed (another server, a restart): found by its
  // parent, never marked uncertain, never sent again.
  const t6 = await shape("A shelf");
  await pg.query("INSERT INTO buzzy_model3d_jobs (meshy_id, user_id, kind, prompt, parent_id) VALUES ('kid6-dddddddd', 'u7', 'ref', 'A shelf', $1)", [t6.slice(4)]);
  await pg.query("UPDATE buzzy_model3d_jobs SET next_id = 'pending', next_claimed_at = now() - interval '4 minutes' WHERE meshy_id = $1", [t6.slice(4)]);
  before = posts;
  const found = await M.nextStep(t6, "u7", "shape-done");
  truthy(found && found.ok && "taskId" in found && found.taskId === "ref.kid6-dddddddd", JSON.stringify(found));
  eq(posts - before, 0, "nothing sent:");
  // …also when it was already marked uncertain.
  const t7 = await shape("A stool");
  await pg.query("INSERT INTO buzzy_model3d_jobs (meshy_id, user_id, kind, prompt, parent_id) VALUES ('kid7-eeeeeeee', 'u7', 'ref', 'A stool', $1)", [t7.slice(4)]);
  await pg.query("UPDATE buzzy_model3d_jobs SET next_id = 'uncertain' WHERE meshy_id = $1", [t7.slice(4)]);
  const found7 = await M.nextStep(t7, "u7", "shape-done");
  truthy(found7 && found7.ok && "taskId" in found7 && found7.taskId === "ref.kid7-eeeeeeee", JSON.stringify(found7));
  M.__setMeshyFetchForTests(null);
});

ok("Meshy's empty message with a detail: the detail is the reason (a refused picture is not a bad key)", async () => {
  M.__setMeshyFetchForTests(async () => new Response(JSON.stringify({ message: "", detail: "Content moderated: weapons are not allowed" }), { status: 403 }));
  const r = await M.startModel({ kind: "image", prompt: "", images: [PIC], purpose: "game", keepLook: true }, "u9");
  truthy(!r.ok && r.code === "moderated" && /refused/.test(r.error), JSON.stringify(r));
  M.__setMeshyFetchForTests(null);
});

ok("an odd error answer from Meshy (an object for its message) is still a plain no, and frees the step", async () => {
  let posts = 0, odd = true;
  M.__setMeshyFetchForTests(async (_url, init) => {
    if (init.method === "POST") {
      posts++;
      if (odd && posts > 1) return new Response(JSON.stringify({ message: { reason: "bad field", field: "texture_prompt" } }), { status: 400 });
      return new Response(JSON.stringify({ result: `odd${posts}-ffffffff` }), { status: 202 });
    }
    return new Response(JSON.stringify({ status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://assets.meshy.test/m.glb" } }), { status: 200 });
  });
  const s = await M.startModel({ kind: "text", prompt: "A vase", images: [], purpose: "game", keepLook: true }, "u8");
  truthy(s.ok, JSON.stringify(s));
  if (!s.ok) return;
  const r = await M.nextStep(s.taskId, "u8", "shape-done");
  truthy(r && !r.ok && r.code === "meshy_failed" && /bad field/.test(r.error), JSON.stringify(r));
  odd = false;
  const again = await M.nextStep(s.taskId, "u8", "shape-done");
  truthy(again && again.ok && "taskId" in again, JSON.stringify(again));
  M.__setMeshyFetchForTests(null);
});

ok("a .glb is read for its texture and size, without trusting it", () => {
  const json = JSON.stringify({
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ bufferView: 0 }],
    accessors: [{ count: 100 }, { count: 100 }, { count: 100 }, { count: 300 }],
  });
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const j = Buffer.from(json + " ".repeat(pad(json.length)));
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + j.length, 8);
  head.writeUInt32LE(j.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const s = M.glbSummary(Buffer.concat([head, j]));
  eq([s.ok, s.triangles, s.texturedMaterials, s.images, s.hasUvs, s.hasNormals], [true, 100, 1, 1, true, true], "summary:");
  eq(M.glbSummary(Buffer.from("not a glb at all, really")).ok, false, "garbage:");
});

ok("wired: the turn plans the model and starts it; the poll follows the steps; the pages follow `next`", () => {
  const server = readFileSync("src/lib/buzzy/server.ts", "utf8");
  truthy(/await planModel3d\(\{/.test(server) && /const started = plan \? await startModel\(plan, userId, \{ pictureId:/.test(server), "the turn");
  truthy(!/createModelTask\(message\)/.test(server), "the sentence is never sent as typed");
  const route = readFileSync("src/lib/buzzy/chat.nitro.ts", "utf8");
  truthy(/nextStep\([^)]*"shape-done"\)/.test(route) && /nextStep\(taskId, user\.id, "bare", loadPicture\)/.test(route) && /glbSummary\(bytes\)/.test(route), "the poll");
  truthy(/\(await jobOwner\(job\.meshyId\)\) !== user\.id/.test(route), "only the starter polls a job (owner on record)");
  truthy(/SELECT mode FROM buzzy_privacy_mode/.test(route) && /Paused while Lockdown is on/.test(route), "Lockdown pauses the next step");
  truthy(/catch \{ return "unknown"; \}/.test(route) && /if \(pv === "unknown"\) return checking;/.test(route), "a privacy setting that can't be read starts nothing");
  truthy(/fetchCompanion\(key, user\.id, state\.fbxUrl/.test(route) && !/await fetchModel\(state\.fbxUrl\)/.test(route), "the .glb never waits for the FBX copy");
  truthy(/finishingModels\.get\(key\)/.test(route) && /finishedModels\.get\(key\)/.test(route), "a finished model is fetched once, whoever asks");
  truthy(route.indexOf("finishedModels.get(key)") < route.indexOf("const state = await readModelTask(taskId)"), "a kept model is served before Meshy is asked again");
  truthy(/bareWaiting\.has\(key\)/.test(route) && /if \(pv !== "open"\) bareWaiting\.set\(key/.test(route), "paused polls don't fetch the model again"); 
  truthy(/painting it again failed/.test(route) && /even after painting it again/.test(route), "a model that stays bare is said so");
  for (const f of ["public/buzzy/talk.html", "public/buzzy/chat.js"]) {
    const page = readFileSync(f, "utf8");
    truthy(/if \(p\.next\) \{ pollId = String\(p\.next\)/.test(page) && /tries > 225/.test(page), f);
    truthy(/status === "PAUSED"\) \{\s*tries--;|status === "PAUSED"\) \{ tries--;/.test(page), f + ": time paused in Lockdown doesn't count");
    truthy(/if \(asking\) return;/.test(page) && /AbortSignal\.timeout\(60000\)/.test(page), f + ": one request at a time, each with a deadline");
    truthy(/companion\(14\)/.test(page), f + ": the FBX copy is waited for through its download");
    truthy(/p\.fbxPending/.test(page) && /p\.warning/.test(page), f + ": the FBX copy and a bare model's warning");
  }
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
}
console.log(`\nmodel3d: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
