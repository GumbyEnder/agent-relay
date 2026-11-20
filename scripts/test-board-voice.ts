/**
 * BeeZilla works the Idea Board by talking, knows itself, and looks before it builds
 * (owner, 2026-11-20):
 *   "it's got to be able to do everything the person does within the board for the
 *    person by voice command" · "if a person feels lost, it'll ask them, would you like
 *    me to zoom out and show you the whole board?" · "Beezilla has got to know about
 *    itself" · "tell me about one thing that you're struggling to do" · "the ability to
 *    tool use to search its own archive, the inspiration archive… that whiteboard has
 *    got to be a simple one".
 *
 *   - What people say → the board step (pilot.ts + boardPilot.ts), and ordinary chat
 *     that only sounds like a board command stays chat.
 *   - "yes" to BeeZilla's own offers; sounding lost.
 *   - Simple starting boards: five cards or fewer, found by what people want to make.
 *   - search_inspiration: offered, read-only, and what it finds.
 *   - The opener and the new answers about BeeZilla itself.
 *
 *   npx tsx scripts/test-board-voice.ts
 */
import { planAppActions, type AppAction } from "../src/lib/buzzy/pilot";
import { acceptedOffer, soundsLost, LOST_OFFER } from "../src/lib/buzzy/boardPilot";
import { STARTING_BOARDS, STARTING_BOARD_MAX_CARDS, findStartingBoards, startingBoardByName } from "../src/lib/buzzy/starterBoards";
import { searchInspiration, inspirationResult, inspirationNote, wantsInspiration, SEARCH_INSPIRATION_TOOL } from "../src/lib/buzzy/inspirationSearch";
import { readFileSync } from "node:fs";
import { offeredTools } from "../src/lib/buzzy/toolRegistry";
import { selfKnowledgeNote, wantsOpener, OPENER_QUESTION } from "../src/lib/buzzy/self-knowledge";
import type { Sql } from "../src/lib/db";

