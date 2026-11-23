/**
 * Code Monkey's workshop — the policy contract (src/lib/buzzy/codeMonkey.ts).
 *
 * Pins the rules that must never drift: the model can raise caution but never
 * lower it, vague checks are refused, slices are end-to-end and acyclic, and the
 * brief a worker gets carries the guardrails and the proof to bring back.
 * Run: npx tsx scripts/test-code-monkey.ts
 */
import {
  stakesFloor,
  settleStakes,
  doorFor,
  reviewPolicy,
  isVagueCheck,
  normalizeCard,
  validateCard,
  normalizeSlices,
  validateSlices,
  topoOrder,
  settleSlices,
  stateFromColumn,
  slicesToRelease,
  missionBrief,
  authorizedByWords,
  providerOf,
  reviewIsIndependent,
} from "../src/lib/buzzy/codeMonkey";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("stakes — the words set a floor the model can't talk down:");
check("bedtime game for my kids reads as play", stakesFloor("a bedtime adventure game for my kids, 8 and 10").floor === "play");
check("…and carries a play hint", stakesFloor("a bedtime adventure game for my kids").playHints.length > 0);
check("a game for kids everywhere on Steam is product", stakesFloor("publish a game kids everywhere will enjoy on Steam").floor === "product");
check("a salon booking page that takes payments is critical", stakesFloor("booking page for my salon that takes card payments").floor === "critical");
check("health records are critical", stakesFloor("track my patients' health records").floor === "critical");
check("a sign-in page is critical", stakesFloor("add a sign-in page with passwords").floor === "critical");
check("model says play, words say payments → raised to critical", settleStakes("play", "kids' lemonade stand app that charges cards").stakes === "critical");
check("raising is reported", settleStakes("play", "charges credit cards").raised === true);
check("model may be MORE careful than the words", settleStakes("critical", "a toy for me").stakes === "critical");
check("no proposal defaults to product", settleStakes(undefined, "a tool").stakes === "product");

console.log("doors — code decides, the model can only add caution:");
check("sending emails is one-way", doorFor({ title: "Send the newsletter to subscribers", shows: "", doneWhen: [] }).door === "one-way");
check("deleting old data is one-way", doorFor({ title: "Clean up", shows: "", doneWhen: [{ text: "Delete old records older than a year" }] }).door === "one-way");
check("publishing to the App Store is one-way", doorFor({ title: "Submit to the App Store", shows: "", doneWhen: [] }).door === "one-way");
check("a new screen is two-way", doorFor({ title: "Play the first scene", shows: "open the link and tap Start", doneWhen: [{ text: "Tapping Start shows the forest scene" }] }).door === "two-way");
check("hint can raise a two-way slice", doorFor({ title: "Play the first scene", shows: "x", doneWhen: [], oneWayHint: true }).door === "one-way");

console.log("review policy (owner, 2026-11-23: every step reviewed by another company):");
const playTwo = reviewPolicy("play", "two-way");
check("play + two-way: automatic, no owner, still reviewed by another company", playTwo.autoAccept && !playTwo.ownerLooks && playTwo.independentReview);
check("play proof: tests, try it, screenshots, review", playTwo.proof.join() === "tests,try-it,screenshot,independent-review", playTwo.proof.join());
const prodTwo = reviewPolicy("product", "two-way");
check("product + two-way: automatic, reviewed, with a recorded walk-through", prodTwo.autoAccept && prodTwo.independentReview && prodTwo.proof.includes("video") && prodTwo.proof.includes("tests"));
const anyOne = reviewPolicy("play", "one-way");
check("one-way door: owner looks even for play, with an undo note", anyOne.ownerLooks && !anyOne.autoAccept && anyOne.proof.includes("undo-note"));
const crit = reviewPolicy("critical", "two-way");
check("critical: owner looks + review + security check + undo note", crit.ownerLooks && crit.independentReview && crit.proof.includes("security-check") && crit.proof.includes("undo-note"));
check("every tier and door is independently reviewed", (["play", "product", "critical"] as const).every((t) => (["two-way", "one-way"] as const).every((d) => reviewPolicy(t, d).independentReview)));

