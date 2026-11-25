/**
 * Orchestrate on the Idea Board, by talking (owner, 2026-11-24).
 *
 *   npx tsx scripts/test-board-orchestrate.ts
 *
 * Checks the words that start a build (boardPilot.ts / pilot.ts), the line language
 * BeeZilla answers in (boardOrchestrator.ts), the board described for the model and
 * where each card goes (orchestration.ts describeBoard / placeCard / makeRoom), and the
 * board ⇄ spec bridge (boardToSpec / specToBoard) against the CR-3 validator. No model
 * and no server: the streamed answer is played from a fixed text.
 */
import { planAppActions } from "../src/lib/buzzy/pilot";
import { orchestrateStep } from "../src/lib/buzzy/boardPilot";
import { newBuildState, parseBuildLine, runBoardBuild, readBuildRequest, buildMessages, BUILD_LIMITS, BuildCancelled, type BuildOp } from "../src/lib/buzzy/boardOrchestrator";
import {
  boardToSpec,
  specToBoard,
  describeBoard,
  placeCard,
  placeInFlow,
  tidyLineLabel,
  makeRoom,
  freeSpotNear,
  flowOrigin,
  validateOrchestration,
  type FlowBox,
  type FlowLine,
  type BoardOrchestration,
} from "../src/lib/buzzy/orchestration";
import { cleanWhiteboard } from "../src/lib/buzzy/whiteboards";

