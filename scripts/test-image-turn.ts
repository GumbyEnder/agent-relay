/**
 * The picture-turn tests.
 *
 * Two failures were measured on production 2026-11-17 (4bf4ec26), and both are
 * pinned here with the strings that actually came back:
 *
 *   * the picture was made and stored (asset 8282 / 8283), and the reply denied
 *     the capability — voice lane: "I can't draw or create images directly
 *     here."; text lane: a fabricated {"action":"dalle.text2im", …} blob;
 *   * the page never drew a card, because talk.html read data.audio and
 *     data.asset and never data.image.
 *
 * Run: npx tsx scripts/test-image-turn.ts
 */
import { readFileSync } from "node:fs";
import { repairImageReply, deniesImageCapability, fakesImageAction, IMAGE_TURN_SENTENCE } from "../src/lib/buzzy/artReply";

let failures = 0;
function expect(label: string, actual: boolean, want: boolean) {
  if (actual === want) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${actual}, want ${want}`);
  }
}

console.log("a rendered picture is a fact — the reply cannot deny it:");
const DENIALS = [
  "I can't draw or create images directly here. However, you could use a graphic design tool.",
  "I cannot generate images, but I can describe one for you.",
  "I'm unable to create pictures in this chat.",
  "I don't have the ability to make images.",
  "I am not able to produce illustrations.",
];
for (const reply of DENIALS) {
  expect(`denies: ${reply.slice(0, 46)}…`, deniesImageCapability(reply), true);
  expect(`repaired: ${reply.slice(0, 40)}…`, repairImageReply(reply) === IMAGE_TURN_SENTENCE, true);
}

console.log("a fabricated tool call is not a sentence:");
const FAKES = [
  '{"action": "dalle.text2im", "action_input": "{\\"prompt\\": \\"A duck\\"}", "thought": "…"}',
  '  {"tool": "generate_image", "args": {"prompt": "duck"}}',
];
for (const reply of FAKES) {
  expect(`fakes an action: ${reply.slice(0, 40)}…`, fakesImageAction(reply), true);
  expect(`repaired: ${reply.slice(0, 40)}…`, repairImageReply(reply) === IMAGE_TURN_SENTENCE, true);
}

console.log("an honest description is left alone:");
const HONEST = [
  "A solitary lighthouse stands against a gradient sky of deep indigo and soft orange as the sun sets behind it.",
  "Here's the picture you asked for — it's below in this reply, and a copy is saved in your Library.",
  "The image shows a flat yellow duck in profile on a neutral background. It is saved in your Library.",
  // "can't" about something else must not trip the repair
  "I couldn't find that font, but the poster is attached — the duck sits on a cream background.",
];
for (const reply of HONEST) {
  expect(`kept: ${reply.slice(0, 46)}…`, repairImageReply(reply) === null, true);
}

console.log("the chat page draws the picture the server sent:");
const talk = readFileSync(new URL("../public/buzzy/talk.html", import.meta.url), "utf8");
expect("reply reads data.image", /data\.audio \|\| data\.asset \|\| data\.image/.test(talk), true);
expect("an artifacts fallback exists", /function firstImageArtifact\(/.test(talk), true);
expect("an image card links to the Library", /In your Library →/.test(talk), true);

console.log("the server repeats the fact after the owner's message:");
const server = readFileSync(new URL("../src/lib/buzzy/server.ts", import.meta.url), "utf8");
expect("a trailing note is pushed", /afterNotes\.length\) messages\.push\(\{ role: "system"/.test(server), true);
expect("the picture turn is repaired", /if \(renderedImage\) \{\s*const repaired = repairImageReply/.test(server), true);

console.log("");
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all image-turn tests passed");