console.log("who reviews — a different company, or it doesn't count:");
check("claude_code is Anthropic, codex is OpenAI", providerOf("claude_code") === "anthropic" && providerOf("codex") === "openai");
check("a run-any-model harness needs its company named", providerOf("hermes") === null && providerOf("hermes", "DeepSeek") === "deepseek");
check("Anthropic reviewed by OpenAI is independent", reviewIsIndependent("anthropic", "openai"));
check("same company is not independent", !reviewIsIndependent("openai", "openai"));
check("unknown is not independent", !reviewIsIndependent("anthropic", null) && !reviewIsIndependent(null, null));

console.log("the owner's own words can authorize launching and messaging — nothing else:");
check("'…publish it on itch.io…' authorizes a launch, quoting the whole sentence", authorizedByWords("Make a puzzle game. When it works, publish it on itch.io so everyone can play. Thanks!", "publish") === "When it works, publish it on itch.io so everyone can play.");
check("'email my subscribers' authorizes sending", Boolean(authorizedByWords("Build the launch page and email my subscribers when it's ready", "message")));
check("no launch words, no launch authorization", authorizedByWords("Make a puzzle game for kids", "publish") === null);
check("money is never authorized by words", authorizedByWords("charge every customer now", "money") === null);
check("deleting is never authorized by words", authorizedByWords("delete all the old records", "delete") === null);
check("doors carry their kind", doorFor({ title: "Publish it on itch.io", shows: "", doneWhen: [] }).kind === "publish" && doorFor({ title: "Text the parents a reminder", shows: "", doneWhen: [] }).kind === "message");

console.log("checks must pass or fail:");
check("'looks professional' is vague", isVagueCheck("It looks professional"));
check("'user-friendly' is vague", isVagueCheck("The app is user-friendly"));
check("'loads fast — under 2 seconds' is measurable", !isVagueCheck("Every page loads fast, under 2 seconds"));
check("'Tapping Start shows the forest scene' is fine", !isVagueCheck("Tapping Start shows the forest scene"));
check("too short is vague", isVagueCheck("works"));

console.log("result card:");
const card = normalizeCard({
  making: "  a bedtime adventure game  ",
  forWhom: "me and my two kids (8 and 10)",
  outcome: "we play a 10-minute story together before lights out",
  doneWhen: ["The kids can pick a hero and start a story on the iPad", { text: "A story ends in under 10 minutes" }, "It looks professional"],
  stakes: "play" as const,
  stakesWhy: "family fun",
  assumptions: ["Works in the iPad's browser, no install"],
  notDoing: ["No accounts or sign-in"],
});
check("normalizes text and strings-or-objects", card.making === "a bedtime adventure game" && card.doneWhen.length === 3);
const cardProblems = validateCard(card);
check("flags exactly the vague check", cardProblems.length === 1 && /professional/.test(cardProblems[0]), cardProblems.join(" | "));
check("unknown stakes become product", normalizeCard({ stakes: "yolo" as never }).stakes === "product");
check("an empty card lists what's missing", validateCard(normalizeCard({})).length >= 4);