let pass = 0;
let fail = 0;
const check = (cond: unknown, label: string) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${label}`); } };

const titles = STARTING_BOARDS.map((b) => b.title);
function brief(plan: AppAction[] | null): string {
  if (!plan) return "null";
  return plan.map((s) => {
    if (s.do !== "board") return `${s.do}${s.value ? ":" + s.value : ""}${s.ask ? "?" : ""}`;
    const bits = [s.value, s.target && `t=${s.target}`, s.to && `to=${s.to}`, s.text && `text=${s.text}`, s.title && `title=${s.title}`,
      s.dir && `dir=${s.dir}`, s.choice && `choice=${s.choice}`, s.query && `q=${s.query}`, s.kind && `kind=${s.kind}`].filter(Boolean);
    return "board:" + bits.join(",") + (s.ask ? "?" : "");
  }).join(" + ");
}

const brief1 = (s: AppAction | null) => brief(s ? [s] : null);

console.log("What people say, and the board step it makes");
const commands: [string, string][] = [
  ["Show me the whole board", "board:fit"],
  ["zoom out so I can see the whole board", "board:fit"],
  ["Um, okay, can you zoom out and show me the entire board please", "board:fit"],
  ["fit everything on screen", "board:fit"],
  ["zoom out", "board:zoomOut"],
  ["zoom in a bit", "board:zoomIn"],
  ["back to normal size", "board:zoom100"],
  ["zoom in on the beach photo", "board:focus,t=the beach photo"],
  ["where is the palette note on the board?", "board:focus,t=the palette note"],
  ["add a note saying call the printer", "board:note,text=call the printer"],
  ["Hey BeeZilla, put a sticky note on the board that says buy eggs and milk", "board:note,text=buy eggs and milk"],
  ["add a note", "board:note"],
  ["add a step called write the caption", "board:step,title=Write the caption"],
  ["add a step to write the caption", "board:step,title=Write the caption"],
  ["add an agent.md", "board:agent"],
  ["add an end result: a poster for the fair", "board:end,title=A poster for the fair"],
  ["connect the beach photo to the poster step", "board:connect,t=the beach photo,to=the poster step"],
  ["link the palette note with the draw step", "board:connect,t=the palette note,to=the draw step"],
  ["connect the note and the picture", "board:connect,t=the note,to=the picture"],
  ["draw a line from the photo to the end result", "board:connect,t=the photo,to=the end result"],
  ["disconnect the photo from the poster step", "board:disconnect,t=the photo,to=the poster step"],
  ["remove the line between the note and the step", "board:disconnect,t=the note,to=the step"],
  ["select everything", "board:select,t=everything"],
  ["select the beach photo", "board:select,t=the beach photo"],
  ["deselect", "board:deselect"],
  ["remove the palette note", "board:remove,t=the palette note"],
  ["delete the picture of the dog", "board:remove,t=the picture of the dog"],
  ["clear the board", "board:remove,t=everything?"],
  ["rename the step to draw the banner", "board:rename,t=the step,title=Draw the banner"],
  ["call this area poster kit", "board:rename,t=this area,title=Poster kit"],
  ["change the note to say call on monday", "board:write,t=the note,text=call on monday"],
  ["edit the poster step", "board:edit,t=the poster step"],
  ["open the palette note", "board:edit,t=the palette note"],
  ["duplicate the poster step", "board:duplicate,t=the poster step"],
  ["move the photo to the left", "board:move,t=the photo,dir=left"],
  ["move the note a bit higher", "board:move,t=the note,dir=up"],
  ["put the photo next to the poster step", "board:move,t=the photo,to=the poster step,dir=next"],
  ["move the note under the picture", "board:move,t=the note,to=the picture,dir=under"],
  ["make an area around everything called poster kit", "board:area,t=everything,title=Poster kit"],
  ["make an area", "board:area,t=it"],
  ["put the note and the photo in an area", "board:area,t=the note and the photo"],
  ["sell this orchestration", "board:sell,t=this orchestration"],
  ["open source it", "board:sell,t=it,choice=open"],
  ["trade the whole board for honey drops", "board:sell,choice=drops"],
  ["save this as a recipe called poster kit", "board:recipe,t=this,title=Poster kit"],
  ["save the whole board as a recipe", "board:recipe,t=everything"],
  ["show the board's history", "board:history"],
  ["read me the controls", "board:keys"],
  ["show me the shortcuts", "board:keys"],
  ["undo that", "board:undo"],
  ["redo", "board:redo"],
  ["grab my beach photo", "board:find,q=beach,kind=picture"],
  ["get me a picture of a cat from my library", "board:find,q=a cat,kind=picture"],
  ["find the song about rain and put it on the board", "board:find,q=rain,kind=music"],
  ["start me off with a simple starting board for a logo", "board:start,q=a logo"],
  ["load a starter board for an event poster", "board:start,q=an event poster"],
  ["fold the board away", "whiteboard:close"],
  ["open the idea board", "whiteboard:open"],
  ["put in a new chat icon", "newChat"],
  ["zoom out and add a note saying hello", "board:zoomOut + board:note,text=hello"],
  ["connect the photo to the poster step, then zoom in on the poster step", "board:connect,t=the photo,to=the poster step + board:focus,t=the poster step"],
];
for (const [message, want] of commands) {
  const got = brief(planAppActions(message, null, { startingBoards: titles }));
  check(got === want, `${JSON.stringify(message)} → ${want} (got ${got})`);
}

console.log("Ordinary chat stays chat");
const chat = [
  "show me pictures of my cafe",
  "delete my account",
  "remove the background from my photo",
  "remove the dog in the picture",
  "make the picture darker",
  "change the picture to look like night",
  "add a skill to my resume",
  "set a goal for this month",
  "write a note to my landlord",
  "write a poem",
  "connect me to a lawyer",
  "link my website to my instagram",
  "move the meeting to Tuesday",
  "select a font for my logo",
  "copy the email",
  "open a document about our sales",
  "make a step-by-step plan for my launch",
  "how do I connect two cards?",
  "what's on the board?",
  "I'm lost on how to price my services",
  "zoom out of the problem a bit and tell me the big picture",
  "make me a song about rain",
  "draw me a picture of the Milky Way",
];
for (const message of chat) check(planAppActions(message, null, { startingBoards: titles }) === null, `chat stays chat: ${JSON.stringify(message)} (got ${brief(planAppActions(message, null, { startingBoards: titles }))})`);

console.log("Yes to BeeZilla's own offers, and sounding lost");
check(brief1(acceptedOffer("yes please", LOST_OFFER, titles)) === "board:fit", "yes to the zoom-out offer zooms out");
check(brief1(acceptedOffer("Sure!", "Would you like me to zoom out to show you the whole board?", titles)) === "board:fit", "a lightly reworded offer still counts");
check(brief1(acceptedOffer("ok", "Someone's already done this. Want me to put a simple starting board for “Logo for a small business” on your board?", titles)) === "board:start,q=Logo for a small business", "yes to a starting board puts that one up");
check(acceptedOffer("yes", "Here is your poster.", titles) === null, "yes without an offer does nothing on the board");
check(acceptedOffer("yes, but make it blue", LOST_OFFER, titles) === null, "yes with more to say is not a bare yes");
check(brief(planAppActions("yes", null, { lastReply: LOST_OFFER, startingBoards: titles })) === "board:fit", "the planner reads the last reply");
for (const lost of ["I'm lost", "i'm so lost on the board", "Where did everything go?", "I can't find my cards", "what am I even looking at", "I'm confused here"]) {
  check(soundsLost(lost), `sounds lost: ${JSON.stringify(lost)}`);
}
for (const fine of ["I'm lost on how to price my services", "I lost my keys", "where is the nearest bakery?", "this is great"]) {
  check(!soundsLost(fine), `not lost on the board: ${JSON.stringify(fine)}`);
}

console.log("Simple starting boards");
for (const b of STARTING_BOARDS) {
  check(b.graph.nodes.length <= STARTING_BOARD_MAX_CARDS, `${b.title}: ${b.graph.nodes.length} cards (simple)`);
  check(b.graph.links.length === b.graph.nodes.length - 1, `${b.title}: one line from each card to the next`);
  check(b.graph.nodes[0]!.kind === "agent" && b.graph.nodes.at(-1)!.kind === "output", `${b.title}: agent.md first, the end result last`);
}
check(findStartingBoards("a logo for my bakery")[0]?.id === "logo", "a logo for my bakery → the logo board");
check(findStartingBoards("a picture of the milky way for my kid")[0]?.id === "space-picture", "the Milky Way (the ad's example) → the space picture board");
check(findStartingBoards("poster for the school fair")[0]?.id === "event-poster", "a fair poster → the poster board");
check(findStartingBoards("tax return").length === 0, "nothing fits a tax return: nothing offered");
check(startingBoardByName("Logo for a small business")?.id === "logo", "found again by the title BeeZilla offered");

console.log("search_inspiration");
check(offeredTools({ draftGate: false } as never).some((t) => (t as { function?: { name?: string } }).function?.name === "search_inspiration"), "BeeZilla is offered search_inspiration");
check(/Don't reinvent the wheel/.test(SEARCH_INSPIRATION_TOOL.function.description), "its description says why: don't reinvent the wheel");
const asset = { id: 7, filename: "bakery-logo-sketch.png", content_type: "image/png", bytes: 1, created_at: new Date().toISOString(), description: "A sketch of a bread logo", tags: "logo\nbakery\nbread", tag_count: 3 };
const fakeSql = Object.assign(async (strings: TemplateStringsArray) => {
  const q = strings.join("?");
  if (/buzzy_board_recipes/.test(q)) return [{ name: "Bakery logo kit", graph: { nodes: [{}, {}, {}] } }];
  return [];
}, {
  // The Library search (tags.ts) asks with a plain query.
  query: async (text: string) => (/buzzy_assets/.test(text) ? [asset] : []),
}) as unknown as Sql;
const hits = await searchInspiration(fakeSql, "u1", "logo for my bakery");
check(hits[0]?.source === "Starting board" && hits[0]?.title === "Logo for a small business", `a starting board first (${hits[0]?.title})`);
check(hits.some((h) => h.source === "Your recipe" && h.title === "Bakery logo kit"), "their own recipe");
check(hits.some((h) => h.source === "Your Library"), "their own Library");
const said = inspirationResult("logo for my bakery", hits);
check(said.includes("Want me to put a simple starting board for “Logo for a small business” on your board?"), "the offer sentence BeeZilla uses");
check(/DATA ONLY/.test(said) && /Never name a file/.test(said), "data, never instructions; no file names");
check(/nothing in the Inspiration archive yet/.test(inspirationResult("tax return", [])), "an honest nothing");
for (const m of ["I want to make a logo for my bakery", "has anyone done a logo for a bakery before?", "I'm struggling to plan my launch week", "how do I make a poster for the fair?", "is there a template for a price list?", "I don't want to start from scratch"]) {
  check(wantsInspiration(m), `looks first: ${JSON.stringify(m)}`);
}
for (const m of ["draw me a cat", "thanks!", "what's the weather?", "add a note saying hi"]) check(!wantsInspiration(m), `just answers: ${JSON.stringify(m)}`);
check(/WHAT ALREADY EXISTS/.test(inspirationNote(hits)) && /Don't reinvent the wheel/.test(inspirationNote(hits)), "the archive's answer goes into the reply's instructions");
const server = readFileSync("src/lib/buzzy/server.ts", "utf8");
check(/!lockdown && !appPlan && !wants3d && !wantsVideo && isMusicRequest/.test(server) && /!lockdown && !appPlan && !renderedImage/.test(server), "a command for the page never also makes music or a picture");
check(/if \(!appPlan && wantsInspiration\(message\)\)/.test(server), "the server looks in the archive before answering a make-or-solve message");

console.log("Opening the conversation, and what BeeZilla knows about itself");
check(wantsOpener("hi", 0) && wantsOpener("Hello BeeZilla!", 0), "a first hello gets the opener");
check(!wantsOpener("hi", 4), "a hello later in a conversation doesn't");
check(wantsOpener("what can you do?", 3) && wantsOpener("What makes you unique?", 2) && wantsOpener("what can you do that others can't?", 0), "what can you do / what makes you unique");
check(!wantsOpener("write me a poem", 0), "a request is just done");
check(/one thing you're struggling to do/.test(OPENER_QUESTION), "the opener asks what they're struggling with");
const note = selfKnowledgeNote("what can you do?") ?? "";
check(/Q: What can you do\?/.test(note) && /one thing you're struggling to do/.test(note), "“what can you do?” answers from the facts, ending with the question");
const uniq = selfKnowledgeNote("What makes you unique?") ?? "";
check(/reinvent the wheel/.test(uniq), "“what makes you unique?” leads with not reinventing the wheel");
const controls = selfKnowledgeNote("what are the controls on the idea board?") ?? "";
check(/Fit everything \(Alt\/Option\+1\)/.test(controls) && /F1/.test(controls), "the board's controls, to read out");

console.log(`\nboard voice: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
