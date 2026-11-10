// BZ-13 gate: opening Sketch must create nothing; the first stroke must create
// exactly one board. Counts real POSTs to /api/buzzy/jobs from the page.
// usage: node probe-sketch.mjs [origin]
import { createRequire } from "node:module";
const require = createRequire("/home/gumbyender/agents/agent-relay/node_modules/");
const { chromium } = require("playwright");

const ORIGIN = process.argv[2] || "https://beezilla.net";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
const posts = [];
page.on("request", (r) => {
  if (r.method() === "POST" && /\/api\/buzzy\/jobs(\?|$)/.test(r.url())) posts.push(r.url());
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

await page.goto(`${ORIGIN}/buzzy/sketch`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
const onLoad = posts.length;

// A real first stroke: pick a drawing tool (the board opens in Select, so a drag
// there is a selection, not a mark), then draw.
await page.locator('[data-tool="pen"]').click();
const box = await page.locator("#board").boundingBox();
if (!box) throw new Error("no #board canvas");
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 });
await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(3000);
const afterStroke = posts.length;

await browser.close();
console.log(JSON.stringify({ origin: ORIGIN, onLoad, afterStroke, pageErrors: errors, posts }, null, 2));
const pass = onLoad === 0 && afterStroke === 1;
console.log("VERDICT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
