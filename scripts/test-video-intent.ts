/**
 * Intent tests for the video lane.
 *
 * The failure this pins is the one the kit brief names: a video request that the
 * model talks itself out of. Every order below must resolve to a recipe and start
 * a job; every question below must stay a conversation. The topic assertion is
 * separate and just as important — the kit renders what it is given, so "make me an
 * infographic about the water cycle" must not arrive as "make me an infographic".
 *
 * Run: npx tsx scripts/test-video-intent.ts
 */
import { isVideoRequest, videoAsk } from "../src/lib/buzzy/intent";

let failures = 0;
function expect(label: string, actual: boolean, want: boolean) {
  if (actual === want) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${actual}, want ${want}`);
  }
}
function expectRecipe(label: string, message: string, recipe: string) {
  const got = videoAsk(message);
  if (got && got.recipe === recipe) console.log(`  ok   ${label} -> ${recipe}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got ${got ? got.recipe : "null"}, want ${recipe}`);
  }
}
function expectTopic(label: string, message: string, want: string) {
  const got = videoAsk(message);
  const topic = got ? got.topic.trim().toLowerCase() : "";
  if (topic === want.toLowerCase()) console.log(`  ok   ${label} -> "${got!.topic}"`);
  else {
    failures += 1;
    console.error(`  FAIL ${label} — got "${got ? got.topic : "null"}", want "${want}"`);
  }
}

console.log("starts a job — chalkboard and infographic:");
for (const m of [
  "make me an infographic",
  "Make me a chalkboard video about photosynthesis",
  "explain the water cycle on a chalkboard",
  "chalkboard video: mitosis",
  "can you make an infographic about our Q3 numbers?",
  "I want a whiteboard animation explaining compound interest",
  "make me an infographic about the water cycle",
]) expect(JSON.stringify(m), isVideoRequest(m), true);

console.log("starts a job — the other four recipes:");
expectRecipe("paper-cut", "make me a paper-cut tips video about saving water", "ai-creator-tips-paper-cut");
expectRecipe("paper-cut short", "paper cut tips on punctuality", "ai-creator-tips-paper-cut");
expectRecipe("chart race", "make a chart race of streaming subscribers", "chart-race-from-your-numbers");
expectRecipe("bar chart race", "give me a bar chart race for the top five browsers", "chart-race-from-your-numbers");
expectRecipe("picture reel", "make me a picture reel of our shop", "picture-reel");
expectRecipe("photo reel", "reel of photos from the launch, please", "picture-reel");
expectRecipe("narrated explainer", "make a narrated explainer about tides", "narrated-explainer");
expectRecipe("plain video", "make a video about how yeast works", "narrated-explainer");

console.log("the chart race is the one recipe a sentence cannot start:");
for (const m of ["make a chart race of streaming subscribers", "give me a bar chart race for the top five browsers"]) {
  const got = videoAsk(m);
  if (got && got.needsTable === true) console.log(`  ok   "${m}" -> asks for the table`);
  else {
    failures += 1;
    console.error(`  FAIL "${m}" — needsTable was ${got ? got.needsTable : "null"}`);
  }
}
for (const m of ["make me an infographic about the water cycle", "make a narrated explainer about tides"]) {
  const got = videoAsk(m);
  if (got && got.needsTable === false) console.log(`  ok   "${m}" -> starts on the topic alone`);
  else {
    failures += 1;
    console.error(`  FAIL "${m}" — needsTable was ${got ? got.needsTable : "null"}`);
  }
}

console.log("topics — the request is not the topic:");
expectTopic("infographic", "make me an infographic about the water cycle", "the water cycle");
expectTopic("chalkboard", "explain photosynthesis on a chalkboard", "photosynthesis");
expectTopic("colon", "chalkboard video: mitosis", "mitosis");
expectTopic("chart race", "make a chart race of streaming subscribers", "streaming subscribers");
expectTopic("plain video", "make a video about how yeast works", "how yeast works");
expectTopic("want", "I want an infographic about compound interest", "compound interest");

console.log("does NOT start a job:");
for (const m of [
  "how do I make a chart race in matplotlib?",
  "what is an infographic?",
  "is an infographic better than a slide?",
  "how do chalkboard animations get made?",
  "tell me how to edit a video in DaVinci",
  "make me a song about chalkboards",
  "draw me a picture of a duck",
  "make a 3D model of a chalkboard",
  "what does a video cost?",
  "",
]) expect(JSON.stringify(m), isVideoRequest(m), false);

console.log("");
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all video-intent tests passed");
