#!/usr/bin/env node
/**
 * Browser pass for the BeeZilla sign-in page: does the browser save the password?
 *
 * People said BeeZilla never remembered their password. This drives the real
 * page (public/buzzy/login.html) in Chrome against a stand-in auth server and
 * reads Chrome's own password-manager log (chrome://password-manager-internals)
 * to prove Chrome offers to save the password on every way in:
 *   1. the page checks the password by itself 2 s after typing stops;
 *   2. the person presses Log in;
 *   3. the person sets a password after an emailed sign-in link.
 * It also proves that a password manager filling the form gets the person in:
 *   4. it writes the same email again along with the password (this used to
 *      send the page back to the email step and wipe the password);
 *   5. it filled the password before Next was pressed.
 * And that the page sends the form (a real submit event) before it leaves, which
 * is what Safari and the password-manager add-ons wait for.
 *
 *   node scripts/browser-login-password-save.mjs
 *
 * Needs a full Chrome or Chromium; the headless shell has no password manager.
 * Uses CHROME_BIN, else Playwright's Chromium (npx playwright install chromium),
 * else google-chrome / chromium on PATH. Runs headless with a throwaway profile.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = process.env.BZ_PUBLIC_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const KNOWN = "known@example.com";
const RIGHT = "right-password-1";
const NEW_PERSON = "new@example.com";
const NEW_PASSWORD = "brand-new-pass-7";

// ── a stand-in for the auth server: just enough for the page ──────────────
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}
const SESSION = "bz_check_session=1; Path=/; HttpOnly; SameSite=Lax";

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const signedIn = /(?:^|;\s*)bz_check_session=1/.test(req.headers.cookie || "");
  try {
    switch (url.pathname) {
      case "/api/auth/email-first/lookup": {
        const { email } = await body(req);
        return json(res, 200, { exists: email === KNOWN, hasPassword: email === KNOWN });
      }
      case "/api/auth/sign-in/email": {
        const { email, password } = await body(req);
        if (email === KNOWN && password === RIGHT) return json(res, 200, { user: { email } }, { "set-cookie": SESSION });
        return json(res, 401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
      }
      case "/api/auth/get-session":
        return json(res, 200, signedIn ? { session: { id: "s1" }, user: { email: NEW_PERSON } } : null);
      case "/api/auth/email-first/status":
        return signedIn ? json(res, 200, { hasPassword: false, canReplace: true }) : json(res, 401, {});
      case "/api/auth/email-first/set-password":
        return signedIn ? json(res, 200, { status: true, replaced: false }) : json(res, 401, {});
      case "/check/emailed-link":
        // Stands in for opening the emailed link: signs in, lands on "set a password".
        res.writeHead(302, { location: "/buzzy/login.html?step=password", "set-cookie": SESSION });
        return res.end();
      case "/buzzy/talk":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>Talk</title><p>Signed in.</p>");
    }
    const path = normalize(decodeURIComponent(url.pathname));
    if (path.includes("..")) { res.writeHead(400); return res.end(); }
    const file = join(root, path);
    const data = await readFile(file);
    const type = file.endsWith(".html") ? "text/html; charset=utf-8"
      : file.endsWith(".js") ? "text/javascript; charset=utf-8"
      : file.endsWith(".css") ? "text/css"
      : file.endsWith(".png") ? "image/png"
      : file.endsWith(".svg") ? "image/svg+xml"
      : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── a full Chrome, headless, with its own throwaway profile ───────────────
function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch { /* not installed for this Playwright version */ }
  const cache = process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "ms-playwright")
    : join(homedir(), ".cache", "ms-playwright");
  const builds = existsSync(cache)
    ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const build of builds) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
    ]) {
      const candidate = join(cache, build, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.platform === "linux" ? "google-chrome" : "chromium";
}

async function startChrome() {
  const profile = await mkdtemp(join(tmpdir(), "bz-login-chrome-"));
  const proc = spawn(chromeBinary(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    // No keychain prompt on macOS; the password store stays inside the profile.
    "--use-mock-keychain",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not open a debug port")), 20000);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.stderr.on("data", (buf) => {
      const m = String(buf).match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  // Chrome only writes the password-manager log while this page is open.
  const internals = await context.newPage();
  await internals.goto("chrome://password-manager-internals/");
  const page = await context.newPage();
  const submits = [];
  page.on("console", (msg) => { if (msg.text().startsWith("SUBMIT ")) submits.push(msg.text()); });
  await page.addInitScript(() => {
    document.addEventListener("submit", (e) => {
      console.log("SUBMIT " + e.target.id + " trusted=" + e.isTrusted);
    }, true);
  });
  return {
    page,
    submits,
    log: () => internals.evaluate(() => document.body.innerText),
    close: async () => {
      await browser.close().catch(() => {});
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// What a password manager does when it fills a field.
function fill(page, selector, value) {
  return page.evaluate(([sel, v]) => {
    const el = document.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selector, value]);
}

async function toPasswordStep(page) {
  await page.goto(`${BASE}/buzzy/login.html`);
  await page.click("#email");
  await page.keyboard.type(KNOWN, { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#password", { state: "visible", timeout: 10000 });
}

const inApp = (page) => page.waitForURL(/\/buzzy\/talk$/, { timeout: 12000 });
const offered = (log) => /Show password prompt/.test(log);

const checks = [
  ["the page checks the password by itself, Chrome offers to save it", async ({ page, submits, log }) => {
    await toPasswordStep(page);
    await page.click("#password");
    await page.keyboard.type(RIGHT, { delay: 30 });
    await inApp(page);
    await page.waitForTimeout(1500);
    if (!offered(await log())) throw new Error("Chrome did not offer to save the password");
    // Enter on the email step, then the page's own send before leaving.
    if (submits.filter((s) => s === "SUBMIT form trusted=true").length < 2) {
      throw new Error(`the page left without sending the form (${submits.join(", ") || "no submit"})`);
    }
  }],
  ["pressing Log in, Chrome offers to save it", async ({ page, log }) => {
    await toPasswordStep(page);
    await page.click("#password");
    await page.keyboard.type(RIGHT, { delay: 30 });
    await page.click("#submit");
    await inApp(page);
    await page.waitForTimeout(1500);
    if (!offered(await log())) throw new Error("Chrome did not offer to save the password");
  }],
  ["setting a password after the emailed link, Chrome offers to save it for that email", async ({ page, log }) => {
    await page.goto(`${BASE}/check/emailed-link`);
    await page.waitForSelector("#newPassword", { state: "visible", timeout: 10000 });
    const saved = await page.inputValue("#setEmail");
    if (saved !== NEW_PERSON) throw new Error(`the form holds "${saved}", not the account's email`);
    await page.click("#newPassword");
    await page.keyboard.type(NEW_PASSWORD, { delay: 30 });
    await page.click("#save");
    await inApp(page);
    await page.waitForTimeout(1500);
    const text = await log();
    if (!offered(text)) throw new Error("Chrome did not offer to save the new password");
    if (!/Username element :\s+username\b/.test(text)) throw new Error("Chrome did not take the email as the username");
  }],
  ["a password manager fills the email again with the password: signed in", async ({ page }) => {
    await toPasswordStep(page);
    await fill(page, "#email", KNOWN);
    await fill(page, "#password", RIGHT);
    await inApp(page);
  }],
  ["a password manager filled the password before Next: signed in", async ({ page }) => {
    await page.goto(`${BASE}/buzzy/login.html`);
    await fill(page, "#email", KNOWN);
    await fill(page, "#password", RIGHT);
    await page.click("#submit");
    await inApp(page);
  }],
];

let failed = 0;
try {
  for (const [name, run] of checks) {
    const chrome = await startChrome();
    try {
      await run(chrome);
      console.log(`✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`✗ ${name}: ${err?.message || err}`);
    } finally {
      await chrome.close();
    }
  }
} finally {
  server.close();
}
if (failed) {
  console.log(`\n${failed} sign-in password check(s) failed.`);
  process.exit(1);
}
console.log("\nThe browser offers to save the password on every way in.");
