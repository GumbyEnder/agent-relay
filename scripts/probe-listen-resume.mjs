// Ruling 5 gate: a hard reload must not restart the microphone on a stored
// flag. The persisted intent comes back ARMED — dock label "Resume",
// aria-pressed=false (nothing is listening), and the first gesture starts it.
// usage: node probe-listen-resume.mjs [origin]
import { createRequire } from "node:module";
const require = createRequire("/home/gumbyender/agents/agent-relay/node_modules/");
const { chromium } = require("playwright");

const ORIGIN = process.argv[2] || "https://beezilla.net";
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

// The page refuses a signed-out visitor by redirecting to /buzzy/landing, so the
// stub goes on the CONTEXT before the first navigation. This probe signs a fake
// session in (and answers empty but valid JSON for the read-only panel calls)
// because the assertion is about the mic state machine in the SHIPPED
// talk.html/nav.js, not about account data. Nothing is written.
await ctx.route("**/api/auth/get-session*", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: "probe", name: "Probe", email: "probe@example.invalid" }, session: { id: "probe" } }) }));
await ctx.route("**/api/buzzy/**", (r) =>
  r.request().method() === "GET"
    ? r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    : r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "networkidle" });
if (!page.url().includes("/buzzy/talk")) throw new Error("talk redirected to " + page.url());
// Simulate "the owner started listening earlier": the intent is what persists.
await page.evaluate(() => localStorage.setItem("bz_listen_mode", "1"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const read = async () => page.evaluate(() => {
  const mic = document.getElementById("bzVoiceMic");
  const stop = document.getElementById("bzVoiceStop");
  const btn = document.getElementById("micBtn");
  return {
    dockLabel: mic ? mic.querySelector("span").textContent : null,
    dockPressed: mic ? mic.getAttribute("aria-pressed") : null,
    stopVisible: stop ? stop.style.display !== "none" : null,
    pageMicPressed: btn ? btn.getAttribute("aria-pressed") : null,
    title: document.title,
    state: window.BeeZillaVoice ? window.BeeZillaVoice.state() : null,
  };
});

const afterReload = await read();
// One click anywhere: the armed session starts without a second press.
await page.mouse.click(5, 5);
await page.waitForTimeout(2000);
const afterGesture = await read();

await browser.close();
console.log(JSON.stringify({ origin: ORIGIN, afterReload, afterGesture, pageErrors: errors }, null, 2));
const pass =
  afterReload.dockLabel === "Resume" &&
  afterReload.dockPressed === "false" &&
  afterReload.stopVisible === false &&
  afterReload.state && afterReload.state.mic === false &&
  afterGesture.state && afterGesture.state.mic === true &&
  afterGesture.dockPressed === "true";
console.log("VERDICT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
