#!/usr/bin/env node
// Capture a 1280x800 preview PNG of the dev server (argv[2] -> argv[3]).
// Contract with SandboxInternal.CapturePreviewThumbnail: exit 0 only after the
// PNG is written; the service treats any non-zero exit as a gated skip and does
// not download the file.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const outPng = process.argv[3] || "/tmp/preview-thumbnail.png";
const timeoutMs = Number(process.env.PREVIEW_THUMBNAIL_TIMEOUT_MS || 45000);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // `domcontentloaded`, not `networkidle`: Vite keeps an HMR websocket open, so
  // networkidle never settles and would burn the whole timeout.
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const status = resp?.status() ?? 0;
  await page.waitForTimeout(1000);

  await page.screenshot({ path: outPng, fullPage: false });

  console.log(JSON.stringify({ url, status, screenshot: outPng }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, url, error: String(err?.message || err) }, null, 2));
  // Set the code rather than process.exit() so the `finally` browser teardown
  // always runs (avoids leaking Chromium across repeated capture calls).
  process.exitCode = 1;
} finally {
  await browser.close();
}