console.log("slices — end to end, in an order that can't loop:");
const slices = normalizeSlices([
  { key: "S1", title: "Pick a hero and see the first scene", shows: "open the link, tap a hero", doneWhen: ["Tapping a hero shows the forest scene"], after: [] },
  { key: "s2", title: "Make choices that change the story", shows: "tap a choice", doneWhen: ["Each choice leads to a different next scene"], after: ["s1"] },
  { key: "s3", title: "Hear the story read aloud", shows: "tap the speaker", doneWhen: ["Tapping the speaker reads the scene aloud"], after: ["s1"] },
  { key: "s4", title: "The story ends with a goodnight screen", shows: "finish a story", doneWhen: ["Every path reaches the goodnight screen within 8 choices"], after: ["s2", "s3"] },
]);
check("keys are lower-cased", slices[0].key === "s1");
check("a good plan has no problems", validateSlices(slices).length === 0, validateSlices(slices).join(" | "));
const order = topoOrder(slices)!;
check("order respects 'after'", order.indexOf("s1") < order.indexOf("s2") && order.indexOf("s2") < order.indexOf("s4") && order.indexOf("s3") < order.indexOf("s4"));
check("a cycle is caught", topoOrder([{ key: "a", after: ["b"] }, { key: "b", after: ["a"] }]) === null);
const cyc = validateSlices(normalizeSlices([
  { key: "a", title: "See A", shows: "x", doneWhen: ["A shows a list of 3 items"], after: ["b"] },
  { key: "b", title: "See B", shows: "y", doneWhen: ["B shows a list of 3 items"], after: ["a"] },
]));
check("cycle reported in plain words", cyc.some((p) => /circle|straight away/.test(p)), cyc.join(" | "));
const horizontal = validateSlices(normalizeSlices([{ key: "s1", title: "Set up the database", shows: "", doneWhen: ["Tables exist"], after: [] }]));
check("a layer-only slice is refused", horizontal.some((p) => /one layer/.test(p)), horizontal.join(" | "));
const dangling = validateSlices(normalizeSlices([{ key: "s1", title: "See it", shows: "x", doneWhen: ["It shows 3 cards"], after: ["s9"] }]));
check("waiting on a missing slice is refused", dangling.some((p) => /doesn't exist/.test(p)));
check("at most 8 slices kept", normalizeSlices(Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, title: "t", shows: "s", doneWhen: ["x shows 1"], after: [] }))).length === 8);

console.log("states and release:");
check("running → working", stateFromColumn("running") === "working");
check("needs_human → needs-you", stateFromColumn("needs_human") === "needs-you");
check("review → checking", stateFromColumn("review") === "checking");
check("blocked → waiting", stateFromColumn("blocked") === "waiting");
const cols = { s1: "done", s2: "done", s3: "running", s4: "blocked" };
check("s4 waits while s3 runs", slicesToRelease(slices, cols).length === 0);
check("s4 releases when s2 and s3 are done", slicesToRelease(slices, { ...cols, s3: "done" }).join() === "s4");
check("a slice with no 'after' is never 'released' twice", !slicesToRelease(slices, { s1: "blocked" }).includes("s1"));

console.log("the worker's brief:");
const settled = settleSlices(slices);
const brief = missionBrief(card, settled[3], settled);
check("objective says how the owner tries it", /goodnight/.test(brief.objective) && /finish a story/.test(brief.objective));
check("context names who it's for and why", /two kids/.test(brief.context) && /10-minute/.test(brief.context));
check("context says what it builds on", /Builds on/.test(brief.context));
check("acceptance lists the slice's checks and the proof", /within 8 choices/.test(brief.acceptance) && /screenshot/.test(brief.acceptance));
check("two-way slice: decide yourself, note it", /make reasonable decisions yourself/.test(brief.constraints));
check("the brief asks for testing the real running app", /run the real app/.test(brief.constraints));
check("assumptions and not-doing travel with the brief", /no install/.test(brief.constraints) && /No accounts/.test(brief.constraints));
check("tags carry slice, door, stakes and order", ["slice:s4", "door:two-way", "stakes:play", "after:s2", "after:s3"].every((t) => brief.tags.includes(t)));
check("no capital-letter rules except the one ONE", !/\b(MUST|NEVER|ALWAYS|IMPORTANT)\b/.test(brief.constraints));
const oneWay = settleSlices(normalizeSlices([{ key: "s1", title: "Email every subscriber the launch news", shows: "check your inbox", doneWhen: ["The email arrives with the link"], after: [] }]));
const oneWayBrief = missionBrief({ ...card, stakes: "product" }, oneWay[0], oneWay);
check("one-way slice: build it but don't run the irreversible step", /do not run the irreversible step/.test(oneWayBrief.constraints));
check("…and it waits for the review and the owner's go", /owner says go ahead/.test(oneWayBrief.constraints));
const authorizedBrief = missionBrief({ ...card, stakes: "product" }, oneWay[0], oneWay, "Email my subscribers the news.");
check("an authorized one-way slice still holds the step until the review passes", /do not run the irreversible step/.test(authorizedBrief.constraints) && /once the independent review passes/.test(authorizedBrief.constraints) && /Email my subscribers/.test(authorizedBrief.constraints));
check("one-way slice asks for an undo note", /how to undo/.test(oneWayBrief.acceptance));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall code-monkey policy checks passed");
