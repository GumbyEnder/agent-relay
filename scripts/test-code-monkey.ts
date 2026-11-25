/**
 * Code Monkey's workshop — the policy contract (src/lib/buzzy/codeMonkey.ts).
 *
 * Pins the rules that must never drift: the model can raise caution but never
 * lower it, vague checks are refused, slices are end-to-end and acyclic, and the
 * brief a worker gets carries the guardrails and the proof to bring back.
 * And the owner's "new way forward" (2026-11-23): the budget only ever comes from the
 * owner's own words, it sets how hard agents look and how many versions they try, it
 * is counted once per delivery, and briefs start from the why and look first.
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
  codeRequestThread,
  isCodeTurn,
  isCodeRequest,
  lookFirstNote,
  codeMonkeyGuide,
  codeProjectNeedsBudgetMessage,
  argsToProject,
  START_CODE_PROJECT_TOOL,
} from "../src/lib/buzzy/codeMonkey";
import { readFileSync } from "node:fs";
import { planAppActions } from "../src/lib/buzzy/pilot";
import { isCodeWork } from "../src/lib/buzzy/askOrGo";
import { BUDGET_ANSWERS, BUDGET_QUESTION as ONE_MODE_BUDGET_QUESTION } from "../src/lib/buzzy/oneMode";
import {
  BUDGET_QUESTION,
  amountsIn,
  askedForBudget,
  budgetChoices,
  budgetView,
  countDelivery,
  deliveryCents,
  effortFor,
  emptySpend,
  money,
  settleBudget,
  addToBudget,
} from "../src/lib/buzzy/budget";

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
  why: "a calm, fun ten minutes with my kids before lights out",
  walls: ["Plays on the iPad without installing anything"],
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
check("the delivery must read well to someone who never watched", /never watched you work/.test(brief.acceptance) && /did NOT verify/.test(brief.acceptance));
check("and the worker keeps going instead of stopping with a to-do list", /don't stop to list what's left/.test(brief.acceptance));
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

console.log("the why and the walls:");
check("the card keeps the why apart from their idea", card.why.startsWith("a calm, fun") && card.making === "a bedtime adventure game");
check("walls are kept", card.walls.length === 1 && /installing/.test(card.walls[0]));
check("a card with no why is refused (the model infers one instead of asking)", validateCard({ ...card, why: "" }).some((p) => /why they want it/i.test(p) && /infer it/.test(p)));
const whyBrief = missionBrief(card, settled[0], settled, null, { budget: { cents: 500, source: "your words", words: "under $5", setAt: "" }, effort: effortFor(500), found: [] });
check("the brief starts from the why, and their idea is not a spec", /Why they want it: a calm, fun/.test(whyBrief.context) && /starting point, not a specification/.test(whyBrief.context));
check("walls lead the guardrails, the budget first", /Walls \(hard limits — never cross them\):\n- The whole project may cost at most \$5/.test(whyBrief.constraints) && /installing anything/.test(whyBrief.constraints), whyBrief.constraints);
check("agents report what a delivery cost", /Report what your delivery cost/.test(whyBrief.constraints));
check("questions to the owner are never about technology", /never about technology/.test(brief.constraints));

console.log("look first:");
check("a first step looks on BeeZilla, then the world within the budget, then borrows", /Look first/.test(whyBrief.constraints) && /up to 100 searches across 2/.test(whyBrief.constraints) && /checking each license/.test(whyBrief.constraints));
check("nothing found says so", /Nothing on BeeZilla fits yet/.test(whyBrief.constraints));
const note = lookFirstNote([{ source: "Your earlier project", title: "Fox game", about: "made for bedtime", links: ["https://x.example/fox"] }], effortFor(200));
check("found work is listed with its links", /Your earlier project: "Fox game" — made for bedtime \(https:\/\/x\.example\/fox\)/.test(note), note);
check("searches stay in the last three months for AI", /last three months/.test(note));
check("a later step borrows rather than searching again", /Borrow before you build: reuse what earlier steps found/.test(brief.constraints) && !/Look first/.test(brief.constraints));
const many = missionBrief(card, settled[0], settled, null, { effort: effortFor(5000), found: [] });
check("a $50 budget tries 3 versions before settling", /make 3 quick, genuinely different versions/.test(many.constraints) && /their own idea/.test(many.constraints));
check("a $5 budget doesn't", !/genuinely different versions/.test(whyBrief.constraints));

console.log("the budget question:");
check("the wording matches one mode's, word for word", BUDGET_QUESTION === "How much should I spend on this, at most? I'll keep my work under that amount.");
check("play answers: $2 / $5 / $20, the middle suggested", budgetChoices("play").map((c) => c.label).join(" | ") === "$2 — a quick try | $5 — a solid start | $20 — lots of care" && budgetChoices("play")[1].suggested);
check("product and critical answers scale up", budgetChoices("product").map((c) => c.dollars).join() === "20,50,200" && budgetChoices("critical").map((c) => c.dollars).join() === "100,200,1000");
check("a reply that asked it is recognised", askedForBudget("Happy to! " + BUDGET_QUESTION) && !askedForBudget("How much time do you have?"));
check("the guide tells the model to ask it with the answers", /How much should I spend on this/.test(codeMonkeyGuide("product")) && /\$50 — a solid start \(suggested\)/.test(codeMonkeyGuide("product")));
check("the guide keeps questions to the why and hard limits", /never about features or technology/.test(codeMonkeyGuide("play")));
check("a refusal for want of a budget says what to ask", /How much should I spend/.test(codeProjectNeedsBudgetMessage("play", "missing")) && /budgetDollars/.test(codeProjectNeedsBudgetMessage("play", "missing")));
const schema = START_CODE_PROJECT_TOOL.function.parameters;
check("the tool requires the why and the budget", (schema.required as readonly string[]).includes("why") && (schema.required as readonly string[]).includes("budgetDollars"));
check("the budget is split from the card", argsToProject({ making: "x", budgetDollars: 5, slices: [] }).budgetDollars === 5 && !("budgetDollars" in argsToProject({ making: "x", budgetDollars: 5 }).card));

console.log("reading amounts — only the owner's own words count:");
const cents = (t: string, o?: Parameters<typeof amountsIn>[1]) => amountsIn(t, o).map((a) => a.cents).join(",");
check("$5, $1,000, $2.50, $2k", cents("$5") === "500" && cents("$1,000") === "100000" && cents("$2.50") === "250" && cents("$2k") === "200000");
check("20 dollars, 50 bucks, USD 30", cents("20 dollars") === "2000" && cents("50 bucks") === "5000" && cents("USD 30") === "3000");
check("words: twenty-five bucks, a hundred dollars", cents("twenty-five bucks") === "2500" && cents("a hundred dollars") === "10000");
check("'my budget is 15' counts; '3 kids and 20 minutes' doesn't", cents("my budget is 15") === "1500" && cents("I have 3 kids and 20 minutes") === "");
check("$20 USD is one amount", cents("$20 USD") === "2000");
check("answers: '5', 'let's do 20', 'option 3', 'the middle one', 'five'",
  cents("5", { answer: true, stakes: "play" }) === "500" && cents("let's do 20", { answer: true }) === "2000" &&
  cents("option 3", { answer: true, stakes: "play" }) === "2000" && cents("the middle one", { answer: true, stakes: "product" }) === "5000" &&
  cents("five", { answer: true, stakes: "play" }) === "500");
check("'20 minutes' is not an answer", cents("20 minutes", { answer: true, stakes: "play" }) === "");
check("a budget word marks the amount: 'keep it under $5', '$20 max', 'spend up to $40'", amountsIn("keep it under $5")[0]?.cued && amountsIn("$20 max")[0]?.cued && amountsIn("spend up to $40")[0]?.cued);
check("a price of the thing being made is not marked: 'lemonade costs $2.50'", !amountsIn("lemonade costs $2.50")[0]?.cued);
const ok5 = settleBudget({ words: "Build a game, keep it under $5.", stakes: "play" });
check("their marked amount settles it, in their words", ok5.ok && ok5.budget.cents === 500 && ok5.budget.source === "your words" && ok5.budget.words === "Build a game, keep it under $5.");
check("the model's reading must be an amount they said", (() => { const r = settleBudget({ words: "under $5", stakes: "play", modelDollars: 50 }); return !r.ok && r.reason === "not-their-words"; })());
check("no amount at all: ask", (() => { const r = settleBudget({ words: "Build a game", stakes: "play" }); return !r.ok && r.reason === "missing"; })());
check("an unmarked price alone is never taken as the budget", (() => { const r = settleBudget({ words: "a lemonade game where lemonade costs $2.50", stakes: "play" }); return !r.ok && r.reason === "ambiguous"; })());
check("…but the model can say it is (when they did mean it)", settleBudget({ words: "Do it for $2.50", stakes: "play", modelDollars: 2.5 }).ok);
check("their answer settles it as 'your answer'", (() => { const r = settleBudget({ words: "Build a game", answer: "the middle one", stakes: "play", modelDollars: 5 }); return r.ok && r.budget.source === "your answer" && r.budget.cents === 500; })());
check("under $1 is too small", (() => { const r = settleBudget({ words: "keep it under $0.50", stakes: "play" }); return !r.ok && r.reason === "too-small"; })());
check("over $100,000 is checked with them", (() => { const r = settleBudget({ words: "spend up to $500,000", stakes: "critical" }); return !r.ok && r.reason === "too-large"; })());
check("money reads naturally", money(500) === "$5" && money(120) === "$1.20" && money(100000) === "$1,000");

console.log("what the budget buys:");
const e = (d: number) => { const x = effortFor(d * 100); return `${x.searches}/${x.areas}/${x.versions}`; };
check("$2 → 40 searches, 1 area, 1 version", e(2) === "40/1/1", e(2));
check("$5 → 100 searches, 2 areas, 1 version", e(5) === "100/2/1", e(5));
check("$50 → 1,000 searches, 10 areas, 3 versions", e(50) === "1000/10/3", e(50));
check("$500 → the write-up's full 1,000 searches in each of 10 areas", e(500) === "10000/10/33", e(500));
check("never more than 10,000 searches or 50 versions", e(5000) === "10000/10/50", e(5000));

console.log("counting what was spent:");
check("a delivery's own estimate counts", deliveryCents({ estimatedUsd: 0.42 }).cents === 42);
check("tokens count at the default price", deliveryCents({ tokensIn: 1_000_000, tokensOut: 100_000 }).cents === 450);
check("no cost reported → the floor (an agent can't run free past the limit)", deliveryCents(null).cents === 50 && !deliveryCents(null).reported);
const sp = emptySpend();
check("a delivery is counted once", countDelivery(sp, "m1", "done", { estimatedUsd: 1 }) && !countDelivery(sp, "m1", "done", { estimatedUsd: 1, model: "x" } as never) && sp.usedCents === 100);
check("…however the board shapes the usage when it reads it back", !countDelivery(sp, "m1", "done", { tokensIn: undefined, estimatedUsd: 1 }) && sp.usedCents === 100);
check("a redo is a new delivery", countDelivery(sp, "m1", "done again", { estimatedUsd: 1 }) && sp.usedCents === 200);
const b = { cents: 500, source: "your words" as const, words: "$5", setAt: "" };
check("under the limit: work goes on", budgetView(b, { usedCents: 100, counted: {}, unreported: 0 })?.verdict === "allow");
check("close to it: new work waits for a tap", budgetView(b, { usedCents: 460, counted: {}, unreported: 0 })?.verdict === "ask");
check("at it: nothing new starts", budgetView(b, { usedCents: 500, counted: {}, unreported: 0 })?.verdict === "refuse");
check("the line reads '$1.20 of $5 used'", budgetView(b, { usedCents: 120, counted: {}, unreported: 0 })?.line === "$1.20 of $5 used");
const bb = { ...b };
check("only the owner's top-up raises it, within range", addToBudget(bb, 500) && bb.cents === 1000 && !addToBudget(bb, 10) && bb.cents === 1000);
check("projects from before budgets have none", budgetView(undefined, undefined) === null);

console.log("Talk: the request thread:");
check("the thread starts at the message that asked for software", codeRequestThread(["write a poem", "build me a tip calculator app", "$5"])?.join("|") === "build me a tip calculator app|$5");
check("an unrelated earlier request is left out (its words authorize nothing here)", !codeRequestThread(["publish my poem", "build me a game", "$5"])!.includes("publish my poem"));
check("no software asked for: no thread", codeRequestThread(["write a poem", "$5"]) === null);

console.log("Talk: a flow built on the Idea Board is the board's, not Code Monkey's:");
// Owner, 2026-11-24: "you should just be able to talk to Beezilla … to make an
// orchestration." These name a website, a tracker or a dashboard, so isCodeRequest
// matches them, but the board builds them. As in server.ts, "the board builds this turn"
// is the final plan's own build step (pilot.ts planAppActions, the board's rules,
// unchanged), with or without a flow already on the board.
const boardBuilds = (message: string, boardHasFlow = false) =>
  !!planAppActions(message, null, { boardHasFlow })?.some((s) => s.do === "board" && s.value === "orchestrate");
const turnOf = (message: string, o: { budgetAsked?: boolean; earlier?: string[]; boardHasFlow?: boolean } = {}) =>
  isCodeTurn(message, {
    budgetAsked: !!o.budgetAsked,
    codeThread: codeRequestThread([...(o.earlier ?? []), message]),
    buildsOnBoard: boardBuilds(message, !!o.boardHasFlow),
  });
const flows = [
  "build me a workflow that checks my website every morning and tells me if it's down",
  "set up an automation that updates my tracker from new emails",
  "build me a pipeline that scrapes prices and puts them on a dashboard",
  "build me an agent team that writes the landing page copy",
  "build me an automation for my website",
];
for (const flow of flows) {
  check(`a flow stays on the board: "${flow.slice(0, 48)}…"`, isCodeRequest(flow) && boardBuilds(flow) && !turnOf(flow));
}
const change = "add a check before the website update";
check("a change to the flow on the board is the board's; with no flow there it is software", !turnOf(change, { boardHasFlow: true }) && turnOf(change));
check("software still goes to Code Monkey", turnOf("build me an app that tracks my kids' chores") && turnOf("fix the bug in my website's contact form"));
check("asking for the software itself reaches Code Monkey ('a web app for managing workflows')", turnOf("build me a web app for managing workflows"));
check("the budget answer still finishes a coding request", turnOf("$5", { budgetAsked: true, earlier: ["build me a tip calculator app"] }));
// Found in review (OpenAI Codex, 2026-11-25): opening the Orchestrate editor builds
// nothing, so it never hides a budget answer.
const editorAnswer = "Open it in Orchestrate and add a note saying $50 is my budget";
check(
  "a budget answer that also opens the Orchestrate editor still reaches Code Monkey",
  !!planAppActions(editorAnswer)?.some((s) => s.value === "openOrchestrate") &&
    !boardBuilds(editorAnswer) &&
    turnOf(editorAnswer, { budgetAsked: true, earlier: ["build me a tip calculator app"] }),
);
// The server uses this same signal (a source guard: the tests above use a helper, so
// they would stay green if chatLoop went back to asksToOrchestrate; found in review).
{
  const server = readFileSync(new URL("../src/lib/buzzy/server.ts", import.meta.url), "utf8");
  const builds = /const buildsOnBoard = !!appPlan && appPlan\.some\(\(s\) => s\.do === "board" && s\.value === "orchestrate"\);/.test(server);
  const gate = /const codeRequest = isCodeTurn\(message, \{ budgetAsked, codeThread, buildsOnBoard \}\);/.test(server);
  const once = (server.match(/const codeRequest\b/g) ?? []).length === 1;
  const sameTest = /if \(buildsOnBoard\) \{\s*const own = messages\[messages\.length - 1\];/.test(server);
  check("server.ts: Code Monkey steps aside on the plan's own build step, the one that asks for one sentence", builds && gate && once && sameTest);
}
// A flow turn never asks the budget question, so a later "$5" finishes nothing, even
// though the flow's words left a coding thread behind.
check(
  "after a flow, a bare amount is not a coding turn",
  codeRequestThread([flows[0]!, "$5"]) !== null && !turnOf("$5", { earlier: [flows[0]!] }),
);
// The two never both act on one turn, whatever the words (the reviewers' examples).
for (const ask of [
  ...flows,
  "build me a workflow management web app",
  "make me an automation dashboard",
  "build an automation dashboard I can share with my team",
  "build automation scripts for my invoices",
  "make the automation dashboard step run in parallel",
  "build an in-house workflow dashboard",
  "write two scripts for my podcast",
  "build me an app that tracks my kids' chores",
]) {
  for (const boardHasFlow of [false, true]) {
    check(`never both${boardHasFlow ? " (flow on the board)" : ""}: "${ask.slice(0, 44)}"`, !(boardBuilds(ask, boardHasFlow) && turnOf(ask, { boardHasFlow })));
  }
}

console.log("One mode (PR #371) asks the budget first; Code Monkey takes it from there:");
// One mode asks "How much should I spend…" with tap answers for work it hands to agents
// (askOrGo.ts isCodeWork). Code Monkey must recognise every such ask, read the tapped
// answer as the owner's own words, and ask the very same question when it asks itself.
check("both ask the very same question", ONE_MODE_BUDGET_QUESTION === BUDGET_QUESTION && askedForBudget(ONE_MODE_BUDGET_QUESTION));
const oneModeAsks = [
  "build me a bedtime game for my kids", "make a tip calculator app", "fix the bug in my website's contact form",
  "build a landing page for my bakery", "code a script that renames my files", "create a Chrome extension that blocks ads",
  "build an API for my orders", "add a dark mode to my app", "develop a mobile app for my gym", "make a Discord bot for my server",
  "refactor my code", "build me a CRM", "program an Arduino to water my plants", "build a scraper for job listings",
];
for (const ask of oneModeAsks.filter(isCodeWork)) {
  check(`an ask one mode takes to agents is Code Monkey's: "${ask.slice(0, 40)}"`, isCodeRequest(ask));
}
check(
  "after one mode's budget question, the tapped answer finishes the coding ask",
  turnOf("$5 — a solid start", { budgetAsked: true, earlier: ["program an Arduino to water my plants"] }),
);
for (const [tier, labels] of Object.entries(BUDGET_ANSWERS) as Array<[keyof typeof BUDGET_ANSWERS, readonly string[]]>) {
  const cents = labels.map((label) => {
    const r = settleBudget({ words: "build me a tip calculator app", answer: label, stakes: tier });
    return r.ok ? r.budget.cents : -1;
  });
  const want = budgetChoices(tier).map((c) => c.dollars * 100);
  check(`each of one mode's ${tier} taps settles as that amount (${labels.join(" / ")})`, cents.join() === want.join(), cents.join());
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall code-monkey policy checks passed");
