// One mode, in a real browser, signed in (src/lib/buzzy/oneMode.ts, askOrGo.ts).
//   1. "Build me a website for my bakery": significant and open, so the one quick
//      choice appears, with two buttons.
//   2. "Ask me a few questions": question 1 is "What problem are you trying to
//      solve?" with BeeZilla's suggested answer as a button.
//   2b. Meanwhile, "Also, write me a haiku about bread": the haiku comes back at once
//      and question 1 stays open under it, with its buttons (a pending answer never
//      stalls unrelated work).
//   3. Tap the suggestion: question 2, "What would make you (or your team)
//      incredibly satisfied…".
//   3b. Tap the suggestion: a website goes to agents and no amount was named, so how
//      much to spend comes right after the two openers: three amounts, $50 suggested.
//   4. Tap "$50 — a solid start", then "Just go for it": the work, within $50, with
//      what BeeZilla assumed.
//   5. A new conversation, "Build me a website for my salon": they chose questions
//      for this kind of work last time, so no choice this time, straight to question 1.
//   6. "Just go for it" before answering: only how much to spend; one tap, then the
//      work, no other question. Next time, no questions at all.
//   7. A new conversation, "Build me a website for my gym": it goes, asking only how
//      much to spend.
//   7b. A new conversation, "Build me a website for my gym, keep it under $30": the
//      amount is in their words, so no question at all.
//   8. A new conversation, "Write me a short poem about rain": clear, small and done
//      inside a reply: it just goes, no buttons.
// usage: node scripts/probe-one-mode.mjs <origin>   (BZ_PROBE_CDP=<DevTools URL>, BZ_MAIL_LOG,
//        BZ_PROBE_SHOTS=<folder for screenshots>)
// Needs a chat model behind the server (BZ_CHAT_BASE_URL): steps 2b, 4, 6, 7b and 8 are
// model turns; the choice, the questions and the budget are written by the server itself.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function devSignIn() {
  const email = `probe-onemode-${Date.now().toString(36)}@test.local`;
  const res = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}`);
  for (let i = 0; i < 30; i++) {
    if (existsSync(MAIL_LOG)) {
      for (const line of readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse()) {
        let mail;
        try { mail = JSON.parse(line); } catch { continue; }
        if (mail.to !== email) continue;
        const link = mail.actionUrl || (mail.text || "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
        if (!link) continue;
        const v = await fetch(link.replace(/&amp;/g, "&").replace(/^https?:\/\/[^/]+/, ORIGIN), { redirect: "manual" });
        const cookie = (v.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.includes("session_token"));
        if (cookie) return cookie;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic-link mail for ${email} in ${MAIL_LOG}`);
}

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eq = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await context.addCookies([{
  name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const turns = [];
page.on("response", async (r) => {
  if (!r.url().endsWith("/api/buzzy/chat") || r.request().method() !== "POST") return;
  try {
    const body = JSON.parse(r.request().postData() || "{}");
    turns.push({ message: body.message, choice: body.choice ?? null, execute: body.execute === true });
  } catch { /* not ours */ }
});

const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
// The newest assistant bubble (the thread is newest-first: [you, reply, you, reply…]).
const newestReply = () =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll("#chatMessages .bubble:not(.me)")];
    const b = all[0];
    return b ? b.innerText : "";
  });
const choiceButtons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#chatMessages .bz-choice button")].map((b) => ({
      text: b.innerText.trim(),
      value: b.getAttribute("data-choice"),
      main: !b.classList.contains("secondary"),
    })),
  );
