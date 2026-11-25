/**
 * One mode: when BeeZilla asks first and when it just goes (src/lib/buzzy/oneMode.ts).
 *
 * The owner wanted the ask-or-go decision as an equation, so this pins it three ways:
 *   1. the equation itself, with hand-worked numbers;
 *   2. real requests and the decision each must get (the owner's examples first:
 *      bedtime fun with the kids just goes, a game for kids everywhere asks, anything
 *      critical asks even when fairly clear, a hurry or "just do it" goes);
 *   3. the conversation around it: one quick choice, the questions with a suggested
 *      answer each, the ticket, the assumptions, and never offering twice;
 *   4. the budget before work goes to agents (owner, 2026-11-23: "No bankrupting people
 *      for small projects"), and questions that ask the why and the walls, never the
 *      product;
 *   5. a turn where the page builds a flow on the Idea Board: one mode steps aside.
 * It also checks that the old plan-first and Work-mode prompts are gone for good.
 *
 * Run: npx tsx scripts/test-one-mode.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASK_OR_GO,
  BUDGET_RULE,
  askBudget,
  budgetInWords,
  formatDollars,
  handsToAgents,
  askFirst,
  askOrGo,
  askPreferenceKey,
  askPreferenceText,
  assessRequest,
  readAskPreference,
  startsNewRequest,
  type AssessContext,
  type Assessment,
} from "../src/lib/buzzy/askOrGo";
import {
  ASSUMPTIONS_HEADING,
  BUDGET_ANSWERS,
  BUDGET_KEY,
  BUDGET_QUESTION,
  budgetNote,
  budgetOptions,
  budgetSuggestion,
  goOnRequest,
  isSpecQuestion,
  readBudget,
  MAX_QUESTIONS,
  OFFER_OPTIONS,
  OFFER_TEXT,
  ONE_PERSONA,
  OPENING_QUESTIONS,
  decodeState,
  encodeState,
  interviewQuestion,
  asksInsteadOfDoing,
  DO_IT_NOW,
  goReminder,
  isAcceptReply,
  isAskReply,
  isDelegateReply,
  isExplicitAskReply,
  isGoReply,
  isTechnicalQuestion,
  pendingPrompt,
  quoteTheirWords,
  withTheirWords,
  WAITING_NOTE,
  nextStep,
  parseAssumptions,
  parseQuestion,
  parseTicket,
  questionOptions,
  questionText,
  turnNote,
  wantsQuestionsFirst,
  type OneModeState,
} from "../src/lib/buzzy/oneMode";
import { asksToOrchestrate, planAppActions } from "../src/lib/buzzy/pilot";

let failures = 0;
let passes = 0;
function check(ok: unknown, label: string): void {
  if (ok) {
    passes++;
    return;
  }
  failures++;
  console.error("FAIL", label);
}

// ── 1. The equation ─────────────────────────────────────────────────────
const base: Assessment = { size: "large", stakes: "product", irreversible: false, hurried: false, pMisread: 0.5, why: [] };
{
  // 0.5 × 8 × 3 = 12 > 1.5 × 2 = 3
  const r = askOrGo(base);
  check(r.ask === true && r.costOfMisreading === 12 && r.costOfAsking === 3, `large/product/0.5 asks: ${r.why}`);
  // A one-way door is ten times worse: 0.1 × 8 × 3 × 10 = 24 > 3
  const irr = askOrGo({ ...base, pMisread: 0.1, irreversible: true });
  check(irr.ask === true && irr.costOfMisreading === 24, `can't undo tips a clear request over: ${irr.why}`);
  check(askOrGo({ ...base, pMisread: 0.1 }).ask === false, "the same request, reversible, goes (2.4 ≤ 3)");
  // A hurry quadruples the right side: 12 ≤ 12 goes.
  const hurry = askOrGo({ ...base, hurried: true });
  check(hurry.ask === false && hurry.costOfAsking === 12, `in a hurry it goes: ${hurry.why}`);
  // Small never asks unless critical, irreversible and vague all at once.
  check(askOrGo({ ...base, size: "small", stakes: "critical", pMisread: 0.45 }).ask === false, "small + critical + reversible goes");
  check(askOrGo({ ...base, size: "small", stakes: "critical", pMisread: 0.45, irreversible: true }).ask === true, "small + critical + irreversible + vague asks");
  // Play is the cheapest to get wrong.
  check(askOrGo({ ...base, stakes: "play", pMisread: 0.3 }).ask === false, "large play project with some detail goes (2.4)");
  check(askOrGo({ ...base, stakes: "play", pMisread: 0.45 }).ask === true, "large play project left wide open asks (3.6)");
  // The equation is the one in the module comment, constant for constant.
  const k = ASK_OR_GO;
  check(k.REDO_MINUTES.small < k.REDO_MINUTES.medium && k.REDO_MINUTES.medium < k.REDO_MINUTES.large, "redo minutes grow with size");
  check(k.STAKES_WEIGHT.play < k.STAKES_WEIGHT.product && k.STAKES_WEIGHT.product < k.STAKES_WEIGHT.critical, "stakes weights grow");
  // The owner-facing page's numbers (research session, 2026-11-23): can't-undo 1 or 10,
  // stakes 1 / 3 / 10, hurry 1 or 4.
  check(k.CANT_UNDO_WEIGHT === 10 && k.HURRY_WEIGHT === 4, "can't-undo ×10, hurry ×4, as published");
  check(k.STAKES_WEIGHT.play === 1 && k.STAKES_WEIGHT.product === 3 && k.STAKES_WEIGHT.critical === 10, "stakes 1 / 3 / 10, as published");
  check(k.ANSWER_MINUTES === 3, "threshold is 3 minutes (12 in a hurry)");
}

// ── 2. Real requests ───────────────────────────────────────────────────
type Case = [message: string, expect: "go" | "ask", ctx?: AssessContext, note?: string];
const cases: Case[] = [
  // The owner's three stakes tiers.
  ["I want to have fun with my kids, 8–10, at bedtime", "go", undefined, "hobby/play: just do it"],
  ["Publish a game kids everywhere will enjoy", "ask", undefined, "product: big, open, public"],
  ["Migrate our customer database to the new server", "ask", undefined, "critical: people's data, production"],
  ["quick, migrate our customer database to the new server", "ask", undefined, "critical outweighs a hurry"],
  ["Update the medication schedule for my patients", "ask", undefined, "critical: health"],
  ["Write a demand letter to my landlord", "ask", undefined, "critical: legal, facts missing"],
  // Clear or small: just do it.
  ["What's the capital of France?", "go"],
  ["What's the maximum daily dose of ibuprofen for adults?", "go", undefined, "a critical question is still a question"],
  ["How do I build a website for my bakery?", "go", undefined, "asking how, not asking for it"],
  ["Write an email to my landlord asking him to fix the heater", "go"],
  ["Write me a poem about rain", "go"],
  ["Make me a picture of a cat in a hat", "go", { makerLane: true }],
  ["make me a 3D model of a red sports car for my game", "go", { makerLane: true }],
  ["Make the second paragraph shorter", "go", { hasDraft: true }],
  ["Research the best CRM for a 5-person team and save it in a file", "go"],
  ["quick, write a launch tweet for our new app", "go"],
  ["Email all our customers that prices go up 20% on Monday", "go", undefined, "a short draft; sending waits for their OK"],
  ["Organize a birthday party for my 8 year old", "go"],
  ["Write a children's book about a brave duck named Pip", "go"],
  ["Plan a trip to Japan for two weeks in April", "go"],
  ["Write a cover letter for a barista job at Blue Bottle", "go"],
  ["Write a business plan for my coffee shop", "go", undefined, "a document with its subject named: go, assumptions listed"],
  [
    "Build a website for my bakery, Rosa's, in Austin: a menu page with prices from our sheet, an about page with our story (family bakery since 1952), " +
      "online ordering through Square, warm colours, and our opening hours 7am to 3pm on every page.",
    "go",
    undefined,
    "a big job, fully specified",
  ],
  ["quick, make me a game", "go", undefined, "a hurry beats a play project"],
  // Significant and easy to misread: one quick choice.
  ["Make me a game", "ask"],
  ["Build me a website for my bakery", "ask"],
  ["Help me plan my wedding", "ask"],
  ["Create a marketing strategy for my business", "ask"],
  ["Launch our new product on Product Hunt next week", "ask"],
  // Context lowers the chance of misreading.
  ["Build me a website for my bakery", "go", { hasBoardBrief: true, knownFacts: 3, priorTurns: 3 }, "the board and earlier turns already say what it is for"],
];
for (const [message, expected, ctx, note] of cases) {
  const a = assessRequest(message, ctx);
  const r = askOrGo(a);
  const got = r.ask ? "ask" : "go";
  check(got === expected, `"${message.slice(0, 70)}" → ${got}, expected ${expected}${note ? ` (${note})` : ""}\n     ${a.size}/${a.stakes}${a.irreversible ? "/irreversible" : ""}${a.hurried ? "/hurried" : ""} p=${a.pMisread} — ${r.why}\n     ${a.why.join("; ")}`);
}

// Stakes tiers, size and the other inputs, on their own.
const tier = (m: string) => assessRequest(m).stakes;
check(tier("I want to have fun with my kids at bedtime") === "play", "bedtime with the kids is play");
check(tier("make a game for my nephew") === "play", "a game for the family is play");
check(tier("Publish a game kids everywhere will enjoy") === "product", "publishing for everyone is product");
check(tier("write a proposal for my client") === "product", "a client proposal is product");
check(tier("Migrate our customer database") === "critical", "customer data is critical");
check(tier("What dose of insulin should I take?") === "critical", "dosage is critical");
check(tier("draft an NDA for my contractor") === "critical", "an NDA is critical");
check(tier("rotate the API keys on our live server") === "critical", "keys on a live server are critical");
check(tier("a healthy breakfast idea for my kids") === "play", "'healthy' is not health care");
check(assessRequest("write a poem", { minStakes: "product" }).stakes === "product", "a caller's tier is the floor");
check(assessRequest("rotate the passwords on our live server", { minStakes: "product" }).stakes === "critical", "the words can raise the caller's tier");
check(assessRequest("draft an NDA", { minStakes: "play" }).stakes === "critical", "and never lower it");
check(assessRequest("Send it to all our customers").irreversible === true, "sending is irreversible");
check(assessRequest("What happens if I send it?").irreversible === false, "a question about sending is not a send");

// A performed one-way door is never silent, whatever the equation says. The weight
// alone cannot lift a small, clear, product-stakes send (1.5 ≤ 3), so askFirst holds
// the floor: at least the one choice, at every tier but play with a remembered "go".
const door = (m: string, ctx = {}) => {
  const a = assessRequest(m, ctx);
  return { a, verdict: askOrGo(a), asked: askFirst(askOrGo(a), "go", a) };
};
for (const message of [
  "Send it to all our customers",
  "email all our customers the new price list",
  "announce the price increase to everyone",
  "publish the new pricing page",
]) {
  const { a, verdict, asked } = door(message);
  check(
    verdict.ask === false && a.performsDoor === true && asked !== "go",
    `"${message}" performs a door, so it is offered even when the equation says go (got ${asked}, ${a.size}/${a.stakes})`,
  );
}
// Money with an amount is critical now, so the equation stops it on its own; what
// matters is that the door is recognised and never goes silently.
for (const message of ["pay our contractor $2,000", "wire $5,000 to the new supplier"]) {
  const { a, asked } = door(message);
  check(a.performsDoor === true && asked !== "go", `"${message}" is a performed money door (got ${asked}, ${a.size}/${a.stakes})`);
}
// The same door inside work that makes something, or in play with a remembered "go",
// is not performed here: "write a tweet announcing our sale" leaves nothing.
for (const message of ["write a tweet announcing our sale", "draft the email to our customers", "write a post announcing the price rise"]) {
  const { a, verdict } = door(message);
  check(verdict.ask === false && a.performsDoor === false, `"${message}" mentions a door, it does not perform one`);
}
check(assessRequest("Send it later, maybe", { makerLane: true }).performsDoor === false, "a maker lane mentions doors, it does not perform them");
{
  const a = assessRequest("delete my old screenshots");
  check(a.performsDoor === true, "deleting your own screenshots is still a door");
  check(askFirst(askOrGo(a), "go", a) === "go", "play + a remembered 'just go': their own call, no tap");
  check(askFirst(askOrGo(a), null, a) === "offer", "play and no answer yet: offered once");
}

// Money is critical when an amount rides with the verb, whatever noun follows it:
// "pay our contractor $2,000" read as play before this test existed (0.32 → go).
for (const message of [
  "pay our contractor $2,000",
  "wire $5,000 to the new supplier",
  "transfer $500 to the landlord",
  "send 2000 dollars to the vendor",
]) {
  check(tier(message) === "critical", `money with an amount is critical: "${message}" (got ${tier(message)})`);
}
for (const message of ["pay attention to the layout", "order a $5 coffee", "the pay page needs a tidier header"]) {
  check(tier(message) !== "critical", `no money signal here: "${message}" (got ${tier(message)})`);
}
// The recipient is a door on its own, not only the amount. "owe the landlord" read
// critical through MONEY_RECIPIENT but was neither irreversible nor a door, so a
// remembered "just go" walked it through as a payment.
for (const message of ["owe the landlord", "owe the landlord $500", "we owe the landlord $500"]) {
  check(tier(message) === "critical", `owing a bill is critical: "${message}" (got ${tier(message)})`);
}
{
  const a = assessRequest("owe the landlord");
  check(a.irreversible === true && a.performsDoor === true, "owe with a payment recipient is irreversible and performs the door");
  check(
    askFirst(askOrGo(a), "go", a) === "offer",
    `critical + irreversible is offered even after a remembered "just go" (got ${askFirst(askOrGo(a), "go", a)})`,
  );
}
// ... and only then: owing a favour is not owing money.
for (const message of ["owe you one", "owe my team an apology", "owe it to myself to rest"]) {
  const a = assessRequest(message);
  check(
    a.irreversible !== true && a.performsDoor !== true,
    `not a payment: "${message}" (irreversible=${a.irreversible}, door=${a.performsDoor})`,
  );
}
// An adverb of degree rides between the verb and the recipient. The bare `more|less`
// guard that kept "pay more attention" out also swallowed "pay more to our suppliers",
// a real payment that then read as play and went on a remembered "just go".
for (const message of ["pay more to our suppliers", "pay less to our suppliers", "pay more to our landlord"]) {
  const a = assessRequest(message);
  const asked = askFirst(askOrGo(a), "go", a);
  check(
    a.stakes === "critical" && a.performsDoor === true && asked === "offer",
    `a degree adverb still pays: "${message}" (${a.stakes}, door=${a.performsDoor}, ${asked})`,
  );
}
for (const message of [
  "pay more attention to our vendors",
  "pay less attention to the bills",
  "pay more heed to the warnings",
  "pay closer attention to the invoice",
  "pay more attention to the team's feedback",
]) {
  const a = assessRequest(message);
  check(
    a.irreversible === false && a.performsDoor === false && a.stakes !== "critical",
    `paying attention is not paying: "${message}" (${a.stakes}, irreversible=${a.irreversible}, door=${a.performsDoor})`,
  );
}
// The legal arm knew "terms of service" but not the acronym, so "publish ToS" read as
// product stakes and went ahead (1.2 ≤ 3). An acronym the owner types is still a door.
for (const message of ["publish ToS", "update our T&Cs", "publish the terms of service", "publish the terms and conditions"]) {
  check(tier(message) === "critical", `a legal text is critical however it is spelled: "${message}" (got ${tier(message)})`);
}

// ── The discriminator: the channel verb decides, not the content verb ────────
// The same sentence can make a thing or send it. Only the verb that leads counts,
// so this table is pinned as pairs: maker verb → go, channel verb → offer. Raising
// the stakes to product is how the test says "other people see it", because at play
// a remembered "just go" is the person's own call (checked above).
const channel = (message: string) => assessRequest(message, { minStakes: "product" });
for (const message of [
  "write a tweet announcing our sale",
  "draft the email to our customers",
  "compose the newsletter for our customers",
  "write a post announcing the price rise",
]) {
  const a = channel(message);
  check(
    a.performsDoor !== true && askFirst(askOrGo(a), "go", a) === "go",
    `a maker verb makes the artifact, nothing leaves: "${message}" (door=${a.performsDoor}, ${askFirst(askOrGo(a), "go", a)})`,
  );
}
for (const message of [
  "post the tweet",
  "publish the new pricing page",
  "send it to the vendor",
  "upload the video to youtube",
  "share the video with my class",
  "announce the price increase to everyone",
]) {
  const a = channel(message);
  check(
    a.performsDoor === true && askFirst(askOrGo(a), "go", a) !== "go",
    `a channel verb leaves the account, so it is offered: "${message}" (door=${a.performsDoor}, ${askFirst(askOrGo(a), "go", a)})`,
  );
}
// The object is not the signal; the verb is. The first version of this table gated
// the door on IRREVERSIBLE's object arms, and only `send` accepted "our …", so
// "email our customers the new price list" went at 0.15 while the same request with
// `send` offered. These rows are the ones that went silently (#403's residual).
for (const message of [
  "email our customers the new price list",
  "mail our customers the new price list",
  "tweet our sale to our followers",
  "post our price increase on facebook",
]) {
  const a = assessRequest(message);
  check(
    a.performsDoor === true && a.stakes === "product" && askFirst(askOrGo(a), "go", a) === "offer",
    `the leading channel verb is the door, whatever its object: "${message}" (door=${a.performsDoor}, ${a.stakes}, ${askFirst(askOrGo(a), "go", a)})`,
  );
}
// Two guards that must survive the widening.
for (const message of ["share my screen", "share my screen with the team"]) {
  const a = assessRequest(message);
  check(
    a.performsDoor !== true && a.irreversible === false && askFirst(askOrGo(a), null, a) === "go",
    `sharing your screen leaves nothing: "${message}" (irr=${a.irreversible}, door=${a.performsDoor}, ${askFirst(askOrGo(a), null, a)})`,
  );
}
// "send me …" leaves nothing either: the recipient is the person asking.
for (const message of ["send me the notes", "email me the summary"]) {
  const a = assessRequest(message);
  check(
    a.performsDoor !== true && askFirst(askOrGo(a), null, a) === "go",
    `sending to yourself is not a channel door: "${message}" (irr=${a.irreversible}, door=${a.performsDoor}, ${askFirst(askOrGo(a), null, a)})`,
  );
}
// Paying attention is not paying. The recipient arm reads a direct object now, so
// "pay" + attention/closer/more never reaches the critical tier and never becomes a
// door — otherwise the widened #404 arm charged a tap for ordinary instructions that
// a remembered "just go" could not suppress.
for (const message of [
  "pay attention to the team's feedback",
  "pay closer attention to our vendors' emails",
  "pay attention to our staff survey",
  "pay more attention to our suppliers",
  "pay heed to the team's advice",
]) {
  const a = assessRequest(message);
  check(
    a.stakes !== "critical" && a.performsDoor !== true &&
      askFirst(askOrGo(a), "go", a) === "go" && askFirst(askOrGo(a), null, a) === "go",
    `paying attention is not paying: "${message}" (${a.stakes}, irr=${a.irreversible}, door=${a.performsDoor}, go=${askFirst(askOrGo(a), "go", a)}, fresh=${askFirst(askOrGo(a), null, a)})`,
  );
}
// The same arm must still catch a real payment whose recipient is the direct object.
for (const message of [
  "pay our contractor $2,000",
  "pay the invoice",
  "pay suppliers",
  "pay for the invoice",
  "owe the landlord last month's rent",
]) {
  check(tier(message) === "critical", `a payment's direct object is critical: "${message}" (got ${tier(message)})`);
}

// ── The money arms cannot drift apart ────────────────────────────────────────
// One table carries both numbers the two arms read: the amount the sentence names
// (2,000 / 5,000) and the score the equation gives the same words at play
// (0.32 = 0.064 × 0.5 × 1 × 10). Move CANT_UNDO_WEIGHT or REDO_MINUTES.small and
// 0.32 breaks; stop matching the amount and the tier falls back to play, which
// scores 0.32 on the same row. Either drift lands here, as one failure.
const MONEY_DOOR = [
  { message: "pay our contractor $2,000", amount: "2,000" },
  { message: "wire $5,000 to the new supplier", amount: "5,000" },
];
for (const { message, amount } of MONEY_DOOR) {
  const a = assessRequest(message);
  const playScore = askOrGo({ ...a, stakes: "play" }).costOfMisreading;
  const why = a.why.find((w) => w.startsWith("critical (money):")) || "";
  check(
    a.stakes === "critical" && why.includes(amount),
    `the money arm reads the amount: "${message}" (got ${a.stakes}, "${why}")`,
  );
  check(
    a.performsDoor === true && askFirst(askOrGo(a), "go", a) !== "go",
    `moving an amount is a door, not just a critical tier: "${message}" (door=${a.performsDoor}, ${askFirst(askOrGo(a), "go", a)})`,
  );
  check(
    Math.abs(playScore - 0.32) < 1e-9,
    `the same words at play score 0.32, which is why the tier must carry them: "${message}" (got ${playScore})`,
  );
}
// The row that was half-fixed: critical from the amount arm, but `irreversible` was
// false, so a remembered "just go" walked the payment through on 0.4.
{
  const a = assessRequest("send 2000 dollars to the vendor");
  check(a.stakes === "critical" && a.irreversible === true && a.performsDoor === true, "an amount and a recipient make a payment a door: \"send 2000 dollars to the vendor\"");
}
check(assessRequest("I need this ASAP").hurried === true, "ASAP is a hurry");
check(assessRequest("write a short story").hurried === false, "no hurry words, no hurry");
check(assessRequest("Make me a game").size === "large", "a game is a project");
check(assessRequest("write a cover letter").size === "medium", "a cover letter is a document");
check(assessRequest("write a tweet").size === "small", "a tweet is small");
// The streaming invariant (server.ts: draftGateOpen = … || (go && size !== "small")).
// A plain chat-sized ask must stay small so loopTools is [] and the reply streams;
// if the equation ever grows it, every such turn goes buffered and silent for ~12s.
const plainAsk = assessRequest("write me a short poem about rain");
check(plainAsk.size === "small" && !askOrGo(plainAsk).ask, "a plain chat-sized ask stays small and goes, so the turn still streams");
check(assessRequest("write a quote and then an invoice and then a thank-you note").size !== "small", "several parts grow the size");
check(assessRequest("Make me a game").pMisread > assessRequest("Make me a platformer game for my nephew, age 8, about a duck named Pip").pMisread, "details lower P(misread)");
check(assessRequest("make me something cool").pMisread > assessRequest("make me a poster").pMisread, "open words raise P(misread)");

// ── 3. The conversation ────────────────────────────────────────────────
const ASK = askOrGo({ ...base });
const GO = askOrGo({ ...base, pMisread: 0.05 });
check(ASK.ask && !GO.ask, "fixtures: ASK asks, GO goes");

// A fresh request.
{
  const offered = nextStep(null, { message: "Build me a website for my bakery", fresh: ASK, canFollowUp: true });
  check(offered.step.kind === "offer", "significant + open → the one quick choice");
  check(offered.state?.stage === "offered" && offered.state.request === "Build me a website for my bakery", "the offer remembers the request");
  check(nextStep(null, { message: "Write a poem", fresh: GO, canFollowUp: true }).step.kind === "go", "clear → go");
  const noId = nextStep(null, { message: "Build me a website", fresh: ASK, canFollowUp: false });
  check(noId.step.kind === "go" && noId.state === null, "no conversation id to follow up on → go, never a dangling question");
  const doIt = nextStep(null, { message: "Build me a website", execute: true, fresh: ASK, canFollowUp: true });
  check(doIt.step.kind === "go", "Do it → go, whatever the rule says");
  check(nextStep(null, { message: "Build me a website for my bakery, just do it", fresh: ASK, canFollowUp: true }).step.kind === "go", "'just do it' in the request → go");
  check(nextStep(null, { message: "build the bakery site, cut to the chase", fresh: ASK, canFollowUp: true }).step.kind === "go", "'cut to the chase' → go");
}

// Answering the one quick choice.
const offeredState: OneModeState = { stage: "offered", request: "Build me a website for my bakery", asked: [], answers: [] };
{
  const ask = nextStep(offeredState, { message: "Ask me a few questions", choice: "ask", fresh: GO, canFollowUp: true });
  check(ask.step.kind === "ask" && (ask.step as { index: number }).index === 0, "'Ask me a few questions' → question 1");
  check(ask.state?.stage === "asking" && ask.state.request === offeredState.request, "asking keeps the original request");
  for (const typed of ["ask away", "questions first", "Sure", "yes", "ok", "ask me some questions"]) {
    check(nextStep(offeredState, { message: typed, fresh: GO, canFollowUp: true }).step.kind === "ask", `typed "${typed}" → questions`);
  }
  for (const typed of ["Just go for it", "go for it", "just go", "you decide", "up to you", "skip the questions", "no questions, just build it", "Go."]) {
    const r = nextStep(offeredState, { message: typed, fresh: ASK, canFollowUp: true });
    check(r.step.kind === "go" && (r.step as { how: string }).how === "skipped" && r.state === null, `typed "${typed}" → just go`);
  }
  const pressed = nextStep(offeredState, { message: "Just go for it", choice: "go", execute: true, fresh: ASK, canFollowUp: true });
  check(pressed.step.kind === "go" && (pressed.step as { how: string }).how === "skipped", "the Just go button → go");
  // Something else entirely: never offer the choice twice in a row.
  const other = nextStep(offeredState, { message: "It's for my bakery in Austin, mostly the menu and hours", fresh: ASK, canFollowUp: true });
  check(other.step.kind === "go" && other.state === null, "more detail instead of a choice → go, never a second offer");
}

// The questions.
{
  let state: OneModeState = { stage: "asking", request: "Build me a website for my bakery", asked: [{ q: OPENING_QUESTIONS[0], suggested: "Customers can't find our menu and hours online." }], answers: [] };
  const tapped = nextStep(state, { message: "Customers can't find our menu and hours online.", choice: "accept", fresh: GO, canFollowUp: true });
  check(tapped.step.kind === "ask" && (tapped.step as { index: number }).index === 1, "answer 1 → question 2");
  check(tapped.state?.answers[0] === "Customers can't find our menu and hours online.", "a tapped suggestion is recorded as the answer");
  const yes = nextStep(state, { message: "yes", fresh: GO, canFollowUp: true });
  check(yes.state?.answers[0] === "Customers can't find our menu and hours online.", "a typed yes takes the suggestion");
  const own = nextStep(state, { message: "We want catering orders", fresh: GO, canFollowUp: true });
  check(own.state?.answers[0] === "We want catering orders", "their own words win");
  const stop = nextStep(state, { message: "that's enough, just build it", fresh: ASK, canFollowUp: true });
  check(stop.step.kind === "go" && (stop.step as { how: string }).how === "skipped" && stop.state === null, "'that's enough' mid-way → go with what they said");
  const pressedGo = nextStep(state, { message: "Just go for it", choice: "go", execute: true, fresh: ASK, canFollowUp: true });
  check(pressedGo.step.kind === "go", "the Just go button mid-way → go");
  const course = nextStep(state, { message: "What's a good domain name registrar?", fresh: GO, canFollowUp: true });
  check(course.step.kind === "go" && course.carry === true && course.state?.stage === "asking", "a question back mid-way is answered, and the waiting question stays open");
  // The cap: at most MAX_QUESTIONS, then the ticket.
  state = { ...state, asked: Array.from({ length: MAX_QUESTIONS }, (_, i) => ({ q: `q${i}?`, suggested: "" })), answers: ["a", "b", "c", "d"] };
  const last = nextStep(state, { message: "e", fresh: GO, canFollowUp: true });
  check(last.step.kind === "go" && (last.step as { how: string }).how === "ticket" && last.state === null, `after ${MAX_QUESTIONS} answers → the ticket, then the work`);
  check(MAX_QUESTIONS === 5 && OPENING_QUESTIONS.length === 2, "two openers plus at most three more");
}

// Asked once, then not again: the answer is remembered per stakes tier.
{
  const product = { stakes: "product" as const, irreversible: false };
  check(askFirst(GO, null, product) === "go", "the rule says go: go");
  check(askFirst(ASK, null, product) === "offer", "first time the rule would ask: offer the choice");
  check(askFirst(ASK, "go", product) === "go", "they said 'just go' for this kind of work before: go");
  check(askFirst(ASK, "ask", product) === "questions", "they chose questions before: straight to the questions");
  check(askFirst(ASK, "go", { stakes: "critical", irreversible: true }) === "offer", "a critical one-way door is offered every time");
  check(askFirst(ASK, "go", { stakes: "critical", irreversible: false }) === "go", "critical but undoable: their answer stands");

  const offered = nextStep(null, { message: "Build me a website for my bakery", fresh: ASK, assessment: product, canFollowUp: true });
  check(offered.state?.stakes === "product" && !offered.remember, "the offer remembers the tier, nothing kept yet");
  const went = nextStep(offered.state, { message: "Just go for it", choice: "go", execute: true, fresh: GO, canFollowUp: true });
  check(went.remember?.stakes === "product" && went.remember.pref === "go", "'Just go for it' is kept for product work");
  const asked = nextStep(offered.state, { message: "Ask me a few questions", choice: "ask", fresh: GO, canFollowUp: true });
  check(asked.remember?.stakes === "product" && asked.remember.pref === "ask", "'Ask me a few questions' is kept for product work");
  check(asked.state?.stakes === "product", "the questions keep the tier");
  const declined = nextStep(asked.state, { message: "Just go for it", choice: "go", execute: true, fresh: GO, canFollowUp: true });
  check(declined.remember?.pref === "go", "'just go' before answering anything flips the kept answer to go");
  const midway = nextStep({ ...asked.state!, answers: ["a"] }, { message: "just go", fresh: GO, canFollowUp: true });
  check(midway.step.kind === "go" && !midway.remember, "'just go' after some answers keeps the earlier choice");
  const other = nextStep(offered.state, { message: "It's mostly for the menu", fresh: GO, canFollowUp: true });
  check(!other.remember, "an answer that is neither choice keeps nothing");

  const rememberedGo = nextStep(null, { message: "Build me a website for my salon", fresh: ASK, assessment: product, remembered: "go", canFollowUp: true });
  check(rememberedGo.step.kind === "go" && rememberedGo.state === null, "next product request: no question at all");
  const rememberedAsk = nextStep(null, { message: "Build me a website for my salon", fresh: ASK, assessment: product, remembered: "ask", canFollowUp: true });
  check(rememberedAsk.step.kind === "ask" && rememberedAsk.state?.stage === "asking" && rememberedAsk.state.stakes === "product", "next product request: straight to question 1");
  const playStill = nextStep(null, { message: "Make me a game", fresh: ASK, assessment: { stakes: "play", irreversible: false }, remembered: null, canFollowUp: true });
  check(playStill.step.kind === "offer", "a different tier still gets its own one choice");
  const preempt = nextStep(null, { message: "Build me a website for my bakery, just do it", fresh: ASK, assessment: product, canFollowUp: true });
  check(preempt.step.kind === "go" && preempt.remember?.pref === "go", "'just do it' on a request the rule would stop for is kept as go");
  const smallGo = nextStep(null, { message: "write a poem, just do it", fresh: GO, assessment: { stakes: "play", irreversible: false }, canFollowUp: true });
  check(!smallGo.remember, "'just do it' on something it would never ask about keeps nothing");
  const upFront = nextStep(null, { message: "Build me a website for my bakery, ask me some questions first", fresh: GO, assessment: product, remembered: "go", canFollowUp: true });
  check(upFront.step.kind === "ask" && upFront.remember?.pref === "ask", "'ask me some questions first' starts them and is kept");
  check(wantsQuestionsFirst("interview me first") && !wantsQuestionsFirst("I have questions about my invoice"), "questions-first detector");

  check(askPreferenceKey("product") === "ask_first:product", "one account-wide row per tier");
  check(askPreferenceText("product", "go") === "Work for other people: just go, no questions first", "the Memory page reads it in words");
  for (const tier of ["play", "product", "critical"] as const) {
    for (const pref of ["ask", "go"] as const) check(readAskPreference(askPreferenceText(tier, pref)) === pref, `${tier}/${pref} reads back`);
  }
  check(readAskPreference("") === null && readAskPreference("whatever") === null, "nothing kept, nothing read");
  check(decodeState(encodeState({ stage: "offered", request: "r", stakes: "critical", asked: [], answers: [] }))?.stakes === "critical", "the tier survives the round trip");
  check(decodeState('{"stage":"offered","request":"r","stakes":"lots"}')?.stakes === undefined, "a junk tier is dropped");
}

// ── Owner's product decisions (2026-11-23) ────────────────────────────
// 1. Product questions only: never a technical one.
for (const q of [
  "Which tech stack should I use?",
  "Do you prefer React or Vue?",
  "What database should we use?",
  "Should it be hosted on AWS?",
  "Do you need a REST API?",
  "What architecture do you want?",
  "Should we use serverless functions?",
  "Which programming language should it be in?",
  "Do you want OAuth or email login?",
  "What should the data model look like?",
]) check(isTechnicalQuestion(q), `technical, refused: "${q}"`);
for (const q of [
  "Who will use the website most?",
  "What should the home page look like?",
  "Do customers need to order online?",
  "What colours fit your brand?",
  "How many tables do you want bookable online?",
  "Should it show your opening hours?",
  "Do you want a photo library page?",
  "Should customers be able to log in to see past orders?",
  "When do you need it by?",
]) check(!isTechnicalQuestion(q), `product, kept: "${q}"`);
check(parseQuestion('{"question":"Which database should we use?","suggested":"Postgres"}') === null, "the picker refuses a technical question");
check(/TECHNICAL CHOICES ARE YOURS/.test(ONE_PERSONA) && /Never ask them a technical question/.test(ONE_PERSONA), "the persona never asks a technical question");
check(/hard to reverse, in plain words, with your recommendation/.test(ONE_PERSONA), "only hard-to-reverse technical choices are explained, with a recommendation");
check(/a technical choice only when it is hard to reverse/.test(turnNote("skipped")), "assumptions list product decisions; technical ones only when hard to reverse");

// 2. A pending answer never stalls unrelated work.
{
  const pending = "Build me a website for my bakery";
  check(startsNewRequest("Write a tweet announcing our new hours", pending), "an order for something else is new work");
  check(startsNewRequest("Also, write me a poem about rain", pending) && startsNewRequest("by the way, what time is it", pending), "'also…', 'by the way…' start something else");
  for (const answer of ["Make the website pink", "Make sure the menu is on every page", "Make ordering easy for customers", "We want catering orders", "Customers can't find our hours"]) {
    check(!startsNewRequest(answer, pending), `an answer, not new work: "${answer}"`);
  }
  const asking: OneModeState = { stage: "asking", request: pending, stakes: "product", asked: [{ q: OPENING_QUESTIONS[0], suggested: "Regulars can't find our hours" }], answers: [] };
  const other = nextStep(asking, { message: "Also, write me a poem about rain", fresh: GO, canFollowUp: true });
  check(other.step.kind === "go" && (other.step as { how: string }).how === "fresh", "the unrelated request goes ahead now");
  check(other.carry === true && other.state?.stage === "asking" && other.state.answers.length === 0 && other.state.carried === 1, "the waiting question stays open, carried once");
  const picture = nextStep(asking, { message: "draw me a croissant", makerLane: true, fresh: GO, canFollowUp: true });
  check(picture.step.kind === "go" && picture.carry === true, "a picture asked for meanwhile is made, the question stays open");
  const again = nextStep(other.state, { message: "Also, write me a haiku about bread", fresh: GO, canFollowUp: true });
  check(again.step.kind === "go" && !again.carry && again.state === null, "carried once; moving on again lets it go");
  const answered = nextStep(other.state, { message: "Regulars can't find our hours", choice: "accept", fresh: GO, canFollowUp: true });
  check(answered.step.kind === "ask" && answered.state?.answers[0] === "Regulars can't find our hours" && !answered.state.carried, "answering later picks up where it was");
  const offered: OneModeState = { stage: "offered", request: pending, stakes: "product", asked: [], answers: [] };
  const otherOffer = nextStep(offered, { message: "Write a tweet announcing our new hours", fresh: GO, canFollowUp: true });
  check(otherOffer.step.kind === "go" && otherOffer.carry === true && otherOffer.state?.stage === "offered", "the quick choice also stays open past unrelated work");
  const goLater = nextStep(otherOffer.state, { message: "Just go for it", choice: "go", execute: true, fresh: ASK, canFollowUp: true });
  check(goLater.step.kind === "go" && (goLater.step as { how: string; interview?: { request: string } }).interview?.request === pending, "'Just go' later does the original request");
  check(/Request: Build me a website for my bakery/.test(turnNote("skipped", { interview: { request: pending, qa: [] } })), "the work turn names which earlier request");
  const p1 = pendingPrompt(offered);
  check(p1.kind === "offer" && p1.line.endsWith(OFFER_TEXT) && p1.options.length === 2, "a carried quick choice keeps its words and buttons");
  const p2 = pendingPrompt(asking);
  check(p2.kind === "question" && p2.line.endsWith(OPENING_QUESTIONS[0]) && p2.options[0]!.send === "Regulars can't find our hours", "a carried question keeps its suggestion");
  check(WAITING_NOTE === "Anything else you ask meanwhile goes ahead.", "a waiting turn says what keeps going");
}

// 3. A standing choice persists; an inference is never one.
{
  const offered: OneModeState = { stage: "offered", request: "r", stakes: "product", asked: [], answers: [] };
  check(nextStep(offered, { message: "Ask me a few questions", choice: "ask", fresh: GO, canFollowUp: true }).remember?.pref === "ask", "the button is their choice: kept");
  check(nextStep(offered, { message: "questions first", fresh: GO, canFollowUp: true }).remember?.pref === "ask", "'questions first' is their choice: kept");
  const yes = nextStep(offered, { message: "yes", fresh: GO, canFollowUp: true });
  check(yes.step.kind === "ask" && !yes.remember, "a bare 'yes' starts the questions this time but is not kept");
  check(isExplicitAskReply("ask me some questions") && !isExplicitAskReply("sure"), "explicit asks");
  const surprise = nextStep(null, { message: "Build me a website, surprise me", fresh: ASK, assessment: { stakes: "product", irreversible: false }, canFollowUp: true });
  check(surprise.step.kind === "go" && !surprise.remember, "'surprise me' goes, and is not kept");
}

// 4. One-way doors need their words.
check(/ONE-WAY DOORS NEED THEIR WORDS/.test(ONE_PERSONA) && /first public launch of anything needs their OK in so many words/.test(ONE_PERSONA), "no launch on a guess");
check(askFirst(ASK, "go", { stakes: "critical", irreversible: true }) === "offer", "a remembered 'just go' never covers a critical one-way door");

// 5. Their words as typed; summaries point back to them.
{
  const long = "Build me a website for my bakery. ".repeat(60).trim();
  const kept = nextStep(null, { message: long, fresh: ASK, assessment: { stakes: "product", irreversible: false }, canFollowUp: true });
  check(kept.state?.request === long, `their request is kept whole (${long.length} characters)`);
  check(quoteTheirWords("  Build me   a website ") === "“Build me a website”", "quoted as typed, spaces tidied");
  check(quoteTheirWords("x".repeat(500), 20).length === 22 && quoteTheirWords("x".repeat(500), 20).endsWith("…”"), "a long request is cut with …, never rewritten");
  const ticketReply = "For: our regulars\nOutcome: they find the menu online\nDone when: online orders arrive\n\nHere is the site…";
  const pointed = withTheirWords(ticketReply, "Build me a website for my bakery");
  check(/Done when: online orders arrive\nIn your words: “Build me a website for my bakery”\n\nHere is the site/.test(pointed), "the ticket points back to their words, right under it");
  check(withTheirWords(pointed, "Build me a website for my bakery") === pointed, "said once");
  check(withTheirWords("No ticket here.", "Make me a game").startsWith("In your words: “Make me a game”"), "no ticket: their words first");
}
const serverSrc = readFileSync(resolve(import.meta.dirname, "..", "src/lib/buzzy/server.ts"), "utf8");
check(/withTheirWords\(cleanReply, theirRequest\)/.test(serverSrc), "the server points the ticket back to their words");
check(/from your words: \$\{quoteTheirWords\(theirRequest, 300\)\}/.test(serverSrc) && /for your request \$\{quoteTheirWords\(theirRequest, 160\)\}/.test(serverSrc), "stored summaries point back to their words");
check(/if \(!val \|\| slotValues\[slotId\]/.test(serverSrc), "the ticket never overwrites a brief line they gave");
check(/note: WAITING_NOTE/.test(serverSrc), "waiting turns carry the note");

// "Go" delivers the work, never a questionnaire (seen 2026-11-23 after "Just go for it").
check(
  asksInsteadOfDoing("I need a few details to build your salon website. Please provide:\n\n1. **Salon Name**: What is the name of your business?\n2. **Services & Prices**: List the main services."),
  "'Please provide: 1. Salon name…' asks instead of doing",
);
check(asksInsteadOfDoing("Before I start, could you tell me your budget?"), "'before I start, could you tell me' asks instead of doing");
check(asksInsteadOfDoing("What's your salon called?\nWhat services do you offer?"), "two questions in a row ask instead of doing");
check(!asksInsteadOfDoing("Here's your site plan: Home, Services, Book.\n\nWhat I assumed for you:\n- Four pages\n\nWant me to change anything?"), "the work with one closing question is the work");
for (const how of ["fresh", "skipped", "ticket"] as const) check(/Never ask them for a name, a price, an address/.test(turnNote(how)), `${how}: placeholders, never questions`);
check(/do not ask them anything/.test(DO_IT_NOW) && /\[Your business name\]/.test(DO_IT_NOW), "the retry asks for the work with marked placeholders");
check(/asksInsteadOfDoing\(reply\.content\)/.test(readFileSync(resolve(import.meta.dirname, "..", "src/lib/buzzy/server.ts"), "utf8")), "the server retries a go turn that asked instead of doing");
check(goReminder().includes(ASSUMPTIONS_HEADING) && /No questions/.test(goReminder()) && !goReminder(true).includes(ASSUMPTIONS_HEADING), "the reminder after their message: the work, no questions, what was assumed");
{
  const src = readFileSync(resolve(import.meta.dirname, "..", "src/lib/buzzy/server.ts"), "utf8");
  check(/String\(messages\[0\]!\.content\) \+ "\\n\\n" \+ goReminder\(surface === "voice"\)/.test(src), "the reminder ends the instructions on go turns");
  check(!/afterNotes\.push\(goReminder/.test(src), "never as a system message after theirs (some providers refuse it)");
}

// What already exists is an option, never a gate (the note and the tool's own result).
{
  const { inspirationNote, inspirationResult } = await import("../src/lib/buzzy/inspirationSearch");
  const hits = [{ source: "Starting board", title: "Logo for a small business", offer: "Want me to put a simple starting board for “Logo for a small business” on your board?" }] as never;
  for (const [name, text] of [["note", inspirationNote(hits)], ["tool result", inspirationResult("logo", hits)]] as const) {
    check(!/wait for their answer/.test(text) && /never a reason to hold back what they asked for/.test(text), `the inspiration ${name} offers, it does not hold the work back`);
  }
}

// Replies that count.
check(isGoReply("Just go for it") && isGoReply("cut to the chase") && isGoReply("no more questions please"), "go replies");
check(!isGoReply("I want to go to Japan") && !isGoReply("Let's go over the menu"), "'go' inside an ordinary sentence is not a go");
check(!isGoReply("There's no time pressure") && !isGoReply("That's enough of a goal for us, honestly, if regulars come back"), "an answer that happens to say 'no time' or 'that's enough' is an answer");
check(isDelegateReply("you decide") && isDelegateReply("Up to you!") && !isDelegateReply("I decide on Mondays"), "handing the decision over");
{
  const asking: OneModeState = { stage: "asking", request: "r", asked: [{ q: OPENING_QUESTIONS[0], suggested: "Regulars can't find our hours" }], answers: [] };
  const handed = nextStep(asking, { message: "you decide", fresh: GO, canFollowUp: true });
  check(handed.step.kind === "ask" && handed.state?.answers[0] === "Regulars can't find our hours" && !handed.remember, "'you decide' to a question takes the suggestion and keeps asking");
  const pressure = nextStep(asking, { message: "There's no time pressure, it just has to look nice", fresh: GO, canFollowUp: true });
  check(pressure.step.kind === "ask" && pressure.state?.answers[0]?.startsWith("There's no time pressure"), "'no time pressure' is an answer, not 'just go'");
  const offeredUp = nextStep({ stage: "offered", request: "r", stakes: "play", asked: [], answers: [] }, { message: "up to you", fresh: GO, canFollowUp: true });
  check(offeredUp.step.kind === "go" && !offeredUp.remember, "'up to you' to the quick choice is go, and is not kept (handing over is not their standing choice)");
}
check(isAskReply("Ask me a few questions") && isAskReply("questions first") && isAskReply("Sure!"), "ask replies");
check(isAskReply("Questions.") && isAskReply("ask me") && isGoReply("Go.") && isGoReply("just go!"), "one-word spoken answers to the choice");
check(!isAskReply("Just go for it") && !isAskReply("sure, just go"), "a go is never an ask");
check(isAcceptReply("yes") && isAcceptReply("That's right.") && isAcceptReply("use that"), "accept replies");
check(!isAcceptReply("yes but for catering") && !isAcceptReply("We sell cakes"), "an answer with content is their own answer");

// State survives the database round trip, and junk is no state.
{
  const s: OneModeState = { stage: "asking", request: "r", asked: [{ q: "q?", suggested: "s" }], answers: ["a"] };
  check(JSON.stringify(decodeState(encodeState(s))) === JSON.stringify(s), "state round-trips");
  check(decodeState("not json") === null && decodeState(null) === null && decodeState('{"stage":"done"}') === null, "junk decodes to no state");
}

// The words on screen.
check(OFFER_TEXT === "I can ask a few questions before I start, or just go for it — which do you prefer?", "the offer is the owner's sentence");
check(OFFER_OPTIONS.length === 2 && OFFER_OPTIONS[0]!.value === "ask" && OFFER_OPTIONS[1]!.value === "go", "two buttons: questions, or go");
check(OPENING_QUESTIONS[0] === "What problem are you trying to solve?", "opener 1");
check(OPENING_QUESTIONS[1] === "What would make you (or your team) incredibly satisfied with how this turns out?", "opener 2");
check(questionText("Q?", "S") === "Q?\nSuggested: S" && questionText("Q?", "") === "Q?", "question text shows the suggestion");
check(questionOptions("S")[0]!.value === "accept" && questionOptions("S")[0]!.send === "S" && questionOptions("S").length === 2, "one tap accepts the suggestion");
check(questionOptions("").length === 1 && questionOptions("")[0]!.value === "go", "no suggestion: only Just go");

// ── 4. The prompts ─────────────────────────────────────────────────────
check(/never ask "does this plan look right\?"/i.test(ONE_PERSONA), "the persona forbids plan-for-approval");
check(!/ask exactly one question per turn|DISCOVERY FIRST|MANDATED GOAL|Decisions Made box|define the work/i.test(ONE_PERSONA), "no Work-mode interview in the persona");
check(/DON'T REINVENT THE WHEEL/.test(ONE_PERSONA) && /THE RESULT, NOT THE MEANS/.test(ONE_PERSONA), "result over means, and what already exists");
check(turnNote("fresh").includes(ASSUMPTIONS_HEADING) && /Leave the list out/.test(turnNote("fresh")), "fresh go lists assumptions when there are any");
check(turnNote("skipped").includes(ASSUMPTIONS_HEADING) && !/Leave the list out/.test(turnNote("skipped")), "'just go' always lists what was assumed");
check(/For: .*\nOutcome: .*\nDone when: /s.test(turnNote("ticket")), "the ticket: who, outcome, done when");
check(/no confirmation question/.test(turnNote("ticket")), "the ticket goes straight to work");
check(!turnNote("fresh", { spoken: true }).includes(ASSUMPTIONS_HEADING), "spoken turns name assumptions in a sentence, not a list");

// The server and page no longer carry the old modes.
const root = resolve(import.meta.dirname, "..");
const server = readFileSync(resolve(root, "src/lib/buzzy/server.ts"), "utf8");
const info = readFileSync(resolve(root, "src/lib/buzzy/info.ts"), "utf8");
const talk = readFileSync(resolve(root, "public/buzzy/talk.html"), "utf8");
check(!/PLAN_FIRST_INSTRUCTION|shouldPlanFirst|Does this plan look right/.test(server + info), "plan-first is gone from the server");
check(!/DISCOVERY FIRST|PRECISION PASS|MANDATED GOAL|CHAT_PERSONA|personaForMode/.test(server), "the Work persona and the persona switch are gone");
check(server.includes("ONE_PERSONA") && server.includes("askOrGo(") && server.includes("nextStep("), "the server uses the one persona and the rule");
check(!/id="modeTabs"|class="work-offer"|Define the work|shouldOfferWork/.test(talk), "Talk has no Chat/Work switch and no 'define the work' offer");
check(/execute: sentExecute/.test(talk), "Do it really sends execute (it used to send false)");
check(/choice: sentChoice/.test(talk) && /bz-choice/.test(talk), "Talk sends the pressed choice and draws the buttons");

// ── 5. Reading the reply ───────────────────────────────────────────────
{
  const reply =
    "Here is your bakery site plan.\n\nHome, Menu, About, Order.\n\n" +
    `${ASSUMPTIONS_HEADING}\n- Four pages, phone first\n- Warm colours from your logo\n- Ordering through Square\n\nTell me what to change.`;
  const a = parseAssumptions(reply);
  check(a.length === 3 && a[0] === "Four pages, phone first" && a[2] === "Ordering through Square", `assumptions parsed: ${JSON.stringify(a)}`);
  check(parseAssumptions("**Assumptions:**\n1. Ages 8–10\n2. Ten minutes").length === 2, "bold heading and numbered list");
  check(parseAssumptions("No list here. I assumed nothing.").length === 0, "no heading, no assumptions");
  const t = parseTicket("For: our regular customers in Austin\nOutcome: they can find the menu and order online\nDone when: online orders start arriving\n\nHere's the site…");
  check(t.for === "our regular customers in Austin" && t.outcome?.startsWith("they can find") && t.doneWhen === "online orders start arriving", "ticket parsed");
  check(Object.keys(parseTicket("Just a reply.")).length === 0, "no ticket, nothing parsed");
}

// ── 6. The question generator ──────────────────────────────────────────
check(parseQuestion('{"question":"Who will use it?","suggested":"Our regulars, mostly on phones"}')?.q === "Who will use it?", "a later question parses");
check(parseQuestion('```json\n{"question": null}\n```') === null, "no question left → null");
check(parseQuestion("garbage") === null, "garbage → null");
check(parseQuestion("garbage", OPENING_QUESTIONS[0])?.q === OPENING_QUESTIONS[0], "an opener survives a garbage reply");
check(parseQuestion('{"question":"x","suggested":"Which colour do you want?"}', OPENING_QUESTIONS[0])?.suggested === "", "a question is never a suggestion");
check(parseQuestion('{"question":"x","suggested":"it depends"}', OPENING_QUESTIONS[0])?.suggested === "", "'it depends' is not a suggestion");
check(parseQuestion('{"question":"What is the deadline","suggested":"Before the holidays"}')?.q === "What is the deadline?", "a question mark is added");

// ── 7. The budget, before work goes to agents (owner, 2026-11-23) ─────
// "No bankrupting people for small projects. You need to get an idea of how much this
// matters to people in the form of budget before you go."
{
  // Word for word: Code Monkey's budget.ts (#372) asks with the same words and amounts.
  check(BUDGET_QUESTION === "How much should I spend on this, at most? I'll keep my work under that amount.", "the budget question, word for word");
  check(JSON.stringify(BUDGET_ANSWERS.play) === JSON.stringify(["$2 — a quick try", "$5 — a solid start", "$20 — lots of care"]), "play: $2 / $5 / $20");
  check(JSON.stringify(BUDGET_ANSWERS.product) === JSON.stringify(["$20 — a quick try", "$50 — a solid start", "$200 — lots of care"]), "product: $20 / $50 / $200");
  check(JSON.stringify(BUDGET_ANSWERS.critical) === JSON.stringify(["$100 — a quick try", "$200 — a solid start", "$1,000 — lots of care"]), "critical: $100 / $200 / $1,000");
  for (const tier of ["play", "product", "critical"] as const) {
    const o = budgetOptions(tier);
    check(
      o.length === 3 && o.every((x) => x.value === "amount" && x.send === x.label) && o.filter((x) => x.suggested).length === 1 && o[1]!.suggested === true,
      `${tier}: three tap answers, the middle one suggested`,
    );
    check(budgetSuggestion(tier) === BUDGET_ANSWERS[tier][1], `${tier}: the suggestion is the middle answer`);
    for (const label of BUDGET_ANSWERS[tier]) {
      const n = Number(label.split(" ")[0]!.replace(/[$,]/g, ""));
      check(budgetInWords(label) === n && budgetInWords(label, { answer: true }) === n, `a tapped "${label}" reads back as ${formatDollars(n)}`);
    }
  }

  // Work handed to agents: a coding project or research at scale. Everything else is a reply.
  for (const m of [
    "Build me a website for my bakery",
    "Make a simple habit tracker app",
    "Create a booking page for my salon",
    "Set up an online shop for my candles",
    "Make a game about dinosaurs for my kids",
    "Build a dashboard that shows my sales",
    "Fix the typo on my website",
    "Add a blog to our site",
    "Code a Python script that renames my files",
    "Can you build me an app for my gym?",
    "Do deep research on the meal-kit market",
    "Research every grant my bakery could get",
    "Compare 30 CRM tools for me",
  ]) check(handsToAgents(m), `goes to agents: "${m}"`);
  for (const m of [
    "Write me a short poem about rain",
    "Write a launch tweet for our new app",
    "Design a logo for my site",
    "Write me a one-page summary of this article",
    "Develop a workout program for me",
    "Write a script for my YouTube video",
    "Make a board game for my kids",
    "Plan a game night for my friends",
    "Plan my wedding",
    "Write a business plan for my bakery",
    "How do I build a website?",
    "research the best stroller for city walks",
    "look up the current USPS stamp price",
    "Find all my receipts from March",
  ]) check(!handsToAgents(m), `done inside a reply: "${m}"`);

  // An amount in their words, and only a limit counts (a price inside the thing is not one).
  for (const [text, want] of [
    ["under $20", 20],
    ["50 bucks", 50],
    ["Build me an app, keep it under $30", 30],
    ["my budget is $200", 200],
    ["$30 max", 30],
    ["I can spend 200 dollars on it", 200],
    ["I have $2k for this", 2000],
    ["Build me a website for my bakery under $20, ok?", 20],
    ["Under $20. Actually make it $50 max", 50],
    ["a shop that sells $20 T-shirts", null],
    ["T-shirts that cost $20", null],
    ["Build me an app", null],
    ["the 50 states", null],
    ["done in 20 minutes", null],
  ] as Array<[string, number | null]>) check(budgetInWords(text) === want, `amount in "${text}": ${want}`);
  for (const [text, want] of [["50", 50], ["about 30", 30], ["100 max", 100], ["not sure", null], ["you decide", null], ["yes", null]] as Array<[string, number | null]>) {
    check(budgetInWords(text, { answer: true }) === want, `an answer to the budget question, "${text}": ${want}`);
  }
  check(formatDollars(1000) === "$1,000" && formatDollars(5.5) === "$5.50" && formatDollars(50) === "$50", "amounts are written as people write them");

  // The equation: money spent can't be taken back, and the answer is one tap.
  const smallest = askBudget({ size: "small", stakes: "play", hurried: true }, { agentWork: true });
  check(smallest.ask && smallest.costOfMisreading === 3.33 && smallest.costOfAsking === 0.67, `even the smallest, most hurried agent job asks: ${smallest.why}`);
  check(/× 10 \(can't undo\)/.test(smallest.why) && ASK_OR_GO.CANT_UNDO_WEIGHT === 10, "the budget carries the can't-undo weight");
  check(Math.round(BUDGET_RULE.TAP_MINUTES * 60) === 10 && Math.round(BUDGET_RULE.P_GUESS_WRONG * 100) === 67, "one tap is ten seconds; a guess among three amounts is wrong two times in three");
  check(askBudget({ size: "large", stakes: "product" }, { agentWork: true }).costOfMisreading === 160, "0.67 × 8 × 3 × 10 = 160 for a big product job");
  check(!askBudget({ size: "large", stakes: "critical" }, { agentWork: true, budget: 50 }).ask, "an amount in their words: no question");
  check(!askBudget({ size: "large", stakes: "critical" }, { agentWork: false }).ask, "done inside a reply: no question");

  const product = { stakes: "product" as const, irreversible: false, size: "large" as const };
  const pending = "Build me a website for my bakery";

  // Asked for an agent project with no amount.
  {
    const r = nextStep(null, { message: "Build me a habit tracker app with daily streaks", fresh: GO, assessment: product, agentWork: true, canFollowUp: true });
    check(r.step.kind === "budget" && r.state?.stage === "budget" && r.state.agentWork === true, "an agent project with no amount: how much to spend, first");
    const p = pendingPrompt(r.state!);
    check(p.options.map((o) => o.label).join("|") === BUDGET_ANSWERS.product.join("|") && p.line.endsWith(BUDGET_QUESTION), "its three amounts are sized to the stakes");
    const play = nextStep(null, { message: "Make a game about dinosaurs for my kids", fresh: GO, assessment: { stakes: "play", irreversible: false }, agentWork: true, canFollowUp: true });
    check(play.step.kind === "budget" && pendingPrompt(play.state!).options[1]!.label === "$5 — a solid start", "a play project suggests $5");
    const offered = nextStep(null, { message: pending, fresh: ASK, assessment: product, agentWork: true, canFollowUp: true });
    check(offered.step.kind === "offer" && offered.state?.agentWork === true, "a request the rule stops for still gets its one quick choice first");
    const noId = nextStep(null, { message: "Build me an app", fresh: GO, assessment: product, agentWork: true, canFollowUp: false });
    check(noId.step.kind === "go" && noId.step.agentWork === true && noId.step.budget === undefined, "no conversation to follow up in: no dangling question, and nothing that costs money starts");
  }

  // Not asked when an amount is in their words.
  {
    for (const [message, want] of [["Build me a habit tracker app, keep it under $20", 20], ["Build me a habit tracker app, I've got 50 bucks", 50]] as Array<[string, number]>) {
      const r = nextStep(null, { message, fresh: GO, assessment: product, agentWork: true, canFollowUp: true });
      check(r.step.kind === "go" && r.step.budget === want && r.state === null, `"${message}": no question, the work goes with ${formatDollars(want)}`);
    }
    const offered = nextStep(null, { message: `${pending}, under $30`, fresh: ASK, assessment: product, agentWork: true, canFollowUp: true });
    check(offered.step.kind === "offer" && offered.state?.budget === 30, "the amount is kept with the request");
    const went = nextStep(offered.state, { message: "Just go for it", choice: "go", execute: true, fresh: GO, canFollowUp: true });
    check(went.step.kind === "go" && went.step.budget === 30 && went.state === null, "'Just go for it' then goes straight to the work");
    const followUp = nextStep(null, { message: "Now add a login page to my app", fresh: GO, assessment: product, agentWork: true, knownBudget: 50, canFollowUp: true });
    check(followUp.step.kind === "go" && followUp.step.budget === 50, "an amount set earlier in the conversation is not asked again");
    // In the questions: an amount in an answer skips the budget question.
    const s: OneModeState = { stage: "asking", request: pending, stakes: "product", agentWork: true, asked: [{ q: OPENING_QUESTIONS[0], suggested: "" }, { q: OPENING_QUESTIONS[1], suggested: "" }], answers: ["Nobody finds our hours"] };
    const after = nextStep(s, { message: "Regulars order online, and I can spend $80 on it", fresh: GO, canFollowUp: true });
    check(after.step.kind === "ask" && (after.step as { index: number }).index === 2, "the openers mentioned an amount: no budget question");
  }

  // Asked once, alone, in the go path.
  {
    const offered = nextStep(null, { message: pending, fresh: ASK, assessment: product, agentWork: true, canFollowUp: true });
    const justGo = nextStep(offered.state, { message: "Just go for it", choice: "go", execute: true, fresh: GO, canFollowUp: true });
    check(justGo.step.kind === "budget" && justGo.state?.stage === "budget" && justGo.remember?.pref === "go", "'Just go for it': only how much to spend (and 'go' is still kept)");
    const tapped = nextStep(justGo.state, { message: "$50 — a solid start", choice: "amount", fresh: GO, canFollowUp: true });
    check(
      tapped.step.kind === "go" && tapped.step.how === "budget" && tapped.step.budget === 50 && tapped.state === null && tapped.step.interview?.request === pending,
      "one tap, then the work: no other question",
    );
    const typed = nextStep(justGo.state, { message: "20", fresh: GO, canFollowUp: true });
    check(typed.step.kind === "go" && typed.step.budget === 20, "a typed amount works the same");
    const preempt = nextStep(null, { message: `${pending}, just do it`, fresh: ASK, assessment: product, agentWork: true, canFollowUp: true });
    check(preempt.step.kind === "budget" && preempt.remember?.pref === "go", "'…, just do it': only the budget question");
    const remembered = nextStep(null, { message: "Build me a website for my gym", fresh: ASK, assessment: product, remembered: "go", agentWork: true, canFollowUp: true });
    check(remembered.step.kind === "budget", "they chose 'just go' for this kind of work before: still the budget, alone");
    const midway = nextStep(
      { stage: "asking", request: pending, stakes: "product", agentWork: true, asked: [{ q: OPENING_QUESTIONS[0], suggested: "x" }], answers: [] },
      { message: "just go", fresh: GO, canFollowUp: true },
    );
    check(midway.step.kind === "budget" && midway.state?.stage === "budget", "'just go' in the middle of the questions: only the budget question");
    // No amount ("just go", "you decide"): an amount is theirs to name, never a guess.
    for (const said of ["just go", "you decide", "not sure", "yes"]) {
      const r = nextStep(justGo.state, { message: said, fresh: GO, canFollowUp: true });
      check(
        r.step.kind === "go" && r.step.budget === undefined && r.step.agentWork === true && r.carry === true && r.state?.stage === "budget" && r.state.carried === 1,
        `"${said}" to the budget question: what fits in a reply goes ahead, nothing that costs money starts, the question stays open once`,
      );
    }
    const open = nextStep(justGo.state, { message: "just go", fresh: GO, canFollowUp: true });
    const later = nextStep(open.state, { message: "$20 — a quick try", choice: "amount", fresh: GO, canFollowUp: true });
    check(later.step.kind === "go" && later.step.budget === 20 && later.state === null, "tapping an amount later starts the work");
    const twice = nextStep(open.state, { message: "whatever", fresh: GO, canFollowUp: true });
    check(twice.step.kind === "go" && twice.state === null && !twice.carry, "asked once: never a second time");
    const meanwhile = nextStep(justGo.state, { message: "Also, write me a haiku about bread", fresh: GO, canFollowUp: true });
    check(meanwhile.step.kind === "go" && meanwhile.carry === true && meanwhile.state?.stage === "budget", "something else meanwhile goes ahead; the budget question stays open");
    const pp = pendingPrompt(meanwhile.state!);
    check(pp.options.every((o) => o.value === "amount") && pp.line.endsWith(BUDGET_QUESTION), "the carried question keeps its three amounts");
  }

  // Never asked for small things (nor anything done inside a reply).
  for (const message of ["Write me a short poem about rain", "Write a launch tweet for our new app", "Draw me a croissant", "What's 15% of 80?", "Email my landlord about the leak", "Plan my wedding"]) {
    const agentWork = handsToAgents(message);
    const r = nextStep(null, { message, fresh: GO, assessment: { stakes: "play", irreversible: false, size: "small" }, agentWork, canFollowUp: true });
    check(!agentWork && r.step.kind === "go" && r.step.budget === undefined && !r.step.agentWork && r.state === null, `never asked: "${message}"`);
  }
  {
    const plan = nextStep({ stage: "offered", request: "Plan my wedding", stakes: "product", asked: [], answers: [] }, { message: "Just go for it", choice: "go", execute: true, fresh: GO, canFollowUp: true });
    check(plan.step.kind === "go" && plan.state === null, "'just go' on a big job done inside a reply: straight to the work");
    const picture = nextStep(null, { message: "Make me a picture of a castle", makerLane: true, fresh: GO, agentWork: false, canFollowUp: true });
    check(picture.step.kind === "go", "a maker lane never asks");
  }

  // The questions: the budget comes right after the two openers, with its suggestion.
  {
    const offered = nextStep(null, { message: pending, fresh: ASK, assessment: product, agentWork: true, canFollowUp: true });
    let s = nextStep(offered.state, { message: "Ask me a few questions", choice: "ask", fresh: GO, canFollowUp: true }).state!;
    s = { ...s, asked: [{ q: OPENING_QUESTIONS[0], suggested: "Customers can't find our hours" }] };
    const a1 = nextStep(s, { message: "Customers can't find our hours", choice: "accept", fresh: GO, canFollowUp: true });
    check(a1.step.kind === "ask" && (a1.step as { index: number }).index === 1, "opener 1, then opener 2");
    const s2 = { ...a1.state!, asked: [...a1.state!.asked, { q: OPENING_QUESTIONS[1], suggested: "Regulars order online" }] };
    const a2 = nextStep(s2, { message: "Regulars order online", choice: "accept", fresh: GO, canFollowUp: true });
    const third = a2.state?.asked[2];
    check(
      a2.step.kind === "budget" && a2.state?.stage === "asking" && third?.q === BUDGET_QUESTION && third.suggested === "$50 — a solid start",
      "right after the two openers: how much to spend, with its suggested answer",
    );
    const a3 = nextStep(a2.state, { message: "$200 — lots of care", choice: "amount", fresh: GO, canFollowUp: true });
    check(a3.step.kind === "ask" && (a3.step as { index: number }).index === 3 && a3.state?.budget === 200 && a3.state.answers[2] === "$200 — lots of care", "the tapped amount is their answer, then the questions go on");
    const yes = nextStep(a2.state, { message: "yes", fresh: GO, canFollowUp: true });
    check(yes.state?.budget === undefined && yes.state?.answers[2] === "yes", "a bare yes never picks an amount for them");
    const goThere = nextStep(a2.state, { message: "just go", fresh: GO, canFollowUp: true });
    check(goThere.step.kind === "go" && goThere.step.budget === undefined && goThere.carry === true && goThere.state?.stage === "budget", "'just go' at the budget question: the work, and the question stays open once");
    const goWithAmount = nextStep(a2.state, { message: "just go, $20", fresh: GO, canFollowUp: true });
    check(goWithAmount.step.kind === "go" && goWithAmount.step.budget === 20 && goWithAmount.state === null, "'just go, $20' answers it too");
    let t = { ...a3.state!, asked: [...a3.state!.asked, { q: "When do you need it by?", suggested: "Before the holidays" }] };
    const a4 = nextStep(t, { message: "Before the holidays", choice: "accept", fresh: GO, canFollowUp: true });
    t = { ...a4.state!, asked: [...a4.state!.asked, { q: "What must never happen?", suggested: "Wrong prices online" }] };
    const a5 = nextStep(t, { message: "Wrong prices online", choice: "accept", fresh: GO, canFollowUp: true });
    check(a5.step.kind === "go" && a5.step.how === "ticket" && a5.step.budget === 200 && a5.state === null, "the ticket goes with the amount they tapped");
    check(a5.step.kind === "go" && a5.step.interview?.qa.some((x) => x.q === BUDGET_QUESTION && x.a === "$200 — lots of care") === true, "the ticket turn sees the budget answer");
    const noAmountTicket = goOnRequest({ stage: "asking", request: pending, stakes: "product", agentWork: true, asked: [], answers: [] }, "ticket", { message: "x", canFollowUp: true });
    check(noAmountTicket.step.kind === "go" && noAmountTicket.carry === true && noAmountTicket.state?.stage === "budget", "a ticket with no amount still goes, and the budget question stays open once");
  }

  // What the work turn is told.
  check(/THE BUDGET: at most \$50, the amount they gave/.test(turnNote("budget", { budget: 50, agentWork: true })), "the work turn is told the amount");
  check(/never go over it/.test(budgetNote({ budget: 50 })) && /THE BUDGET: at most \$1,000/.test(turnNote("ticket", { budget: 1000 })), "never over it, on every kind of go");
  check(/NO BUDGET YET/.test(budgetNote({ agentWork: true })) && /nothing that costs money starts/.test(turnNote("budget", { agentWork: true })), "no amount: nothing that costs money starts");
  check(budgetNote({}) === "" && !/BUDGET/.test(turnNote("fresh")) && !/BUDGET/.test(turnNote("skipped")), "nothing about money for work done inside a reply");
  check(/No more questions/.test(turnNote("budget")) && turnNote("budget").includes(ASSUMPTIONS_HEADING), "after the budget: the work, no more questions, and what was assumed");

  // Kept across the database round trip, and for the conversation.
  const bs: OneModeState = { stage: "budget", request: "r", stakes: "product", asked: [], answers: [], agentWork: true, budget: 50 };
  check(JSON.stringify(decodeState(encodeState(bs))) === JSON.stringify(bs), "a budget state round-trips");
  check(decodeState('{"stage":"budget","request":"r","budget":"lots"}')?.budget === undefined, "a junk amount is dropped");
  check(readBudget("50") === 50 && readBudget("") === null && readBudget("lots") === null && readBudget(null) === null, "the kept amount reads back");
  check(BUDGET_KEY.startsWith("_"), "the kept amount is bookkeeping, never shown as a fact");

  // The server and pages.
  const nitro = readFileSync(resolve(import.meta.dirname, "..", "src/lib/buzzy/chat.nitro.ts"), "utf8");
  const chatJs = readFileSync(resolve(import.meta.dirname, "..", "public/buzzy/chat.js"), "utf8");
  check(/const agentWork = !lockdown && !makerLane && handsToAgents\(message\)/.test(serverSrc), "the server asks only for work handed to agents: never in Lockdown, never for a maker lane");
  check(/budgetOptions\(tier\)/.test(serverSrc) && /questionText\(BUDGET_QUESTION, budgetSuggestion\(tier\)\)/.test(serverSrc), "the server writes the budget question with its three amounts");
  check(/memory\.remember\(BUDGET_KEY, String\(step\.budget\)\)/.test(serverSrc), "the amount is kept for the conversation");
  check(/budget: step\.kind === "go" \? step\.budget : undefined/.test(serverSrc), "the work turn gets the amount");
  check(/body\.choice === "amount"/.test(nitro), "a tapped amount reaches the server");
  check(/marked \? !!o\.suggested : i === 0/.test(talk) && /marked \? !!o\.suggested : i === 0/.test(chatJs), "the suggested amount is the main button on both chat surfaces");
}

// ── 8. Questions ask the why and the walls, never the product ──────────
// Owner, 2026-11-23 ("The new way forward"): start with the why; explain the
// guardrails, not the product. Their idea is a starting point, not a spec.
for (const q of [
  "What features do you want?",
  "Should it have a booking system?",
  "Should the site include a blog?",
  "Should it show your opening hours?",
  "Do you want a photo gallery page?",
  "Would you like a contact form?",
  "Do you want online ordering?",
  "What should the home page look like?",
  "What colours do you want?",
  "How should the game play?",
  "What levels should the game have?",
  "Should customers be able to log in to see past orders?",
  "Do you want customers to be able to order online?",
  "What should it do?",
]) check(isSpecQuestion(q), `about the product, refused: "${q}"`);
for (const q of [
  "Who will use it most?",
  "When do you need it by?",
  "What must never happen?",
  "Is there anything it must never do?",
  "Do you take online orders today?",
  "What happens today when customers can't find your hours?",
  "How will you know it worked?",
  "Who should never see it?",
  "How many people will use it at once?",
  "What has stopped you from fixing this so far?",
  "What is the most you can spend on ads each month?",
]) check(!isSpecQuestion(q) && !isTechnicalQuestion(q), `the why or a wall, kept: "${q}"`);
check(parseQuestion('{"question":"What features should the app have?","suggested":"Streaks and reminders"}') === null, "the picker refuses a feature question");
check(parseQuestion('{"question":"When do you need it by?","suggested":"Before the holidays"}')?.q === "When do you need it by?", "a wall is kept");
{
  const ticket = turnNote("ticket");
  check(/\nWhy: what they are really trying to achieve/.test(ticket) && /\nTheir idea: what they first pictured, if they named something \(a starting point, not a spec\)/.test(ticket), "the ticket keeps the why and their idea on separate lines");
  check(/\nLimits: the hard limits they gave \(time, money, what must never happen\)/.test(ticket), "the ticket names the walls");
  check(/Aim at the why and the outcome, not at their first idea of how/.test(ticket), "the work aims at the why, not at the first idea");
  const t = parseTicket(
    "For: my kids\nWhy: they are bored on long drives\nTheir idea: a racing game\nOutcome: car trips they look forward to\nLimits: under $20, no ads\nDone when: they ask to play it\n\nHere it is…",
  );
  check(t.why === "they are bored on long drives" && t.idea === "a racing game" && t.limits === "under $20, no ads" && t.for === "my kids" && t.doneWhen === "they ask to play it", "the ticket's lines read back apart");
  check(/challenge: ticket\.why/.test(serverSrc) && /ticket\.idea && `Their idea: \$\{ticket\.idea\}`/.test(serverSrc), "the server keeps the why in the brief and the idea apart in memory");
}

// ── 9. Building on the Idea Board: one mode steps aside ────────────────
// Owner, 2026-11-24: "you should just be able to talk to Beezilla, and that should be all
// you need to do to make an orchestration." The page builds the flow card by card from
// the reply's actions (boardOrchestrator.ts), the reply is one sentence, and the whole
// build is one Undo. A quick choice comes back without those actions: no build at all.
{
  const invoices = "set up an automation for my invoices: read new emails, pull out the invoice, save it to the drive and tell me on Slack";
  check(asksToOrchestrate(invoices), "the invoices automation is built on the board (pilot.ts)");
  check(nextStep(null, { message: invoices, fresh: ASK, canFollowUp: true }).step.kind === "offer", "as a plain request it would get the quick choice");
  const built = nextStep(null, { message: invoices, fresh: ASK, assessment: { stakes: "product", irreversible: false }, canFollowUp: true, buildsOnBoard: true });
  check(built.step.kind === "go" && built.step.how === "fresh" && built.state === null && !built.carry && !built.remember, "built on the board: it goes at once, nothing asked, nothing kept");
  const research = "build me a workflow that researches 50 competitors and writes a report every week";
  const noBudget = nextStep(null, { message: research, fresh: ASK, agentWork: true, knownBudget: null, canFollowUp: true, buildsOnBoard: true });
  check(noBudget.step.kind === "go" && noBudget.step.agentWork !== true && noBudget.step.budget === undefined, "no budget question for a board build (one model call)");
  const critical = nextStep(null, { message: "build an automation that deletes customer records older than a year", fresh: ASK, assessment: { stakes: "critical", irreversible: true }, canFollowUp: true, buildsOnBoard: true });
  check(critical.step.kind === "go", "a one-way door in the words still goes: the board only lays the flow out, nothing in it runs");
  const waiting: OneModeState = { stage: "asking", request: "Build me a website for my bakery", stakes: "product", asked: [{ q: OPENING_QUESTIONS[0], suggested: "Regulars can't find our hours" }], answers: [] };
  const meanwhile = nextStep(waiting, { message: "Orchestrate a weekly newsletter: find this week's news, write it, I approve it, then email it every Monday.", fresh: GO, canFollowUp: true, buildsOnBoard: true });
  check(meanwhile.step.kind === "go" && meanwhile.state === waiting && !meanwhile.carry, "a question still waiting stays as it was: not carried under the one-sentence reply, not dropped");
  // The budget question waits, a flow is built in between, then a bare amount: it answers
  // the question still on screen (the build never touched it).
  const budgetWaiting: OneModeState = { stage: "budget", request: "Build me a website for my bakery", stakes: "product", asked: [], answers: [], agentWork: true };
  const between = nextStep(budgetWaiting, { message: "Orchestrate a weekly newsletter: find this week's news, write it, I approve it, then email it every Monday.", fresh: GO, canFollowUp: true, buildsOnBoard: true });
  const answered = between.state ? nextStep(between.state, { message: "50", fresh: GO, canFollowUp: true }) : null;
  check(between.state === budgetWaiting && answered?.step.kind === "go" && answered.step.budget === 50, "after a board build, a bare amount still answers the budget question that was waiting");
  // The examples above are what the page really builds: the flag and the page's plan agree.
  for (const m of [invoices, "Orchestrate a weekly newsletter: find this week's news, write it, I approve it, then email it every Monday."]) {
    check(planAppActions(m)?.some((s) => s.do === "board" && s.value === "orchestrate") === true, `the page's plan for it is the board build: "${m.slice(0, 40)}…"`);
  }
  // The server: one flag, worked out once from the board text the build itself reads,
  // before one mode decides; then no one-mode note, go reminder, redo or playbook.
  check(
    (serverSrc.match(/const orchestrating = asksToOrchestrate\(message, \{ boardHasFlow: flowOnBoard \}\)/g) ?? []).length === 1 &&
      (serverSrc.match(/takeBoardPictures\(/g) ?? []).length === 1 &&
      serverSrc.indexOf("const orchestrating = asksToOrchestrate(") < serverSrc.indexOf("const decided = nextStep(savedStep") &&
      /\n\s+buildsOnBoard: orchestrating(?: \|\| browserGo)?,\n/.test(serverSrc),
    "the server tells one mode with the board's own flag, worked out once, before one mode decides",
  );
  check(
    /const oneModeNote = orchestrating(?: \|\| browserGo)? \? "" : turnNote\(/.test(serverSrc) &&
      /assessment\.size !== "small" && !orchestrating(?: && !browserGo)?;/.test(serverSrc) &&
      /const playbookBlock = !orchestrating && \(requestedDraft \|\| hasExistingDraft\)/.test(serverSrc) &&
      /if \(!orchestrating(?: && !browserGo)?\) \{\n\s+if \(oneState\) await memory\.remember\(STATE_KEY/.test(serverSrc),
    "and on that turn: no one-mode note, go reminder, redo or playbook, and the stored question is left alone",
  );
}

async function generatorChecks(): Promise<void> {
  const calls: string[] = [];
  const fake = (reply: string | Error) => async (messages: Array<{ role: string; content: string }>, opts: { model?: string }) => {
    calls.push(String(opts.model));
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const args = { request: "Build me a website for my bakery", transcript: "", known: "", asked: [] as string[], models: ["fast", "main"] };
  const opener = await interviewQuestion({ ...args, index: 0, complete: fake('{"question":"ignored","suggested":"Customers can\'t find our hours online"}') });
  check(opener?.q === OPENING_QUESTIONS[0] && opener.suggested === "Customers can't find our hours online", "opener 1 keeps the fixed wording and gets a suggestion");
  calls.length = 0;
  const failing = await interviewQuestion({ ...args, index: 1, complete: fake(new Error("down")) });
  check(failing?.q === OPENING_QUESTIONS[1] && failing.suggested === "" && calls.join() === "fast,main", "both models down: the opener is still asked, without a suggestion");
  const later = await interviewQuestion({ ...args, index: 2, complete: fake('{"question":"Do you take online orders today?","suggested":"No, phone only"}') });
  check(later?.q === "Do you take online orders today?", "a later question comes from the model");
  const none = await interviewQuestion({ ...args, index: 3, complete: fake('{"question": null}') });
  check(none === null, "nothing left that changes the result → stop asking");
  const down = await interviewQuestion({ ...args, index: 2, complete: fake(new Error("down")) });
  check(down === null, "model down on a later question → stop asking and go");
  const repeat = await interviewQuestion({ ...args, index: 2, asked: ["Who will use it?"], complete: fake('{"question":"Who will use it?","suggested":"Our regulars"}') });
  check(repeat === null, "a repeated question is no question");
  // What the generator is told: never ask what is already known, result not means.
  let system = "";
  await interviewQuestion({ ...args, index: 2, complete: async (m) => { system = m[0]!.content; return '{"question":null}'; } });
  check(/Never ask what the request, the conversation or the facts below already answer/.test(system), "the generator is told not to ask what is known");
  check(/PRODUCT question only/.test(system) && /never a technical one/.test(system) && /one tap accepts it/.test(system), "product questions only; suggestion is one tap");
  const tech = await interviewQuestion({ ...args, index: 2, complete: fake('{"question":"Which framework should the site use?","suggested":"React"}') });
  check(tech === null, "a technical question from the model is refused: stop asking and start");
  const spec = await interviewQuestion({ ...args, index: 3, complete: fake('{"question":"What features should the site have?","suggested":"A menu and our hours"}') });
  check(spec === null, "a feature question from the model is refused: stop asking and start");
  check(/the why or the walls/.test(system) && /Never ask about features/.test(system), "the generator asks only the why and the walls");
  check(/starting point, not a spec/.test(system) && /how much to spend is asked separately/.test(system), "their idea is a starting point; the budget is its own question");
}

generatorChecks()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} failed, ${passes} passed`);
      process.exit(1);
    }
    console.log(`one mode: all ${passes} checks passed`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
