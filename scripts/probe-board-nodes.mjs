// The Idea Board's nodes, in a real browser, signed in, on a production build
// (owner, 21 Nov 2026: "you should be able to add a node and connect nodes. But add a node
// under more for API use and add another one for browser use. And you should be able to
// record yourself using the browser… via a non-residential IP, so you can see it as the AI
// would see it").
//
//   A. add a node and connect nodes: a note and a skill, joined by a line; the editor stays
//      open on a click outside it and keeps what was typed (nothing closes on an outside click)
//   B. More: opens beside the tools; stays open on an outside click; closes with Esc, its
//      Close, or a choice; M opens it
//   C. API use: set up, Try it (the answer, a key kept out), joined to a step, saved to the
//      account without the key
//   D. Browser use: Record in a server browser, steps in words, a password never written down,
//      Watch it run, closing closes the browser, the time is counted
//   E. refusals: not signed in, from another site, in Lockdown
//
// usage: node scripts/probe-board-nodes.mjs [origin]      (BZ_PROBE_CDP=<DevTools URL> to reuse a browser)
// The server needs: BZ_BROWSER_PROVIDER=cdp BZ_BROWSER_CDP_URL=<another browser's DevTools URL>
//   (the server browser; without it part D is skipped), BZ_BROWSER_ALLOW_PRIVATE=1 (its pages are on
//   127.0.0.1) and BZ_API_NODE_ALLOW_PRIVATE=1 (the probe calls an API on 127.0.0.1). Signed-in pages need a session: BZ_PROBE_COOKIE="name=value", or
//   leave it unset against a local server and the probe signs a throwaway account in through the
//   dev magic-link inbox (BZ_MAIL_LOG, default .data/outbound-mail.jsonl in the server's folder).
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";

async function devSignIn() {
  const email = `probe-nodes-${Date.now().toString(36)}@test.local`;
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
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failures++;
}

// An API of our own, and a small site for the server browser to record on (a local
// server browser can reach 127.0.0.1; a cloud one could not, so this probe is for local runs).
const SECRET = "SECRETKEY987654";
const api = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname === "/weather") {
    res.end(JSON.stringify({ city: u.searchParams.get("city") || "Paris", tempC: 18, keySeen: u.searchParams.get("api_key") === SECRET }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
}).listen(0, "127.0.0.1");
const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url === "/two") { res.end("<!doctype html><title>Second page</title><h1>Second page</h1>"); return; }
  res.end(`<!doctype html><meta charset=utf-8><title>Library desk</title>
<style>body{margin:0;font:18px system-ui}.a{position:absolute}</style>
<h1 class=a style="left:20px;top:10px;margin:0">Library desk</h1>
<label class=a for=nm style="left:20px;top:140px">Your name</label>
<input class=a id=nm name=nm style="left:20px;top:170px;width:300px;height:30px">
<label class=a for=pw style="left:20px;top:220px">Password</label>
<input class=a id=pw type=password style="left:20px;top:250px;width:300px;height:30px">
<button class=a id=go style="left:20px;top:330px;width:200px;height:40px" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('nm').value">Say hello</button>
<p class=a id=out style="left:20px;top:390px;margin:0">…</p>`);
}).listen(0, "127.0.0.1");
await Promise.all([api, site].map((s) => new Promise((r) => s.once("listening", r))));
const apiBase = `http://127.0.0.1:${api.address().port}`;
const siteBase = `http://127.0.0.1:${site.address().port}`;

const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
const eqAt = cookie.indexOf("=");
const browser = process.env.BZ_PROBE_CDP
  ? await chromium.connectOverCDP(process.env.BZ_PROBE_CDP)
  : await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{
  name: cookie.slice(0, eqAt), value: cookie.slice(eqAt + 1),
  domain: new URL(ORIGIN).hostname, path: "/", httpOnly: true, secure: ORIGIN.startsWith("https:"), sameSite: "Lax",
}]);
const page = await context.newPage();
await page.route(/openpanel\.dev/, (r) => r.abort()); // a probe is not a visit
page.on("pageerror", (e) => { console.log("page error:", String(e).slice(0, 200)); failures++; });

