// BZ-19 gate: opening a job's conversation from the Library, or pressing
// "New job", must NOT reload the document. A document load re-creates the
// recogniser and silently drops a live mic, so this probe starts a real mic
// session first (fake capture device + a spoken WAV), then clicks through and
// asserts: same document, mic still running, 1 navigation entry, 0 page errors.
// usage: node probe-job-open.mjs [origin] [storageState.json] [spoken.wav]
import { createRequire } from "node:module";
const require = createRequire("/home/gumbyender/agents/agent-relay/node_modules/");
const { chromium } = require("playwright");

const ORIGIN = process.argv[2] || "https://beezilla.net";
const STATE = process.argv[3] || "";
const WAV = process.argv[4] || "";

const args = ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
if (WAV) args.push(`--use-file-for-fake-audio-capture=${WAV}`);
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args });
const ctx = await b.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 900 }, ...(STATE ? { storageState: STATE } : {}) });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e.message).slice(0, 160)));

await p.goto(`${ORIGIN}/buzzy/talk`, { waitUntil: "load", timeout: 45000 });
await p.waitForSelector("#bzVoiceMic", { timeout: 25000 });
await p.waitForTimeout(1500);
await p.evaluate(() => { window.__docMark = "bz19-" + Math.random().toString(36).slice(2, 7); });
await p.click("#bzVoiceMic");
await p.waitForTimeout(2500);
const started = await p.evaluate(() => ({ mark: window.__docMark, state: window.BeeZillaVoice && window.BeeZillaVoice.state() }));

await p.click('a[data-nav="library"]');
await p.waitForTimeout(2500);
const onLibrary = await p.evaluate(() => ({ path: location.pathname, mark: window.__docMark, mic: window.BeeZillaVoice && window.BeeZillaVoice.state().mic }));

// Library lands on the documents screen; the job cards live one level back.
const back = await p.$("#docsBackJobs");
if (back) { await back.click(); await p.waitForTimeout(2000); }
const cards = await p.$$(".jobcard[data-id]");
if (!cards.length) throw new Error("no .jobcard[data-id] on Library — sign in with a storageState that owns jobs");
const jobId = await cards[0].getAttribute("data-id");
await cards[0].click();
await p.waitForTimeout(3500);
const afterJob = await p.evaluate(() => ({
  path: location.pathname, search: location.search, mark: window.__docMark,
  mic: window.BeeZillaVoice && window.BeeZillaVoice.state().mic,
  bubbles: document.querySelectorAll(".bubble").length,
  last: (Array.from(document.querySelectorAll(".bubble")).slice(-1)[0] || {}).innerText || "",
  navEntries: performance.getEntriesByType("navigation").length,
  talkApi: typeof window.BeeZillaTalk,
}));

await p.click('a[data-nav="library"]');
await p.waitForTimeout(2000);
const back2 = await p.$("#docsBackJobs");
if (back2) { await back2.click(); await p.waitForTimeout(1500); }
await p.click("#newjob").catch(() => {});
await p.waitForTimeout(2500);
const afterNewJob = await p.evaluate(() => ({ path: location.pathname, mark: window.__docMark, mic: window.BeeZillaVoice && window.BeeZillaVoice.state().mic }));

// BZ-16: the recent-work panel on Talk is the most reachable hard-load site —
// no Library hop needed. Clicking a job row there must open the job in place.
await p.waitForSelector(".rw-item", { timeout: 20000 }).catch(() => {});
const rwRows = [];
for (const r of await p.$$(".rw-item")) if (await r.$(".rw-tools")) rwRows.push(r);
let afterRw = null;
if (rwRows.length) {
  await rwRows[0].click();
  await p.waitForTimeout(3000);
  afterRw = await p.evaluate(() => ({
    path: location.pathname, mark: window.__docMark,
    mic: window.BeeZillaVoice && window.BeeZillaVoice.state().mic,
    navEntries: performance.getEntriesByType("navigation").length,
  }));
}

await b.close();
console.log(JSON.stringify({ origin: ORIGIN, jobId, started, onLibrary, afterJob, afterNewJob, afterRw, pageErrors: errs }, null, 2));
const sameDoc = started.mark === onLibrary.mark && onLibrary.mark === afterJob.mark && afterJob.mark === afterNewJob.mark &&
  (!afterRw || afterRw.mark === started.mark);
const pass = started.state && started.state.mic === true &&
  onLibrary.path === "/buzzy/library" && onLibrary.mic === true &&
  afterJob.path === "/buzzy/talk" && afterJob.mic === true &&
  afterNewJob.path === "/buzzy/talk" && afterNewJob.mic === true &&
  (!afterRw || (afterRw.path === "/buzzy/talk" && afterRw.mic === true && afterRw.navEntries === 1)) &&
  sameDoc && afterJob.navEntries === 1 && errs.length === 0;
console.log("same document:", sameDoc, "| nav entries:", afterJob && afterJob.navEntries);
console.log("VERDICT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
