#!/usr/bin/env node
/**
 * Lightweight headless load + screenshot for http://127.0.0.1:8080 (or argv URL).
 * Does not try to "play" the app — just proves the page loads and captures a PNG
 * the agent can Read. Exit 0 on success, 1 on navigation failure, 2 if console errors.
 *
 * Screenshots default under /workspace/screenshots/ (never /tmp) so they live on
 * the workspace volume and stay readable by agent tools.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const outPng = process.argv[3] || "/workspace/screenshots/app-builder-preview.png";
const timeoutMs = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS || 45000);

mkdirSync(dirname(outPng), { recursive: true });

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.message || err)));

  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  const status = resp?.status() ?? 0;
  await page.waitForTimeout(1000);

  const title = await page.title();
  const hasCanvas = (await page.locator("canvas").count()) > 0;
  const bodyTextLen = (await page.locator("body").innerText().catch(() => "")).trim().length;

  await page.screenshot({ path: outPng, fullPage: false });

  console.log(
    JSON.stringify(
      {
        url,
        status,
        title,
        hasCanvas,
        bodyTextLen,
        consoleErrors,
        pageErrors,
        screenshot: outPng,
      },
      null,
      2,
    ),
  );

  if (status >= 400 || status === 0) process.exit(1);
  if (pageErrors.length || consoleErrors.length) process.exit(2);
  process.exit(0);
} catch (err) {
  console.error(JSON.stringify({ ok: false, url, error: String(err?.message || err) }, null, 2));
  process.exit(1);
} finally {
  await browser.close();
}
