/**
 * The buffered-turn stage label.
 *
 * The failure these pin: a buffered document turn (a draft, an explicit file
 * request, a browser job) paints nothing until the whole answer exists, so the
 * page showed only the seconds counter — identical whether a document was
 * being written or the turn was hung. Music/video/art/3D turns already named
 * their work through onStage; the document path did not.
 *
 * The fix is one stage at the start of the buffered branch, with a label that
 * tells a file from a chat reply. The streaming branch must stay silent before
 * its first token: the words arriving ARE the progress, and a label there would
 * claim work the page cannot see.
 *
 * Run: npx tsx scripts/test-turn-stage.ts (wired into test:ci)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { turnStageFor } from "../src/lib/buzzy/turnStage";

let failures = 0;
function expect(label: string, actual: boolean, want = true) {
  if (actual === want) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${actual}, want ${want}`);
  }
}

console.log("the streaming lane announces nothing:");
expect("stream, chat reply", turnStageFor("stream") === null);
expect("stream, document expected", turnStageFor("stream", { expectsDocument: true }) === null);

console.log("the buffered lane names the wait:");
const reply = turnStageFor("buffered");
const doc = turnStageFor("buffered", { expectsDocument: true });
expect("reply stage exists", reply !== null);
expect("document stage exists", doc !== null);
if (reply && doc) {
  expect("reply label names the reply", /reply/i.test(reply.label));
  expect("document label names the document", /document/i.test(doc.label));
  expect("the two labels are distinct", reply.label !== doc.label);
  expect("reply phase", reply.phase === "reply");
  expect("document phase", doc.phase === "document");
  expect("both carry a positive ETA", reply.etaMs > 0 && doc.etaMs > 0);
}

console.log("the wiring in chatLoop matches the rule:");
const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(here, "..", "src", "lib", "buzzy", "server.ts"), "utf8");
// The streaming branch is the `else if (typeof req.onText …` block; nothing in
// it may call onStage before chatCompletionStream hands over its first delta.
const streamStart = server.indexOf('} else if (typeof req.onText === "function"');
const streamCall = server.indexOf("chatCompletionStream(", streamStart);
expect("streaming branch found", streamStart > 0 && streamCall > streamStart);
if (streamStart > 0 && streamCall > streamStart) {
  expect("no stage in the streaming branch", !/onStage/.test(server.slice(streamStart, streamCall)));
}
// The buffered branch is the plain `else` that runs chatCompletionFull with the
// turn's tool list. It must emit the buffered stage before that call.
const bufferedCall = server.indexOf('reply = await chatCompletionFull(messages, { model: routedModel, tools: loopTools');
expect("buffered call found", bufferedCall > 0);
if (bufferedCall > 0) {
  const before = server.slice(Math.max(0, bufferedCall - 900), bufferedCall);
  expect("buffered branch emits a stage", /req\.onStage\?\.\(bufferedStage\)/.test(before));
  expect("buffered stage comes from turnStageFor", /turnStageFor\("buffered"/.test(before));
  expect("file turns get the document label", /expectsDocument: explicitDocumentRequest \|\| requestedDraft/.test(before));
}

console.log(failures === 0 ? "turn-stage: all checks passed" : `turn-stage: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