const BUDGET_QUESTION = "How much should I spend on this, at most? I'll keep my work under that amount.";
async function say(text) {
  const before = await page.evaluate(() => document.querySelectorAll("#chatMessages .bubble:not(.me)").length);
  await page.fill("#chatInput", text);
  await page.click("#chatSend");
  await waitForReply(before);
}
async function waitForReply(before) {
  // A reply, or the page's own error line (it gives up on a turn after 120 s, which a
  // slow local model can reach on a long document): either way, say which.
  await page.waitForFunction(
    (n) => {
      const err = document.getElementById("chatError");
      const failed = err && !err.classList.contains("hidden") && err.textContent.trim();
      const replied = document.querySelectorAll("#chatMessages .bubble:not(.me)").length > n;
      return (replied || failed) && !document.getElementById("thinkingIndicator");
    },
    before,
    { timeout: Number(process.env.BZ_PROBE_TURN_MS) || 420000, polling: 500 },
  );
  const err = await page.evaluate(() => {
    const e = document.getElementById("chatError");
    return e && !e.classList.contains("hidden") ? e.textContent.trim() : "";
  });
  if (err) throw new Error(`the page reported: ${err}`);
  await page.waitForTimeout(400);
}
async function press(value, label) {
  const before = await page.evaluate(() => document.querySelectorAll("#chatMessages .bubble:not(.me)").length);
  await page.click(label ? `#chatMessages .bz-choice button[data-send="${label}"]` : `#chatMessages .bz-choice button[data-choice="${value}"]`);
  await waitForReply(before);
}
async function newConversation() {
  await page.evaluate(() => document.getElementById("newSessionBtn")?.click());
  await page.waitForTimeout(800);
}

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const i = document.getElementById("chatInput");
  return i && !i.disabled;
}, null, { timeout: 30000 });
check(!(await page.$("#modeTabs")), "no Chat/Work switch on the page");

// 1. Significant and open: the one quick choice.
await say("Build me a website for my bakery");
let reply = await newestReply();
let buttons = await choiceButtons();
await shot("1-offer");
check(reply.includes("I can ask a few questions before I start, or just go for it — which do you prefer?"), `the quick choice: "${reply.slice(0, 90)}"`);
check(buttons.length === 2 && buttons[0].value === "ask" && buttons[1].value === "go", `two buttons: ${JSON.stringify(buttons)}`);
const note = await page.evaluate(() => document.querySelector("#chatMessages .bz-choice-note")?.textContent || "");
check(note === "Anything else you ask meanwhile goes ahead.", `the waiting turn says what keeps going: "${note}"`);

// 2. Questions: question 1 with a suggested answer.
await press("ask");
reply = await newestReply();
buttons = await choiceButtons();
await shot("2-question-1");
check(reply.startsWith("What problem are you trying to solve?"), `question 1: "${reply.slice(0, 120)}"`);
check(buttons.some((b) => b.value === "accept") && buttons.some((b) => b.value === "go"), `suggestion + just go: ${JSON.stringify(buttons)}`);
check(turns.at(-1)?.choice === "ask", "the press was sent as choice: ask");

