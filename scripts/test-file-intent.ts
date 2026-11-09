/**
 * Intent tests for the save-to-file path.
 *
 * These are the sentences a real person types. The failure they pin is specific:
 * "research this and save it in the file" never opened the draft gate, so no
 * render tool was offered, so nothing was produced and nothing reached the
 * Library — while the product claimed it could save files.
 *
 * Run: npx tsx scripts/test-file-intent.ts
 */
import { is3dRequest, isDraftRequest, isExplicitDocumentRequest, isFileRequest, isMusicRequest, isRevisionRequest, producesDeliverable } from "../src/lib/buzzy/intent";

let failures = 0;
function expect(label: string, actual: boolean, want: boolean) {
  if (actual === want) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${actual}, want ${want}`);
  }
}

console.log("counts as a file request:");
for (const m of [
  "Research the current USPS stamp price and save it in the file.",
  "Save it in the file",
  "save this to a file",
  "put this in a document for me",
  "make a file I can send",
  "write this up as a PDF",
  "export it as markdown",
  "save a copy",
  "keep a record of this in my library",
  "create a report from what you find",
  "save the summary",
]) expect(JSON.stringify(m), isFileRequest(m), true);

console.log("does NOT count as a file request:");
for (const m of [
  "what does a first class stamp cost?",
  "thanks, that saves me time",
  "how do I file a complaint with the county?",
  "summarize this in two sentences",
  "who should sign off on quotes?",
]) expect(JSON.stringify(m), isFileRequest(m), false);

console.log("draft request (file request OR the owner says enough):");
expect("write it up", isDraftRequest("ok, write it up"), true);
expect("that's enough", isDraftRequest("that's enough — go ahead"), true);
expect("plain question", isDraftRequest("what is a lien waiver?"), false);
expect("file phrasing", isDraftRequest("save it in the file"), true);

console.log("explicit document request (forces render_document):");
for (const m of [
  "give me the word document",
  "save it in the file",
  "put this in a doc",
  "as a .docx please",
  "produce the file",
]) expect(JSON.stringify(m), isExplicitDocumentRequest(m), true);
expect("plain question", isExplicitDocumentRequest("what does it cost?"), false);

console.log("revision of the draft on file (not a question about it):");
for (const m of [
  "make the second paragraph shorter",
  "can you make the intro shorter?",
  "add a line about our weekend hours",
  "change the price to 450",
  "rewrite the opening so it sounds less stiff",
  "drop the last sentence",
]) expect(JSON.stringify(m), isRevisionRequest(m), true);
for (const m of [
  "what is a fence quote?",
  "Reply with exactly: pong",
  "In one short sentence: what is a fence quote?",
  "what does it cost?",
  "how do I file a complaint with the county?",
  "who should sign off on quotes?",
  "what should I add to the quote?",
]) expect(JSON.stringify(m), isRevisionRequest(m), false);

console.log("delivers a document this turn:");
const turn = (over: Partial<Parameters<typeof producesDeliverable>[0]>) =>
  producesDeliverable({
    renderedDocText: null,
    requestedDraft: false,
    mode: "chat" as const,
    draftGateOpen: false,
    hasExistingDraft: false,
    message: "",
    ...over,
  });
// The production defect, as a test: gate open on inherited memory, plain question.
expect(
  "chat + gate open + plain question (the bug)",
  turn({ draftGateOpen: true, message: "In one short sentence: what is a fence quote?" }),
  false,
);
expect("chat + existing draft + 'pong' (the bug)", turn({ draftGateOpen: true, hasExistingDraft: true, message: "Reply with exactly: pong" }), false);
expect("chat + owner asks for the file", turn({ requestedDraft: true, draftGateOpen: true, message: "save it in the file" }), true);
expect("chat + revision of the draft", turn({ draftGateOpen: true, hasExistingDraft: true, message: "make the second paragraph shorter" }), true);
expect("the render tool actually ran", turn({ renderedDocText: "# Quote\n…" }), true);
expect("work mode, brief confirmed", turn({ mode: "work", draftGateOpen: true, message: "ok, go ahead" }), true);
expect("work mode, still discovering", turn({ mode: "work", draftGateOpen: false, message: "it's a fence job" }), false);
expect("fresh chat, no gate", turn({ message: "hello" }), false);

// Talk has no Music or 3D button: the words in the box are the only way in, so a
// miss means the person asked and nothing was made, and a false hit spends a plan.
console.log("asks for music:");
for (const m of [
  "make me a song about ducks",
  "I want a song about my dog",
  "I need some background music for my shop",
  "can I get a jingle for my bakery",
  "I’d like a happy birthday song for my mom",
  "play me a lullaby",
]) expect(JSON.stringify(m), isMusicRequest(m), true);
for (const m of [
  "I need a song recommendation",
  "I want to learn music",
  "I need a theme for my website",
  "I need help with my music career",
  "Do you want music in the video?",
]) expect(JSON.stringify(m), isMusicRequest(m), false);

console.log("asks for a 3D model:");
for (const m of [
  "make a 3D model of a duck",
  "Can you make a 3D model of a red sports car?",
  "create a 3-D dragon for my game",
  "build me a three-dimensional model of my house",
  "I want a 3D model of my house",
  "I’d like a 3D version of our logo",
  "3D model of a coffee mug",
  "What do you think? Make a 3D cupcake.",
  "make a 3D model of a 3D printer",
  "make a 3D model of a race track",
]) expect(JSON.stringify(m), is3dRequest(m), true);
for (const m of [
  "how do I make a 3D model in Blender?",
  "what is 3D printing?",
  "make a document about 3D printing",
  "I need a 3D printer recommendation",
  "I want to learn 3D",
  "make the button look 3D",
  "make a document with a 3D pie chart",
  "make me a song about ducks",
]) expect(JSON.stringify(m), is3dRequest(m), false);

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("file intent: all checks passed");
