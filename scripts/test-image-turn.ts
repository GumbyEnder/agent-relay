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
import { repairImageReply, deniesImageCapability, fakesImageAction, deliveryClaimIsFalse, IMAGE_TURN_SENTENCE } from "../src/lib/buzzy/artReply";
import { pickImageUrl, describePayload, normalizeImageUrl, fetchImageUrl } from "../src/lib/buzzy/art";
import { isImageRequest } from "../src/lib/buzzy/intent";

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

console.log("the provider's envelope is not the only envelope:");
const TINY = "A".repeat(80);
const SHAPES: Array<[string, unknown]> = [
  ["message.images[0].image_url.url", { choices: [{ message: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${TINY}` } }] } }] }],
  ["message.images[0].image_url as string", { choices: [{ message: { images: [{ image_url: `data:image/png;base64,${TINY}` }] } }] }],
  ["message.images[0].url", { choices: [{ message: { images: [{ url: `https://cdn.example/x.png` }] } }] }],
  ["message.images[0] bare base64", { choices: [{ message: { images: [TINY] } }] }],
  ["content part image_url{url}", { choices: [{ message: { content: [{ type: "text", text: "here" }, { type: "image_url", image_url: { url: `data:image/webp;base64,${TINY}` } }] } }] }],
  ["content part output_image url", { choices: [{ message: { content: [{ type: "output_image", url: `https://cdn.example/y.png` }] } }] }],
  ["content part inline_data", { choices: [{ message: { content: [{ type: "image", inline_data: { mime_type: "image/jpeg", data: TINY } }] } }] }],
  ["content string with data url", { choices: [{ message: { content: `Here you go: data:image/png;base64,${TINY}` } }] }],
];
for (const [label, body] of SHAPES) {
  const got = pickImageUrl(body);
  expect(`picked: ${label}`, typeof got.url === "string" && got.url.length > 10, true);
}

console.log("no image — the reason, never the payload:");
const refused = pickImageUrl({ choices: [{ finish_reason: "stop", message: { content: "I can't do that.", refusal: "policy" } }] });
expect("no url", Boolean(refused.url), false);
expect("reason names the refusal", /policy/.test(String(refused.reason)), true);
const shape = JSON.stringify(describePayload({ choices: [{ message: { content: "x".repeat(5000), images: [] } }] }));
expect("shape has no payload", shape.includes("xxxx"), false);
expect("shape names content length", /string\(5000\)/.test(shape), true);

console.log("a scene described after the ask is still the ask:");
const hist = [
  { role: "user", content: "can you make me a picture of a house on the coast" },
  { role: "assistant", content: "Here's the picture you asked for." },
];
for (const msg of ["a Spanish tile, a white house, terracotta roof", "the house with blue shutters and a red door"]) {
  expect(`draws: ${msg.slice(0, 40)}…`, isImageRequest(msg, { history: hist }), true);
}
for (const msg of ["what style suits a white house?", "how do I clean terracotta tiles"]) {
  expect(`does not draw: ${msg.slice(0, 40)}…`, isImageRequest(msg, { history: hist }), false);
}
expect("no context, no draw", isImageRequest("a Spanish tile, a white house", undefined), false);
expect("make-phrasings still draw", isImageRequest("Make me a picture of a house"), true);
expect("English verb + noun still draws", isImageRequest("Can you draw me a picture of a red sports car"), true);

console.log("the provider's link is untrusted input:");
// A model can hand back any URL. Anything but plain https on a public host is
// refused before a socket is opened, and a redirect is re-checked like a hop.
const BAD_SCHEMES = [
  "http://cdn.example/x.png",
  "ftp://cdn.example/x.png",
  "data:image/png;base64,AAAA",
  "https://user:pass@cdn.example/x.png",
  "https://cdn.example:8080/x.png",
  "https://localhost/x.png",
  "https://box.local/x.png",
  "https://metadata.internal/x.png",
];
for (const url of BAD_SCHEMES) {
  expect(`refused: ${url.slice(0, 44)}`, normalizeImageUrl(url) === null, true);
}
expect("plain https is kept", normalizeImageUrl("https://cdn.example/x.png?t=1") !== null, true);

const PRIVATE = [
  "https://127.0.0.1/x.png",
  "https://127.1.2.3/x.png",
  "https://10.0.0.5/x.png",
  "https://172.16.4.9/x.png",
  "https://192.168.1.20/x.png",
  "https://169.254.169.254/latest/meta-data",
  "https://100.64.0.9/x.png",
  "https://[::1]/x.png",
  "https://[fe80::1]/x.png",
  "https://[fd00::1]/x.png",
  "https://2130706433/x.png", // URL parsing turns this into 127.0.0.1
];
for (const url of PRIVATE) {
  const got = await fetchImageUrl(url, Date.now());
  expect(`blocked at fetch: ${url.slice(0, 44)}`, !got.ok && got.code === "image_url_blocked", true);
}

// The first hop is public, the redirect is not. The hop loop must catch it.
const realFetch = globalThis.fetch;
let redirectCalls = 0;
globalThis.fetch = (async () => {
  redirectCalls += 1;
  return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/x.png" } });
}) as unknown as typeof fetch;
try {
  const hopped = await fetchImageUrl("https://93.184.216.34/x.png", Date.now());
  expect("a public link is fetched", redirectCalls === 1, true);
  expect("the redirect is refused", !hopped.ok && hopped.code === "image_url_blocked", true);
} finally {
  globalThis.fetch = realFetch;
}

console.log("the server names the art time separately:");
expect("artMs is declared", /let artMs = 0;/.test(server), true);
expect("artMs is subtracted from extractMs", /Date\.now\(\) - extractStarted - artMs/.test(server), true);
expect("artMs is in the timings", /timings: \{\s*extractMs,\s*artMs,/.test(server), true);
expect("a failed draw names the real error", /artRefusal && \(deniesImageCapability/.test(server), true);

console.log("the working line sits under the newest prompt:");
expect("inserted after the prompt", /insertBefore\(thinkingEl, newestPrompt\.nextSibling\)/.test(talk), true);
expect("no jump to the bottom of a newest-first thread", /messagesContainer\.scrollTop = messagesContainer\.scrollHeight/.test(talk), false);

// Measured live 2026-11-18 on e0d388b (production, beezilla.net, signed in):
// "draw me a duck" stored asset 8294 (1408x768 PNG) and returned it in the
// envelope, and the reply read "I did not actually produce anything that turn,
// so nothing was saved to your Library." An image-only turn is not a
// producesDeliverable() turn, so the delivery-claim guard fired on a sentence
// that was true. The guard has to exempt the picture it just made, and the page
// needs the project id it builds the Library link from.
console.log("a picture turn's true sentence survives the delivery guard:");
expect("nothing made → the claim is false", deliveryClaimIsFalse({ document: false, audio: false, image: false }), true);
expect("a picture was made → the claim stands", deliveryClaimIsFalse({ document: false, audio: false, image: true }), false);
expect("a track was made → the claim stands", deliveryClaimIsFalse({ document: false, audio: true, image: false }), false);
expect("a document was made → the claim stands", deliveryClaimIsFalse({ document: true, audio: false, image: false }), false);
expect(
  "the guard asks that helper rather than re-deriving it",
  /CLAIMS_DELIVERY\.test\(finalReply\) &&\s*deliveryClaimIsFalse\(\{ document: deliversThisTurn, audio: Boolean\(renderedAudio\), image: Boolean\(renderedImage\) \}\)/.test(server),
  true,
);
expect("an image turn echoes its project id", /response\.jobId = artJobId;/.test(server), true);

console.log("");
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all image-turn tests passed");