// 2b. Something else meanwhile: done now, and question 1 stays open under it.
await say("Also, write me a haiku about bread");
reply = await newestReply();
buttons = await choiceButtons();
await shot("2b-meanwhile");
check(!reply.startsWith("What problem are you trying to solve?") && reply.length > 20, `the other request was done at once (${reply.length} chars)`);
check(/Still open, whenever you're ready: What problem are you trying to solve\?/.test(reply), "question 1 is still open under it");
check(buttons.some((b) => b.value === "accept") && buttons.some((b) => b.value === "go"), `its buttons came along: ${JSON.stringify(buttons)}`);

// 3. One tap takes the suggestion.
if (buttons.some((b) => b.value === "accept")) {
  await press("accept");
  reply = await newestReply();
  await shot("3-question-2");
  check(reply.startsWith("What would make you (or your team) incredibly satisfied with how this turns out?"), `question 2: "${reply.slice(0, 120)}"`);
  check(turns.at(-1)?.choice === "accept", "the tap was sent as choice: accept");
}

// 3b. A website goes to agents: how much to spend, right after the two openers.
await press("accept");
reply = await newestReply();
buttons = await choiceButtons();
await shot("3b-budget");
check(reply.startsWith(BUDGET_QUESTION), `after the openers, the budget: "${reply.slice(0, 90)}"`);
check(!/Suggested:/.test(reply), "the suggestion is its button, not a line in the bubble");
check(
  JSON.stringify(buttons.map((b) => b.text)) === JSON.stringify(["$20 — a quick try", "$50 — a solid start", "$200 — lots of care"]) &&
    buttons.every((b) => b.value === "amount"),
  `three amounts for work for other people: ${JSON.stringify(buttons)}`,
);
check(buttons.filter((b) => b.main).map((b) => b.text).join() === "$50 — a solid start", "the suggested amount is the main button");

// 4. One tap on the amount, then just go: the work, within the amount, and what it assumed.
await press("amount", "$50 — a solid start");
check(turns.at(-1)?.choice === "amount" && turns.at(-1)?.message === "$50 — a solid start", "the tap was sent as their own words");
reply = await newestReply();
await shot("4-after-budget");
check(!reply.startsWith(BUDGET_QUESTION), "the budget is asked once");
if ((await choiceButtons()).some((b) => b.value === "go")) await press("go");
reply = await newestReply();
await shot("4-work");
check(!/I can ask a few questions|What problem are you trying to solve|How much should I spend/.test(reply) && reply.length > 80, `the work came back (${reply.length} chars)`);
check(/What I assumed for you:/i.test(reply), "it lists what it assumed");
check(/\$50/.test(reply), "the work turn was told the amount ($50)");
check((await choiceButtons()).length === 0, "no buttons under the work");

// 5. Same kind of work again: they chose questions last time, so no choice.
await newConversation();
await say("Build me a website for my salon");
reply = await newestReply();
await shot("5-remembered-questions");
check(reply.startsWith("What problem are you trying to solve?"), `asked once: straight to question 1 ("${reply.slice(0, 80)}")`);

// 6. Decline before answering: only how much to spend, then the work. From now on, just go.
await press("go");
reply = await newestReply();
buttons = await choiceButtons();
await shot("6-declined-budget");
check(turns.at(-1)?.execute === true && turns.at(-1)?.choice === "go", "Just go for it was sent as Do it (execute: true)");
check(reply.startsWith(BUDGET_QUESTION) && buttons.length === 3 && buttons.every((b) => b.value === "amount"), "'Just go for it': the one question left is how much to spend");
await press("amount", "$20 — a quick try");
reply = await newestReply();
await shot("6-work");
check(!/How much should I spend|What problem are you trying to solve|I can ask a few questions/.test(reply) && reply.length > 80, `one tap, then the work (${reply.length} chars)`);
check(/\$20/.test(reply) && (await choiceButtons()).length === 0, "the work within $20, no other question");

// 7. They chose "just go" for this kind of work: no choice, no questions, only the budget.
await newConversation();
await say("Build me a website for my gym");
reply = await newestReply();
buttons = await choiceButtons();
await shot("7-remembered-go");
check(!/I can ask a few questions|What problem are you trying to solve/.test(reply), "asked once: no choice and no questions now");
check(reply.startsWith(BUDGET_QUESTION) && buttons.length === 3, "work for agents with no amount: only how much to spend");

// 7b. An amount in their words: no question at all.
await newConversation();
await say("Build me a website for my gym, keep it under $30");
reply = await newestReply();
await shot("7b-amount-in-words");
check(!reply.startsWith(BUDGET_QUESTION) && reply.length > 80 && (await choiceButtons()).length === 0, `an amount in their words: straight to the work (${reply.length} chars)`);
check(/\$30/.test(reply), "the work turn was told the amount ($30)");

// 8. Clear and small: no questions, no buttons.
await newConversation();
await say("Write me a short poem about rain");
reply = await newestReply();
await shot("8-poem");
check(!/I can ask a few questions|What problem are you trying to solve/.test(reply) && reply.length > 20, `small and clear: it just does it ("${reply.slice(0, 60)}")`);
check((await choiceButtons()).length === 0 && !reply.includes(BUDGET_QUESTION), "no buttons and no budget question under a plain answer");

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ""}`);
console.log(failures ? `\n${failures} failed` : "\none mode probe: all checks passed");
if (!process.env.BZ_PROBE_CDP) await browser.close();
process.exit(failures ? 1 : 0);