const authHeaders = { cookie, "content-type": "application/json", origin: ORIGIN };
const info = await (await fetch(`${ORIGIN}/api/buzzy/nodes/browser`, { headers: authHeaders })).json();
const browserOn = info.configured === true;
if (!browserOn) console.log("note: the server browser isn't set up on this server, so part D is skipped");

await page.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#chatInput");
// Open the board the way a person does: press into the Talk box.
await page.evaluate(() => document.getElementById("chatInput").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await page.waitForFunction(() => window.BeeZillaWhiteboard && window.BeeZillaWhiteboard.current());
await page.waitForTimeout(500);
const canvasBox = await page.locator(".wb-canvas").boundingBox();
const instructions = () => page.evaluate(() => window.BeeZillaWhiteboard.current().instructions());
const cardBox = (sel) => page.locator(sel).first().boundingBox();

// ── A. add a node and connect nodes ───────────────────────────────────────
console.log("\nA. Adding and connecting nodes");
await page.locator('.wb-tool[data-tool="note"]').click();
await page.mouse.click(canvasBox.x + 220, canvasBox.y + 140);
await page.waitForSelector(".wb-editor");
await page.locator(".wb-editor .wb-ed-title").fill("Parameters");
await page.locator(".wb-editor .wb-ed-body").fill("city = Paris");
await page.mouse.click(canvasBox.x + 600, canvasBox.y + 420);          // a click on the empty board
await page.waitForTimeout(250);
check("the editor stays open on a click outside it", await page.locator(".wb-editor").count() === 1);
check("…and keeps what was typed", await page.locator(".wb-editor .wb-ed-body").inputValue() === "city = Paris");
await page.locator(".wb-editor button[type=submit]").click();
await page.locator('.wb-tool[data-tool="skill"]').click();
await page.mouse.click(canvasBox.x + 900, canvasBox.y + 140);
await page.waitForSelector(".wb-editor");
await page.locator(".wb-editor .wb-ed-title").fill("Look up weather");
await page.locator(".wb-editor .wb-ed-body").fill("Find the weather for the city");
await page.locator(".wb-editor button[type=submit]").click();
await page.waitForTimeout(250);
check("a note and a skill are on the board", await page.locator('.wb-card[aria-label^="Note"]').count() === 1 && await page.locator('.wb-card[aria-label^="Skill"]').count() === 1);
async function connect(fromSel, toSel) {
  const dot = await page.locator(`${fromSel} .wb-port`).first().boundingBox();
  const to = await cardBox(toSel);
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
await connect('.wb-card[aria-label^="Note"]', '.wb-card[aria-label^="Skill"]');
check("dragging a card's dot onto another joins them, and BeeZilla is told", /Into the step “Look up weather”:\n- Note — Parameters: city = Paris/.test(await instructions()), await instructions());

// ── B. More ───────────────────────────────────────────────────────────────
console.log("\nB. More");
await page.locator(".wb-more-btn").click();
check("More opens a list beside the tools", await page.locator(".wb-more").isVisible());
const items = await page.locator(".wb-more-item strong").allInnerTexts();
check("the list holds API use and Browser use", items.join() === "API use,Browser use", items.join());
await page.mouse.click(canvasBox.x + 600, canvasBox.y + 450);
check("a click outside does not close it", await page.locator(".wb-more").isVisible());
await page.keyboard.press("Escape");
check("Esc closes it", !(await page.locator(".wb-more").isVisible()));
await page.locator(".wb-more-btn").click();
await page.locator(".wb-more-x").click();
check("its Close closes it", !(await page.locator(".wb-more").isVisible()));
await page.locator("body").click({ position: { x: 5, y: 5 } });
await page.locator(".wb-canvas").focus();
await page.keyboard.press("m");
check("the M key opens it", await page.locator(".wb-more").isVisible());
await page.keyboard.press("Escape");
check("the tool is named for a screen reader", /More nodes/.test(await page.locator(".wb-more-btn").getAttribute("aria-label")));

// ── C. API use ────────────────────────────────────────────────────────────
console.log("\nC. API use");
await page.locator(".wb-more-btn").click();
await page.locator('.wb-more-item[data-node="api"]').click();
await page.waitForSelector(".wb-nwin-api");
check("choosing API use adds a card and opens its window", await page.locator('.wb-card.wb-k-api').count() === 1 && await page.locator(".wb-nwin-api").isVisible());
check("the More list closes on a choice", !(await page.locator(".wb-more").isVisible()));
await page.locator(".wb-nwin-api .wb-nf-input").first().fill("Weather lookup");
await page.locator(".wb-nwin-api .wb-nf-url").fill(`${apiBase}/weather?city=Paris&api_key=${SECRET}`);
await page.locator(".wb-nwin-api .wb-nf-url").blur();
await page.waitForTimeout(300);
check("a key typed into the address moves to Keys", await page.locator(".wb-nwin-api .wb-nf-keyrow").count() === 1 && !(await page.locator(".wb-nwin-api .wb-nf-url").inputValue()).includes(SECRET));
await page.locator(".wb-nwin-api .wb-nf-try").click();
await page.waitForSelector(".wb-nwin-api .wb-nres-pre");
const answer = await page.locator(".wb-nwin-api .wb-nres-pre").innerText();
check("Try it shows what came back, from the server", /"city": "Paris"/.test(answer) && /"tempC": 18/.test(answer), answer);
check("…and the key was used for the call", /"keySeen": true/.test(answer), answer);
await page.waitForTimeout(700);
const apiCard = await page.locator(".wb-card.wb-k-api").innerText();
check("the card says it was answered", /Answered 200/.test(apiCard) && /Needs a key: api_key/.test(apiCard), apiCard);
await page.mouse.click(canvasBox.x + 400, canvasBox.y + 430);         // outside the window
check("the window stays open on a click outside it", await page.locator(".wb-nwin-api").isVisible());
await page.locator(".wb-nwin-api .wb-nwin-x").click();
check("its Close closes it", await page.locator(".wb-nwin").count() === 0);
await connect(".wb-card.wb-k-api", '.wb-card[aria-label^="Skill"]');
const told = await instructions();
check("joined to a step, BeeZilla is told the API in words, with its last answer", /Into the step “Look up weather”:/.test(told) && /API the owner set up — Weather lookup: GET http:\/\/127\.0\.0\.1:\d+\/weather\?city=Paris&api_key=\./.test(told) && /tempC/.test(told), told);
check("BeeZilla is never handed the key", !told.includes(SECRET));
await page.waitForTimeout(2200);                                      // the board saves to the account
const saved = await (await fetch(`${ORIGIN}/api/buzzy/whiteboards/talk`, { headers: authHeaders })).text();
check("the board is saved to the account with the node", /"kind":"api"/.test(saved) && /weather/.test(saved));
check("…and the key is nowhere in it", !saved.includes(SECRET), "the key reached the account");
check("…nor in this browser's copy", !(await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join("\n"))).includes("SECRETKEY"));
await page.screenshot({ path: process.env.BZ_PROBE_SHOTS ? `${process.env.BZ_PROBE_SHOTS}/api-node.png` : undefined }).catch(() => {});

// ── D. Browser use ────────────────────────────────────────────────────────
if (browserOn) {
  console.log("\nD. Browser use");
  await page.locator(".wb-more-btn").click();
  await page.locator('.wb-more-item[data-node="browser"]').click();
  await page.waitForSelector(".wb-nwin-browser");
  check("choosing Browser use adds a card and opens its window", await page.locator(".wb-card.wb-k-browser").count() === 1);
  const intro = await page.locator(".wb-nw-where").innerText();
  check("before anything starts it says the browser is on a server, not this computer", /on a server, not on this computer/.test(intro), intro);
  const win0 = await page.locator(".wb-nwin-browser").boundingBox();
  check("the window is big enough to use a page in (picture at least 600 px wide)", win0.width >= 760, String(win0.width));
  await page.locator(".wb-nw-rec").click();
  await page.waitForFunction(() => { const c = document.querySelector(".wb-nw-canvas"); return c && getComputedStyle(c).visibility === "visible"; }, null, { timeout: 40000 });
  const whereText = await page.locator(".wb-nw-where").innerText();
  check("once it is open it says where it goes out from", /seen from \d|goes out from \d/.test(whereText) || /Checking|could not be checked/.test(whereText), whereText);
  await page.locator(".wb-nw-addr").fill(siteBase + "/");
  await page.locator(".wb-nw-go").click();
  await page.waitForFunction(() => /127\.0\.0\.1/.test(document.querySelector(".wb-nw-addr").value), null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  const box = await page.locator(".wb-nw-canvas").boundingBox();
  const at = (x, y) => [box.x + x * box.width / 1280, box.y + y * box.height / 800];
  const picture = await page.evaluate(() => { const c = document.querySelector(".wb-nw-canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] > 200 && d[i + 1] > 200) lit++; return lit; });
  check("the page is drawn (the white page is in the picture)", picture > 200, String(picture));
  await page.mouse.click(...at(100, 185));                            // the name box
  await page.keyboard.type("Ada", { delay: 30 });
  await page.mouse.click(...at(100, 265));                            // the password box
  await page.keyboard.type("hunter22", { delay: 30 });
  await page.mouse.click(...at(100, 350));                            // Say hello
  await page.waitForTimeout(1500);
  const steps = await page.locator(".wb-nw-step").allInnerTexts();
  const flat = steps.map((t) => t.replace(/\s+/g, " ")).join(" | ");
  check("every move is a step in words", steps.length === 4 && /Go to 127\.0\.0\.1/.test(flat) && /Type into “Your name” “Ada”/.test(flat) && /Click the button “Say hello”/.test(flat), flat);
  check("a password is a step, passed on, never written down", /Type your own password or code into “Password” \(not recorded\)/.test(flat) && !flat.includes("hunter22"), flat);
  await page.locator(".wb-nw-rec").click();                           // Stop recording
  await page.waitForTimeout(700);
  const bCard = await page.locator(".wb-card.wb-k-browser").innerText();
  check("the card shows what was recorded", /4 steps recorded/.test(bCard), bCard);
  await page.locator(".wb-nw-play").click();
  await page.waitForSelector(".wb-nw-runok, .wb-nw-runbad", { timeout: 45000 });
  const run = await page.locator(".wb-nw-run").innerText();
  check("Watch it run plays the steps and lands where it did, with the typed name", /It worked/.test(run) && /Hello Ada/.test(run), run);
  check("…and says a password was left for the person", /left for you|enter this yourself/.test(run + (await page.locator(".wb-nw-steps").innerText())), run);
  const win1 = await page.locator(".wb-nwin-browser").boundingBox();
  // Resize by the left edge.
  const edge = await page.locator(".wb-nwin-browser .wb-rs-l").boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 120, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  const win2 = await page.locator(".wb-nwin-browser").boundingBox();
  check("the window resizes by its left edge", win2.width < win1.width - 80, `${win1.width} → ${win2.width}`);
  await page.locator(".wb-nwin-browser .wb-nwin-x").click();
  await page.waitForTimeout(900);
  const after = await (await fetch(`${ORIGIN}/api/buzzy/nodes/browser`, { headers: authHeaders })).json();
  check("closing the window closes the server browser", after.open === null, JSON.stringify(after));
  check("the seconds it was open are counted against the plan", after.secondsLeft < info.secondsLeft, `${info.secondsLeft} → ${after.secondsLeft}`);
  await connect(".wb-card.wb-k-browser", '.wb-card[aria-label^="Skill"]');
  const told2 = await instructions();
  check("joined to a step, BeeZilla is told the steps, in words", /Browser job the owner recorded/.test(told2) && /Type “Ada” into “Your name”/.test(told2) && /Click the button “Say hello”/.test(told2), told2);
  check("…with the password step as the person's own", /Type your own password or code into “Password”/.test(told2) && !told2.includes("hunter22"));
  check("…and how the last play went", /Last played .*it worked/.test(told2), told2);
  await page.waitForTimeout(2200);
  const saved2 = await (await fetch(`${ORIGIN}/api/buzzy/whiteboards/talk`, { headers: authHeaders })).text();
  check("the recording is saved to the account, without the password", /"kind":"browser"/.test(saved2) && /Ada/.test(saved2) && !saved2.includes("hunter22"));
  // Opened again: the saved recording shows at once, and Watch it run opens a browser by itself.
  await page.locator(".wb-card.wb-k-browser .wb-nd-btn").click();
  await page.waitForSelector(".wb-nwin-browser");
  check("opened again, the recording is still there", (await page.locator(".wb-nw-step").count()) === 4);
  await page.locator(".wb-nw-play").click();
  await page.waitForSelector(".wb-nw-runok, .wb-nw-runbad", { timeout: 60000 });
  check("Watch it run works from a closed browser too", /It worked/.test(await page.locator(".wb-nw-run").innerText()));
  await page.keyboard.press("Escape");                                // focus is in the window, not the page
  await page.waitForTimeout(300);
  await page.locator(".wb-nwin-browser .wb-nwin-name").focus();
  await page.keyboard.press("Escape");
  check("Esc closes it", await page.locator(".wb-nwin").count() === 0);
  await page.waitForTimeout(800);
  const after2 = await (await fetch(`${ORIGIN}/api/buzzy/nodes/browser`, { headers: authHeaders })).json();
  check("…and the browser with it", after2.open === null);
}

// ── E. refusals ───────────────────────────────────────────────────────────
console.log("\nE. Refusals");
const post = (headers, url = `${ORIGIN}/api/buzzy/nodes/api-call`) => fetch(url, { method: "POST", headers, body: JSON.stringify({ url: apiBase + "/weather" }) });
check("not signed in: no call", (await post({ "content-type": "application/json", origin: ORIGIN })).status === 401);
check("from another site: no call", (await post({ ...authHeaders, origin: "https://evil.example" })).status === 403);
await fetch(`${ORIGIN}/api/buzzy/privacy`, { method: "PUT", headers: authHeaders, body: JSON.stringify({ mode: "lockdown" }) });
const lockCall = await post(authHeaders);
check("Lockdown: no API call", lockCall.status === 403 && /Lockdown/.test((await lockCall.json()).error));
const lockOpen = await fetch(`${ORIGIN}/api/buzzy/nodes/browser`, { method: "POST", headers: authHeaders, body: "{}" });
check("Lockdown: no browser", lockOpen.status === 403 || lockOpen.status === 503);
await fetch(`${ORIGIN}/api/buzzy/privacy`, { method: "PUT", headers: authHeaders, body: JSON.stringify({ mode: "open" }) });
const stranger = await fetch(`${ORIGIN}/api/buzzy/nodes/browser/${"0".repeat(32)}/stream`, { headers: authHeaders });
check("a browser that isn't yours (or isn't there) can't be reached", stranger.status === 404);

await context.close();
if (!process.env.BZ_PROBE_CDP) await browser.close();
api.close();
site.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
console.log("VERDICT:", failures ? "FAIL" : "PASS");
process.exit(failures ? 1 : 0);
