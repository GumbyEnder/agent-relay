/**
 * Changing a picture by talking about it (owner, 2026-11-19): "So let's say we make an
 * image together. I can iterate on that image by just talking about the image."
 *
 *   - which messages are a change to the newest picture, and which are a new one;
 *   - what goes to the picture maker with the picture;
 *   - the list of what the conversation made, as the model reads it.
 *
 * Run: npx tsx scripts/test-picture-change.ts
 */
import { isPictureChange, isNewPictureAsk, changePrompt, pictureDataUrl, madeThingsSection } from "../src/lib/buzzy/pictureChange";

let failures = 0;
let passes = 0;
function expect(label: string, actual: unknown, want: unknown) {
  if (actual === want) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.error(`  FAIL ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}

console.log("a change to the picture in front of them:");
for (const m of [
  "make the sky darker",
  "make it darker",
  "Make it at night",
  "now make it at night",
  "can you make the sky a little bit darker?",
  "um can you make the roof red",
  "add a dog on the porch",
  "Add a rainbow",
  "remove the tree on the left",
  "take out the boat",
  "get rid of the clouds",
  "change the roof to red",
  "turn it into a winter scene",
  "give it a red roof",
  "put a moon in the sky",
  "zoom out a bit",
  "darker",
  "a bit brighter",
  "more colorful",
  "less busy please",
  "at sunset",
  "in watercolour",
  "same but bigger",
  "the same picture but at night",
  "another version",
  "try again",
  "do it again but with snow",
  "with a red door",
  "without the fence",
  "the sky is too dark",
  "it needs more light",
  "I like it but the sky should be pink",
  "how about a red roof?",
  "ok great, now add some birds",
  "keep everything but make the house blue",
  "same house but at night",
  "a version with a cat in the window",
]) expect(m, isPictureChange(m), true);

console.log("not a change (a new picture, a question, or something else):");
for (const m of [
  "draw me a cat",
  "make me a picture of a dog",
  "make a logo for my bakery",
  "paint a lighthouse on a cliff",
  "draw a cat instead",
  "a new picture of a boat",
  "what's in the picture?",
  "why is it so dark?",
  "is it saved in my library?",
  "save it to my library",
  "put it on the board",
  "share it with my team",
  "I love it",
  "thanks!",
  "it's perfect, thank you",
  "make me a short happy song",
  "write a letter to my landlord",
  "make the song longer",
  "let's move on",
  "how do I download it?",
  "delete it",
  "",
]) expect(m || "(empty)", isPictureChange(m), false);

console.log("a new subject is a new picture:");
expect("draw me a duck", isNewPictureAsk("draw me a duck"), true);
expect("make a poster for the bake sale", isNewPictureAsk("make a poster for the bake sale"), true);
expect("create a different picture of a forest", isNewPictureAsk("create a different picture of a forest"), true);
expect("the same picture but at night is not new", isNewPictureAsk("the same picture but at night"), false);
expect("make it darker is not new", isNewPictureAsk("make it darker"), false);

console.log("what goes to the picture maker with the picture:");
const p = changePrompt("make the sky darker");
expect("it says what to change", p.includes("The change: make the sky darker"), true);
expect("and to keep the rest", /keep everything else/.test(p), true);
expect("long changes are capped", changePrompt("x".repeat(5000)).length < 1300, true);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
expect("a stored PNG becomes a data URL", pictureDataUrl(png, "image/png"), "data:image/png;base64," + png.toString("base64"));
expect("a song is not a picture", pictureDataUrl(png, "audio/mpeg"), null);
expect("nothing stored, nothing sent", pictureDataUrl(Buffer.alloc(0), "image/png"), null);
expect("too big to send is drawn without it", pictureDataUrl(Buffer.alloc(9 * 1024 * 1024), "image/png"), null);

console.log("what the conversation made, as the model reads it:");
const now = Date.parse("2026-11-19T18:00:00Z");
const made = madeThingsSection([
  { id: 1, filename: "art-2026-11-19-17-48-00.png", contentType: "image/png", createdAt: "2026-11-19T17:48:00Z", brief: "draw me a house by a lake" },
  { id: 2, filename: "music-2026-11-19-17-55-00.mp3", contentType: "audio/mpeg", createdAt: "2026-11-19T17:55:00Z", brief: "make me a calm song to go with it" },
  { id: 3, filename: "art-2026-11-19-17-59-30.png", contentType: "image/png", createdAt: "2026-11-19T17:59:30Z", brief: "make the sky darker" },
], now);
expect("it is numbered, oldest first", /1\. A picture BeeZilla made — asked as: "draw me a house by a lake" \(12 minutes ago\)/.test(made), true);
expect("a song is a song", /2\. A song BeeZilla made — asked as: "make me a calm song to go with it" \(5 minutes ago\)/.test(made), true);
expect("the newest picture is the one a change draws from", /3\. A picture BeeZilla made — asked as: "make the sky darker" \(just now\)/.test(made) && /draws the new version FROM it/.test(made), true);
expect("no file names reach the model", /art-2026|music-2026|\.png|\.mp3/.test(made), false);
expect("nothing made, nothing said", madeThingsSection([], now), "");
const songLast = madeThingsSection([
  { id: 1, filename: "art-a.png", contentType: "image/png", createdAt: "2026-11-19T17:48:00Z" },
  { id: 2, filename: "music-b.mp3", contentType: "audio/mpeg", createdAt: "2026-11-19T17:58:00Z" },
], now);
expect("when the newest is a song, nothing says a picture change draws from it", /draws the new version FROM it/.test(songLast), false);
const many = madeThingsSection(Array.from({ length: 20 }, (_, i) => ({ id: i, filename: `art-${i}.png`, contentType: "image/png", createdAt: "2026-11-19T17:00:00Z", brief: `picture ${i}` })), now);
expect("only the last twelve are listed", /^12\. /m.test(many) && !/^13\. /m.test(many) && /picture 19/.test(many) && !/picture 7"/.test(many), true);

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
