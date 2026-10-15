/**
 * Browser pass for Check the money, against the Talk page.
 * A wrong amount is caught before approval. A blank price is not filled in.
 * Nothing is sent.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const root = "/home/gumbyender/agents/agent-relay/public";

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    if (path.includes("..")) {
      res.writeHead(400);
      res.end();
      return;
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const pageUrl = `http://127.0.0.1:${port}/buzzy/talk.html`;

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=/tmp/bz-money-chrome-${process.pid}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const debugPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("chrome did not open a debug port")), 15000);
  chrome.stderr.on("data", (buf) => {
    const text = String(buf);
    const found = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (!found) return;
    clearTimeout(timer);
    resolve(Number(found[1]));
  });
  chrome.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`chrome exited ${code}`));
  });
});

const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

let nextId = 0;
function cdp(method, params, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (data.error) reject(new Error(`${method}: ${JSON.stringify(data.error)}`));
      else resolve(data.result);
    };
    ws.addEventListener("message", onMessage);
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}

const created = await cdp("Target.createTarget", { url: "about:blank" });
const attached = await cdp("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sessionId = attached.sessionId;
await cdp("Page.enable", {}, sessionId);
await cdp("Runtime.enable", {}, sessionId);
await cdp("Page.navigate", { url: pageUrl }, sessionId);

async function evaluate(expression) {
  const result = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails));
  }
  return result.result.value;
}

const ready = await (async () => {
  for (let i = 0; i < 40; i++) {
    const state = await evaluate(`({
      check: typeof checkMoney,
      apply: typeof window.bzApplyMoneyCheck,
      companies: !!(window.BZCompanies && BZCompanies.ready && BZCompanies.ready()),
      money: !!document.getElementById("moneyCheck")
    })`);
    if (state && state.check === "function" && state.apply === "function" && state.companies && state.money) return state;
    await new Promise((r) => setTimeout(r, 150));
  }
  return evaluate("document.body ? document.body.innerText.slice(0, 400) : 'no body'");
})();
if (!ready || ready.check !== "function") {
  throw new Error(`page was not ready: ${JSON.stringify(ready)}`);
}

const report = await evaluate(`(() => {
  const invoiceFacts = [
    { key: "parties", value: "From Northwind Glass to Harbor Cafe", status: "proposed", place: "the file invoice.txt", source: "Proposed" },
    { key: "date", value: "March 3, 2026", status: "proposed", place: "the file invoice.txt", source: "Proposed" },
    { key: "amount", value: "$420.00", status: "proposed", place: "the file invoice.txt", source: "Proposed" },
    { key: "asked", value: "Patio door glass", status: "proposed", place: "the file invoice.txt", source: "Proposed" },
    { key: "due", value: "April 2, 2026", status: "proposed", place: "the file invoice.txt", source: "Proposed" }
  ];
  const wrongDraft = "Please pay $999.00 for the glass.";
  window.bzApplyMoneyCheck({ kind: "invoice", facts: invoiceFacts }, {}, wrongDraft);
  const list = document.getElementById("moneyCheck");
  const approve = document.getElementById("approveDraft");
  const confirm = document.getElementById("confirmOutward");
  approve.click();
  document.getElementById("draftSend").click();
  confirm.click();
  const wrong = {
    display: getComputedStyle(list).display,
    hidden: list.classList.contains("hidden"),
    text: list.innerText,
    approveDisabled: approve.disabled,
    confirmDisabled: confirm.disabled,
    meta: document.getElementById("draftMeta").textContent,
    sendNote: document.getElementById("draftSendNote").textContent,
    outward: document.getElementById("outwardNote").textContent,
    body: document.getElementById("draftBody").value
  };

  const quoteFacts = [
    { key: "parties", value: "From South Dock Lumber to Harbor Cafe", status: "proposed", place: "the file quote.txt", source: "Proposed" },
    { key: "date", value: "", status: "unknown", place: "the file quote.txt", source: "Unknown" },
    { key: "amount", value: "", status: "unknown", place: "the file quote.txt", source: "Unknown" },
    { key: "asked", value: "Cedar boards", status: "proposed", place: "the file quote.txt", source: "Proposed" },
    { key: "due", value: "", status: "unknown", place: "the file quote.txt", source: "Unknown" }
  ];
  const blankDraft = "South Dock Lumber — the quote is attached.";
  window.bzApplyMoneyCheck({ kind: "quote", facts: quoteFacts }, {}, blankDraft);
  const list2 = document.getElementById("moneyCheck");
  const approve2 = document.getElementById("approveDraft");
  const before = document.getElementById("draftBody").value;
  approve2.click();
  document.getElementById("draftSend").click();
  const sendNote = document.getElementById("draftSendNote").textContent;
  document.getElementById("confirmOutward").click();
  return {
    wrong: wrong,
    blank: {
      display: getComputedStyle(list2).display,
      text: list2.innerText,
      approveDisabled: approve2.disabled,
      meta: document.getElementById("draftMeta").textContent,
      sendNote: sendNote,
      outward: document.getElementById("outwardNote").textContent,
      before: before,
      after: document.getElementById("draftBody").value
    }
  };
})()`);

function fail(message) {
  console.error(message);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

if (report.wrong.display === "none" || report.wrong.display === "flex" || report.wrong.hidden) {
  fail(`money list display was ${report.wrong.display}`);
}
if (!report.wrong.text.includes("$999.00") || !report.wrong.text.includes("$420.00")) fail("wrong amount was not shown");
if (!/approval stays closed/i.test(report.wrong.text)) fail("approval block was not shown");
if (!report.wrong.approveDisabled) fail("approve stayed enabled for a wrong amount");
if (!/not approved/i.test(report.wrong.meta)) fail("a wrong amount was approved");
if (!/nothing left the company/i.test(report.wrong.sendNote)) fail("send did not refuse");
if (/confirmed for version/i.test(report.wrong.outward || "")) fail("confirm send ran");
if (report.wrong.body !== "Please pay $999.00 for the glass.") fail("wrong draft was rewritten");
if (report.wrong.body.includes("420")) fail("the check filled in the paper amount");

if (!report.blank.text.includes("No price was on the quote, so none was written.")) fail("blank price was not named");
if (!report.blank.text.includes("The due date is blank.")) fail("blank due date was not named");
if (report.blank.approveDisabled) fail("a blank the paper never had blocked approval");
if (!/approved/i.test(report.blank.meta) || /not approved/i.test(report.blank.meta)) fail("a matching blank draft could not be approved");
if (!/nothing left the company/i.test(report.blank.sendNote)) fail("send still delivered");
if (!/nothing was emailed or published/i.test(report.blank.outward || "")) fail("confirm claimed a send");
if (report.blank.before !== report.blank.after) fail("approving filled the draft");
if (/\$\s?\d/.test(report.blank.after)) fail("a price was written into the blank draft");

if (process.exitCode) {
  chrome.kill();
  server.close();
  process.exit(process.exitCode);
}

console.log("browser money check ok");
chrome.kill();
server.close();
process.exit(0);