let passed = 0, failed = 0;
function check(name: string, ok: unknown, detail?: unknown): void {
  if (ok) passed++;
  else { failed++; console.log("FAIL", name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}

// ── 1. The words that ask for a build ─────────────────────────────────────
console.log("Words that start a build");
const builds = [
  "Orchestrate a weekly newsletter: find the news, write it, I approve it, then email it every Monday.",
  "Hey BeeZilla, can you build me a workflow that answers customer emails?",
  "set up an automation for my invoices",
  "I want to build a workflow for my bakery orders",
  "help me set up an agent team that writes blog posts",
  "create a process for onboarding new clients",
  "orchestration for onboarding new clients",
  "draw a flowchart of my morning routine",
  "make a workflow for my yoga class",
];
for (const words of builds) {
  const plan = planAppActions(words);
  check(`builds: ${words}`, plan && plan.length === 1 && plan[0]!.do === "board" && plan[0]!.value === "orchestrate", plan);
}
// Changing the flow on the board: only when the board the turn carries has one.
const changes = [
  "add an approval step before sending",
  "add a spelling check before my approval",
  "put a check after the draft",
  "make the research run in parallel",
  "make the draft repeat until it scores 8",
  "wrap the review in a loop",
];
for (const words of changes) {
  const plan = planAppActions(words, null, { boardHasFlow: true });
  check(`changes the flow: ${words}`, plan && plan[0]!.value === "orchestrate", plan);
  check(`…and is no build without a flow: ${words}`, !planAppActions(words)?.some((x) => x.value === "orchestrate"));
}
const long = "Orchestrate onboarding for a new client: " + "collect their details, set up the shared folder, book the kickoff call, then send the welcome pack. ".repeat(6);
const longPlan = planAppActions(long);
check("a long request is one build, never split on its ands", longPlan && longPlan.length === 1 && longPlan[0]!.value === "orchestrate");
check("the request keeps the person's own capitals", longPlan && String((longPlan[0] as { query?: string }).query).startsWith("Orchestrate onboarding"));
const stays = [
  "what is an orchestration?",
  "how do I build a workflow?",
  "make me a picture of a flow",
  "I want to make a song",
  "show me the workflow",
  "tell me about orchestration",
  // Found in review: things to make, code, and music that loops.
  "Generate a sales pipeline report for Q3",
  "Create a process document for onboarding",
  "Set up a data pipeline in Python that cleans CSV files",
  "build a CI pipeline",
];
for (const words of stays) {
  const plan = planAppActions(words, null, { boardHasFlow: true });
  check(`stays chat: ${words}`, !plan || plan[0]!.value !== "orchestrate", plan);
}
for (const words of ["make the beat loop", "make the song repeat", "make the video loop until the end"]) {
  check(`music and video keep their loops: ${words}`, !planAppActions(words, null, { boardHasFlow: true })?.some((x) => x.value === "orchestrate"));
}
check("a starting board stays a starting board", planAppActions("set up a starter orchestration for a logo")?.[0]?.value === "start");
check("adding a plain step stays the step command", planAppActions("add a step called Research")?.[0]?.value === "step");
check("open it in Orchestrate", planAppActions("open it in orchestrate")?.[0]?.value === "openOrchestrate");
check("orchestrateStep refuses a question", orchestrateStep("can orchestration help me") === null);

// ── 2. The line language ──────────────────────────────────────────────────
console.log("BeeZilla's answer, line by line");
{
  const st = newBuildState(["c1", "c2", "c3"], "add a spelling check before publishing");
  const lines = [
    "say Your flow goes Start, Write, Publish. I'm putting the check between them.",
    "say a second say is ignored",
    "add n1 step “Check the spelling” | Fix mistakes without changing the meaning.",
    "link c2 n1",
    "link n1 -> c3 approved",
    "unlink c2 c3",
    "edit c2 \"Write the post\" | Write 300 words.",
    "remove c3",
    "link c9 n1",
    "add n1 step \"Again\"",
    "add n2 flux \"Unknown type\"",
    "```",
    "- add n2 decision \"Good enough?\"",
    "done Added a spelling check.",
  ];
  const ops = lines.map((l) => parseBuildLine(l, st)).filter(Boolean) as BuildOp[];
  const kinds = ops.map((o) => o.op).join(",");
  check("accepted commands, in order (no edit: the person didn't ask to change a card)", kinds === "say,add,link,link,unlink,add,done", kinds);
  const add = ops.find((o) => o.op === "add") as Extract<BuildOp, { op: "add" }>;
  check("curly quotes and the detail are read", add.title === "Check the spelling" && add.detail === "Fix mistakes without changing the meaning.", add);
  const l2 = ops.filter((o) => o.op === "link")[1] as Extract<BuildOp, { op: "link" }>;
  check("an arrow and an unquoted label are read", l2.from === "n1" && l2.to === "c3" && l2.label === "approved", l2);
  check("remove is refused when the person didn't ask to remove anything", !ops.some((o) => o.op === "remove"));
  check("a line to an unknown card is skipped", !ops.some((o) => o.op === "link" && (o.from === "c9" || o.to === "c9")));
  check("an id can't be added twice", ops.filter((o) => o.op === "add" && o.id === "n1").length === 1);
  check("a bullet in front is ignored", ops.some((o) => o.op === "add" && o.id === "n2" && o.type === "decision"));
}
{
  const st = newBuildState(["c1", "c2"], "rename the draft step to Write the post");
  check("edit is allowed when the person asked for a change", parseBuildLine('edit c2 "Write the post"', st)?.op === "edit");
  const quiet = newBuildState(["c1", "c2"], "orchestrate a newsletter");
  check("a card on the board is never re-worded unasked", parseBuildLine('edit c2 "Email everyone"', quiet) === null);
  parseBuildLine('add n1 step "Draft"', quiet);
  check("…but a card from this same answer can be", parseBuildLine('edit n1 "Write the draft"', quiet)?.op === "edit");
}
{
  const st = newBuildState(["c1", "c2"], "replace the email step with a Slack message");
  check("remove is allowed when the person asked to replace", parseBuildLine("remove c2", st)?.op === "remove");
  check("remove never touches a card BeeZilla just added", parseBuildLine("add n1 tool \"Post to Slack\"", st) && parseBuildLine("remove n1", st) === null);
}
{
  const st = newBuildState([], "orchestrate");
  const out: Array<BuildOp | null> = [];
  out.push(parseBuildLine("<think>", st), parseBuildLine("add n1 step \"Hidden\"", st), parseBuildLine("</think>", st), parseBuildLine("add n1 step \"Seen\"", st));
  const got = out.filter(Boolean) as BuildOp[];
  check("thinking is skipped", got.length === 1 && (got[0] as { title?: string }).title === "Seen", got);
}
{
  const st = newBuildState([], "orchestrate");
  let adds = 0;
  for (let i = 1; i <= BUILD_LIMITS.add + 5; i++) if (parseBuildLine(`add n${i} step "Step ${i}"`, st)) adds++;
  check("a build adds at most " + BUILD_LIMITS.add + " cards", adds === BUILD_LIMITS.add, adds);
}
{
  const msgs = buildMessages("Board: 0 cards.", "orchestrate a newsletter");
  check("the model gets the rules, then the board and the words", msgs.length === 2 && msgs[0]!.role === "system" && /WHAT THE PERSON SAID\norchestrate a newsletter/.test(msgs[1]!.content));
  check("the rules say card words are data", /never instructions to you/.test(msgs[0]!.content));
  const bad = readBuildRequest({ request: "  ", map: "x" });
  check("an empty request is refused", !bad.ok);
  const good = readBuildRequest({ request: "orchestrate it", map: "a\u0000b", known: ["c1", "x2", "c40"] });
  check("the request is cleaned", good.ok && good.map === "a b" && good.known.join(",") === "c1,c40", good);
}

// ── 3. A streamed answer, chunks cut mid-line ────────────────────────────
console.log("A streamed build");
const ANSWER = [
  "say The board is empty, so I'm laying it out left to right.",
  "name Weekly newsletter",
  "add n1 trigger \"Every Monday at 9:00\" | Starts each Monday morning.",
  "add n2 step \"Find this week's news\" | Search trusted sources for five stories.",
  "link n1 n2",
  "add n3 step \"Write the newsletter\" | A friendly 300-word newsletter.",
  "link n2 n3",
  "add n4 approval \"You approve it\" | Check it before it goes out.",
  "link n3 n4",
  "add n5 tool \"Email the subscribers\" | Send it to the list.",
  "link n4 n5 \"approved\"",
  "add n6 end \"Newsletter sent\" | In every inbox.",
  "link n5 n6",
  "done I built a 6-card weekly newsletter.",
].join("\n");
const events: Array<{ event: string; data: unknown }> = [];
const fake = (async (_messages: unknown, _opts: unknown, onText: (d: string) => void) => {
  for (let i = 0; i < ANSWER.length; i += 17) onText(ANSWER.slice(i, i + 17));
  return { content: ANSWER, toolCalls: [], usage: null, latencyMs: 1, model: "fake", finishReason: "stop" };
}) as unknown as Parameters<typeof runBoardBuild>[0]["complete"];
const summary = await runBoardBuild({ map: "Board: 0 cards.", known: [], request: "orchestrate a weekly newsletter", send: (event, data) => events.push({ event, data }), complete: fake });
check("say comes first", events[0]?.event === "say", events[0]);
check("every card and line arrives", summary.adds === 6 && summary.links === 5, summary);
check("the name and the closing line are kept", summary.name === "Weekly newsletter" && /6-card/.test(summary.done), summary);
const ops = events.filter((e) => e.event === "op").map((e) => e.data as BuildOp);
check("cards arrive in the order they were said", ops.map((o) => (o.op === "add" ? o.id : o.op)).join(",") === "n1,n2,link,n3,link,n4,link,n5,link,n6,link");

{
  // Stop: the board stops listening, the model stops being read.
  let reads = 0;
  const slow = (async (_m: unknown, _o: unknown, onText: (d: string) => void) => {
    for (const line of ANSWER.split("\n")) { reads++; onText(line + "\n"); }
    return { content: "", toolCalls: [], usage: null, latencyMs: 1, model: "fake", finishReason: "stop" };
  }) as unknown as Parameters<typeof runBoardBuild>[0]["complete"];
  let sent = 0, threw = false;
  try {
    await runBoardBuild({ map: "", known: [], request: "orchestrate", send: () => { sent++; }, complete: slow, cancelled: () => sent >= 3 });
  } catch (e) { threw = e instanceof BuildCancelled; }
  check("Stop ends the read: nothing more is taken from the model", threw && reads <= 5, { reads, sent });
}

// ── 4. The board, described for the model ────────────────────────────────
console.log("The board in words");
{
  const map = describeBoard({
    cards: [
      { id: "real-b", kind: "skill", title: "Write the post", body: "Write 300 words in my voice", x: 400, y: 100, w: 210, h: 120 },
      { id: "real-a", kind: "start", title: "Start", x: 60, y: 100, w: 210, h: 90, selected: true },
      { id: "real-c", kind: "image", title: "Logo", url: "/api/buzzy/assets/7", x: 3000, y: 2000, w: 240, h: 200 },
    ],
    links: [{ from: "real-a", to: "real-b", label: "" }],
    areas: [{ id: "area1", title: "Blog", holds: ["real-a", "real-b"] }],
    view: { x1: 0, y1: 0, x2: 1400, y2: 800, z: 1 },
  });
  check("short ids in reading order", map.ids.c1 === "real-a" && map.ids.c2 === "real-b" && map.ids.c3 === "real-c", map.ids);
  check("a card line has its kind, words and place", /c2 step "Write the post" — Write 300 words in my voice @400,100 210x120/.test(map.text), map.text);
  check("off view says which way", /c3 picture "Logo" @3000,2000 240x200 off view below-right/.test(map.text), map.text);
  check("lines, areas and the selection are listed", /Lines: c1>c2/.test(map.text) && /Area "Blog" holds c1 c2/.test(map.text) && /Selected: c1/.test(map.text), map.text);
  check("it says where there is room", /Room: right of x 3240; below y 2200\./.test(map.text), map.text);
  const many = Array.from({ length: 200 }, (_, i) => ({ id: "k" + i, kind: "note", title: "Note number " + i + " with some words", body: "x".repeat(80), x: i * 50, y: 0, w: 210, h: 100 }));
  const big = describeBoard({ cards: many, links: [], view: { x1: 0, y1: 0, x2: 1000, y2: 800, z: 1 }, budget: 3200 });
  check("a big board stays inside the budget", big.text.length <= 3200, big.text.length);
  check("a big board says how many it left out", /\(\+\d+ more cards not listed: note\)/.test(big.text), big.text.slice(-200));
  check("the empty board says so", /The board is empty\./.test(describeBoard({ cards: [], links: [] }).text));
}

// ── 5. Where each card goes ───────────────────────────────────────────────
console.log("Placing cards");
const W = 210, H = 130;
{
  // A straight line: each card right of the one before, same row.
  const boxes: FlowBox[] = [];
  const lines: FlowLine[] = [];
  const at1 = placeCard("a", { w: W, h: H }, boxes, lines, { origin: { x: 100, y: 100 } });
  boxes.push({ id: "a", ...at1, w: W, h: H });
  lines.push({ from: "a", to: "b" });
  const at2 = placeCard("b", { w: W, h: H }, boxes, lines);
  check("the next card goes to the right, same height", at2.x === at1.x + W + 120 && at2.y === at1.y, { at1, at2 });
  boxes.push({ id: "b", ...at2, w: W, h: H, kind: "decision" });
  // A decision: "yes" level with it, "no" under the "yes".
  lines.push({ from: "b", to: "yes", label: "yes" });
  const yes = placeCard("yes", { w: W, h: H }, boxes, lines);
  boxes.push({ id: "yes", ...yes, w: W, h: H });
  lines.push({ from: "b", to: "no", label: "no" });
  const no = placeCard("no", { w: W, h: H }, boxes, lines);
  check("a branch's first answer is level with it", yes.y === at2.y && yes.x === at2.x + W + 120, yes);
  check("its second answer goes under the first", no.x === yes.x && no.y >= yes.y + H + 24, { yes, no });
  boxes.push({ id: "no", ...no, w: W, h: H });
  // A join: level with the middle of what it joins.
  lines.push({ from: "yes", to: "join" }, { from: "no", to: "join" });
  const join = placeCard("join", { w: W, h: H }, boxes, lines);
  const mid = (yes.y + H / 2 + no.y + H / 2) / 2 - H / 2;
  check("a join sits between what it joins", join.x === yes.x + W + 120 && Math.abs(join.y - mid) <= 24, { join, mid });
  check("nothing overlaps", !boxes.some((b) => join.x < b.x + b.w && join.x + W > b.x && join.y < b.y + b.h && join.y + H > b.y));
}
{
  // A loop: the step after "done" goes past what the loop repeats.
  const boxes: FlowBox[] = [
    { id: "loop", x: 0, y: 0, w: W, h: H, kind: "loop" },
    { id: "s1", x: 330, y: 0, w: W, h: H },
    { id: "s2", x: 660, y: 0, w: W, h: H },
  ];
  const lines: FlowLine[] = [
    { from: "loop", to: "s1", label: "repeat" },
    { from: "s1", to: "s2" },
    { from: "s2", to: "loop", label: "again" },
    { from: "loop", to: "next", label: "done" },
  ];
  const next = placeCard("next", { w: W, h: H }, boxes, lines);
  check("after a loop's done: right of what it repeats", next.x === 660 + W + 120, next);
  check("a line back into a loop moves nothing", makeRoom("s2", "loop", boxes, lines, {}, "again").length === 0);
}
{
  // Put between two joined cards: what follows moves right to make room.
  const boxes: FlowBox[] = [
    { id: "write", x: 0, y: 0, w: W, h: H },
    { id: "check", x: 330, y: 0, w: W, h: H },
    { id: "publish", x: 330, y: 0, w: W, h: H },
    { id: "after", x: 660, y: 0, w: W, h: H },
  ];
  const lines: FlowLine[] = [
    { from: "write", to: "check" },
    { from: "check", to: "publish" },
    { from: "publish", to: "after" },
  ];
  const moves = makeRoom("check", "publish", boxes, lines);
  const byId = Object.fromEntries(moves.map((m) => [m.id, m]));
  check("what follows moves right, in step", byId.publish?.x === 660 && byId.after?.x === 990, moves);
  check("what leads in stays put", !byId.write && !byId.check, moves);
  const spot = freeSpotNear(0, 0, W, H, [{ id: "x", x: 0, y: 0, w: W, h: H }]);
  check("a taken spot moves down until free", spot.x === 0 && spot.y >= H + 24, spot);
}
{
  // "Add a check between Write and Publish": the check takes Publish's place and
  // Publish, with what follows it, slides right.
  const boxes: FlowBox[] = [
    { id: "write", x: 0, y: 0, w: W, h: H },
    { id: "publish", x: 330, y: 0, w: W, h: H },
    { id: "after", x: 660, y: 0, w: W, h: H },
    { id: "pic", x: 330, y: 400, w: W, h: H },
  ];
  const lines: FlowLine[] = [
    { from: "write", to: "publish" },
    { from: "publish", to: "after" },
    { from: "write", to: "new" },
    { from: "new", to: "publish" },
  ];
  const at = placeInFlow("new", { w: W, h: H }, boxes, lines);
  const moved = Object.fromEntries(at.moves.map((m) => [m.id, m]));
  check("put between: it takes the place in the row", at.x === 330 && at.y === 0, at);
  check("…and what follows slides right, in step", moved.publish?.x === 660 && moved.after?.x === 990 && !moved.write && !moved.pic, at.moves);
  // Something else in the way: it goes under instead, and nothing moves.
  const other = placeInFlow("n2", { w: W, h: H }, [{ id: "a", x: 0, y: 0, w: W, h: H }, { id: "x", x: 330, y: 0, w: W, h: H }], [{ from: "a", to: "n2" }]);
  check("an unrelated card in the way: it goes under", other.x === 330 && other.y >= H + 24 && !other.moves.length, other);
  // A loop put in front of a step it repeats: the step slides over.
  const loopAt = placeInFlow("loop", { w: W, h: H }, [{ id: "find", x: 0, y: 0, w: W, h: H }, { id: "write", x: 330, y: 0, w: W, h: H }],
    [{ from: "find", to: "loop" }, { from: "loop", to: "write", label: "repeat" }, { from: "write", to: "loop", label: "again" }]);
  check("a loop in front of the step it repeats takes its place", loopAt.x === 330 && loopAt.y === 0 && loopAt.moves.some((m) => m.id === "write" && m.x === 660), loopAt);
}
{
  // The conversation card sits where a new flow would start: the flow starts right of it,
  // level, instead of having its first card pushed down under it.
  const chat: FlowBox = { id: "chat", x: 0, y: 0, w: 360, h: 480 };
  const o = flowOrigin(40, 40, [chat]);
  check("a new flow starts past the conversation card, at the top", o.x >= 360 && o.y === 40, o);
  const wall: FlowBox[] = [{ id: "w1", x: 1200, y: 0, w: 210, h: 200 }];
  const o2 = flowOrigin(40, 0, wall);
  check("a row that would run into a card starts lower, clear of it", o2.x === 40 && o2.y >= 200, o2);
  const down = freeSpotNear(0, 100, W, H, [{ id: "b", x: 0, y: 100, w: W, h: H }, { id: "a", x: 0, y: -200, w: W, h: H }]);
  check("a taken spot is solved by going down first", down.y > 100, down);
}
check("again only goes back into a loop", tidyLineLabel("again", "skill", "loop") === "again" && tidyLineLabel("again", "skill", "skill") === "");
check("repeat and done only leave a loop", tidyLineLabel("repeat", "loop", "skill") === "repeat" && tidyLineLabel("repeat", "skill", "loop") === "" && tidyLineLabel("done", "skill", "approval") === "");
check("approved only leaves an approval", tidyLineLabel("Approved", "approval", "tool") === "approved" && tidyLineLabel("approved", "skill", "tool") === "");
check("a decision's own words stay", tidyLineLabel("if it's under 300 words", "decision", "skill") === "if it's under 300 words");

// ── 6. The board as a spec, and back ──────────────────────────────────────
console.log("Board ⇄ spec");
{
  const board: BoardOrchestration = {
    name: "Weekly newsletter",
    cards: [
      { id: "t", kind: "trigger", title: "Every Monday at 9:00", body: "Starts each Monday morning.", x: 0, y: 0 },
      { id: "find", kind: "skill", title: "Find the news", body: "Search five sources.", x: 330, y: 0 },
      { id: "loop", kind: "loop", title: "Until it's good", body: "Repeat until it scores 8 or more, at most 3 times.", x: 660, y: 0 },
      { id: "write", kind: "skill", title: "Write it", body: "300 friendly words.", x: 990, y: 0 },
      { id: "ok", kind: "approval", title: "You approve it", body: "", x: 1320, y: 0 },
      { id: "send", kind: "tool", title: "Email the list", body: "email.send to subscribers", x: 1650, y: 0 },
      { id: "done", kind: "document", title: "Newsletter sent", body: "", x: 1980, y: 0 },
      { id: "memo", kind: "note", title: "Tone", body: "Warm and short.", x: 330, y: 300 },
      { id: "pic", kind: "image", title: "Logo", url: "/api/buzzy/assets/3", x: 0, y: 300 },
    ],
    links: [
      { from: "t", to: "find" },
      { from: "find", to: "loop" },
      { from: "loop", to: "write", label: "repeat" },
      { from: "write", to: "loop", label: "again" },
      { from: "loop", to: "ok", label: "done" },
      { from: "ok", to: "send", label: "approved" },
      { from: "send", to: "done" },
      { from: "memo", to: "find" },
      { from: "pic", to: "write" },
    ],
  };
  const spec = boardToSpec(board);
  const v = validateOrchestration(spec);
  const blocking = v.issues.filter((i) => i.severity === "error");
  check("a board flow is a valid spec", v.ok && !blocking.length, blocking);
  check("pictures stay on the board; the note comes along unconnected", spec.nodes.length === 8 && !spec.edges.some((e) => /memo/.test(e.from.node + e.to.node)), spec.nodes.map((n) => n.type));
  check("the trigger starts it (no extra Start)", spec.entry === "n_t" && !spec.nodes.some((n) => n.type === "start"), spec.entry);
  const loopEdges = spec.edges.filter((e) => e.from.node === "n_loop" || e.to.node === "n_loop");
  check("loop ports: body, back, exit", loopEdges.some((e) => e.from.port === "body") && loopEdges.some((e) => e.to.port === "back") && loopEdges.some((e) => e.from.port === "exit"), loopEdges);
  check("approval port from the line's words", spec.edges.some((e) => e.from.node === "n_ok" && e.from.port === "approved"));
  const loopNode = spec.nodes.find((n) => n.id === "n_loop")!;
  check("the loop's cap comes from 'at most 3 times', not from the 8", (loopNode.config as { maxIterations?: number }).maxIterations === 3, loopNode.config);
  const trig = spec.nodes.find((n) => n.id === "n_t")!;
  check("a schedule is read from the words", ((trig.config as { trigger?: { kind?: string } }).trigger || {}).kind === "schedule", trig.config);

  const back = specToBoard(spec);
  check("back on the board: same cards", back.cards.length === spec.nodes.length);
  check("line words come back", back.links.some((l) => l.label === "again") && back.links.some((l) => l.label === "approved") && back.links.some((l) => l.label === "done"), back.links);
  check("settings ride along on the card", back.cards.every((c) => !c.orch || JSON.parse(c.orch)));
  const again = boardToSpec({ name: back.name, cards: back.cards.map((c, i) => ({ ...c, id: "b" + i })), links: back.links.map((l) => ({ ...l, from: "b" + back.cards.findIndex((c) => c.id === l.from), to: "b" + back.cards.findIndex((c) => c.id === l.to) })) });
  check("a round trip keeps every type", again.nodes.map((n) => n.type).sort().join() === spec.nodes.map((n) => n.type).sort().join(), again.nodes.map((n) => n.type));
  check("a round trip keeps the loop's settings", (again.nodes.find((n) => n.type === "loop")!.config as { maxIterations?: number }).maxIterations === 3);
}
{
  const bare = boardToSpec({ cards: [{ id: "a", kind: "skill", title: "Write it", x: 0, y: 0 }, { id: "b", kind: "skill", title: "Check it", x: 330, y: 0 }], links: [{ from: "a", to: "b" }] });
  const v = validateOrchestration(bare);
  check("steps alone get a Start in front and an End after", v.ok && bare.nodes[0]!.type === "start" && bare.nodes.some((n) => n.type === "end"), v.issues);
  const empty = boardToSpec({ cards: [{ id: "p", kind: "image", url: "/x.png" }], links: [] });
  check("a board with no flow still makes a spec", Array.isArray(empty.nodes));
}

{
  // Orchestrate → Idea Board → Orchestrate keeps a real flow whole (found in review):
  // node ids that bindings name, declared outputs, params, conditions and ports.
  const spec = validateOrchestration({
    schema: "beezilla/orchestration", schemaVersion: 1, name: "Research brief", direction: "LR", grid: 16, entry: "n_start",
    params: [{ name: "topic", type: "string", required: true }],
    policy: { maxConcurrency: 2, budgetSec: 600, onError: "stop" },
    nodes: [
      { id: "n_start", type: "start", name: "Start", x: 0, y: 0, config: {} },
      { id: "n_research", type: "agent", name: "Research", x: 240, y: 0, config: { prompt: "Research {{$input.topic}}", output: { name: "findings" } } },
      { id: "n_ok", type: "approval", name: "Check it", x: 480, y: 0, config: { prompt: "Is it right?" } },
      { id: "n_write", type: "agent", name: "Write", x: 720, y: 0, config: { prompt: "Write from {{$n_research.findings}}", inputs: { notes: "$n_research.findings" } } },
      { id: "n_end", type: "end", name: "End", x: 960, y: 0, config: { outputs: { brief: "$n_research.findings" } } },
      { id: "n_stop", type: "end", name: "Stopped", x: 720, y: 160, config: { outputs: {} } },
    ],
    edges: [
      { id: "e1", from: { node: "n_start", port: "out" }, to: { node: "n_research", port: "in" } },
      { id: "e2", from: { node: "n_research", port: "out" }, to: { node: "n_ok", port: "in" } },
      { id: "e3", from: { node: "n_ok", port: "rejected" }, to: { node: "n_write", port: "in" }, label: "publish" },
      { id: "e4", from: { node: "n_ok", port: "approved" }, to: { node: "n_stop", port: "in" }, label: "send it back" },
      { id: "e5", from: { node: "n_write", port: "out" }, to: { node: "n_end", port: "in" }, condition: "$n_research.findings != \"\"" },
    ],
    meta: {},
  }).spec;
  check("the test flow is valid to begin with", validateOrchestration(spec).ok);
  const onBoard = specToBoard(spec);
  // The board gives every card its own id; the round trip must not depend on the old ones.
  const ids = new Map(onBoard.cards.map((c, i) => [c.id, "card" + i]));
  const back = boardToSpec({ name: onBoard.name, cards: onBoard.cards.map((c) => ({ ...c, id: ids.get(c.id)! })), links: onBoard.links.map((l) => ({ ...l, from: ids.get(l.from)!, to: ids.get(l.to)! })) });
  const v2 = validateOrchestration(back);
  check("…and still valid after the board", v2.ok, v2.issues.filter((i) => i.severity === "error"));
  check("node ids come back (bindings name them)", back.nodes.some((n) => n.id === "n_research") && back.nodes.some((n) => n.id === "n_write"), back.nodes.map((n) => n.id));
  check("a declared output name comes back", ((back.nodes.find((n) => n.id === "n_research")!.config as { output?: { name?: string } }).output || {}).name === "findings");
  check("params and policy come back", back.params.some((p) => p.name === "topic") && back.policy.budgetSec === 600, { params: back.params, policy: back.policy });
  check("approval ports come back as they were, whatever the lines say", back.edges.some((e) => e.from.node === "n_ok" && e.from.port === "rejected" && e.to.node === "n_write") && back.edges.some((e) => e.from.node === "n_ok" && e.from.port === "approved" && e.to.node === "n_stop"), back.edges);
  check("a condition comes back", back.edges.some((e) => e.from.node === "n_write" && e.condition === "$n_research.findings != \"\""), back.edges);
}

// ── 7. The account keeps what a flow needs ────────────────────────────────
console.log("Saving a flow board");
{
  const saved = cleanWhiteboard({
    v: 2,
    cards: [
      { id: "a", kind: "decision", title: "Good enough?", x: 0, y: 0, orch: "{\"until\":\"x\"}" },
      { id: "b", kind: "skill", title: "Write", x: 300, y: 0, orch: "not json" },
      { id: "c", kind: "loop", title: "Repeat", x: 600, y: 0, orch: "[1,2]" },
    ],
    links: [{ id: "l1", from: "a", to: "b", label: "  no   " }, { id: "l2", from: "b", to: "a", fp: "approved", tp: "in", cond: "$x.y > 1" }, { id: "l3", from: "a", to: "c", fp: "evil", tp: "<b>" }],
    view: { x: 0, y: 0, z: 1 },
  });
  check("the board saves", saved.ok);
  if (saved.ok) {
    const cards = saved.state.cards;
    check("settings that are an object are kept", cards[0]!.orch === "{\"until\":\"x\"}");
    check("settings that aren't are dropped", cards[1]!.orch === undefined && cards[2]!.orch === undefined);
    check("a line's words are kept, tidied", saved.state.links[0]!.label === "no" && saved.state.links[1]!.label === undefined, saved.state.links);
    check("a line's ports and condition are kept", saved.state.links[1]!.fp === "approved" && saved.state.links[1]!.tp === "in" && saved.state.links[1]!.cond === "$x.y > 1", saved.state.links[1]);
    check("anything that isn't a port is dropped", saved.state.links[2]!.fp === undefined && saved.state.links[2]!.tp === undefined, saved.state.links[2]);
  }
}

console.log(`\nboard orchestrate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
