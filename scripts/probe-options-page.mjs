// "All options" (/buzzy/options): a tester said the options are everywhere and asked for one
// page where all of them are listed, with a way to find the one you can't see. This checks it
// in a real browser, signed in, against a built server:
//   A. The page lists every option in public/buzzy/options-data.js, grouped, with its heading.
//   B. Search finds the right options by the words people use:
//        "stretch" → Sketch's Resize / skew…      "resolution" → Canvas size and Resize / skew…
//        "transparent" → Export PNG and Background, which say plainly they are not see-through
//        "undo", "colour" and "color", "voice", "privacy", "key", "delete"
//   C. A search with no match says "Nothing matches — ask BeeZilla in Talk", linking to Talk.
//   D. Esc clears the search; clicking outside it changes nothing (nothing here closes on an
//      outside click).
//   E. Every "Open" link goes to a page the server serves.
//   F. An "Open" link is a soft move (nothing reloads); the settings gear has an All options link.
//   G. At 390px wide there is no sideways scroll and nothing sticks out past the right edge.
//   H. No script errors; a desktop and a phone screenshot are saved.
// usage: node scripts/probe-options-page.mjs [origin]
//   BZ_PROBE_CDP=<DevTools URL>  drive that browser (`ai-screen.sh browser` prints one); unset, a
//                                headless browser with no window is started
//   BZ_PROBE_COOKIE="name=value" a signed-in session; unset, a throwaway account is signed in
//                                through the dev magic-link inbox (BZ_MAIL_LOG, default
//                                .data/outbound-mail.jsonl in the server's folder)
//   BZ_PROBE_SHOTS=<folder>      where the screenshots go (default: a folder in the system temp dir)
// exit 0 = every check passes. exit 1 = at least one failed. exit 2 = the probe could not run.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
const require = createRequire(import.meta.url);

const ORIGIN = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MAIL_LOG = process.env.BZ_MAIL_LOG || ".data/outbound-mail.jsonl";
const SHOTS = process.env.BZ_PROBE_SHOTS || join(tmpdir(), "options-shots");

let failed = 0;
const ok = (what) => console.log(`ok    ${what}`);
const fail = (what, why) => { failed++; console.log(`FAIL  ${what}\n      ${why}`); };
const check = (what, pass, why) => (pass ? ok(what) : fail(what, why));

async function devSignIn() {
  const email = `probe-options-${Date.now().toString(36)}@test.local`;
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

// The list the page should show, read from the same file the page loads.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join("public", "buzzy", "options-data.js"), "utf8"), sandbox);
const OPTIONS = sandbox.window.BZ_OPTIONS || [];
const GROUPS = [...new Set(OPTIONS.map((o) => o.group))];

let browser;
let exitCode = 2;
try {
  const { chromium } = require("playwright");
  const cookie = process.env.BZ_PROBE_COOKIE || (await devSignIn());
  const eq = cookie.indexOf("=");
  browser = process.env.BZ_PROBE_CDP
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
  mkdirSync(SHOTS, { recursive: true });

  const settle = (ms = 500) => page.waitForTimeout(ms);
  const ready = () => page.waitForFunction(
    () => window.BeeZillaShell && document.getElementById("bzChrome") && !window.BeeZillaShell.busy && document.querySelector("#aoList .ao-item"),
    null, { timeout: 25000 });
  const search = async (text) => {
    await page.fill("#aoQ", text);
    await settle(250);
  };
  const names = () => page.$$eval("#aoList .ao-item", (els) => els.map((e) => ({
    name: e.querySelector(".ao-name").textContent,
    group: e.closest(".ao-group").querySelector(".ao-gh").firstChild.textContent,
    what: e.querySelector(".ao-what").textContent,
    href: e.querySelector(".ao-open").getAttribute("href"),
  })));
  // Scroll so the page's own heading sits just under the sticky header: that is what the pictures show.
  const toContent = () => page.evaluate(() => {
    const h = document.querySelector("#bzPage main h1") || document.querySelector("main h1");
    window.scrollTo(0, Math.max(0, h.getBoundingClientRect().top + window.scrollY - (window.innerWidth < 700 ? 135 : 90)));
  });
  const has = (list, name, group) => list.some((x) => x.name === name && (!group || x.group === group));

  // ── A. the whole list ────────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/buzzy/options`, { waitUntil: "load" });
  await ready();
  await settle(800);
  check("the tab is named All options", /All options/.test(await page.title()), `title was "${await page.title()}"`);
  const all = await names();
  check(`the page lists all ${OPTIONS.length} options`, all.length === OPTIONS.length, `${all.length} on the page`);
  const heads = await page.$$eval("#aoList .ao-gh", (els) => els.map((e) => e.firstChild.textContent));
  check(`they are under ${GROUPS.length} group headings, in order`, JSON.stringify(heads) === JSON.stringify(GROUPS), `headings: ${heads.join(" | ")}`);
  check("the count line says how many", /options in \d+ groups/.test(await page.textContent("#aoCount")), await page.textContent("#aoCount"));
  await toContent();
  await page.screenshot({ path: join(SHOTS, "all-options-desktop.png"), fullPage: false });

  // ── B. search ────────────────────────────────────────────────────────────
  await search("stretch");
  let r = await names();
  check("“stretch” finds Sketch's Resize / skew…", has(r, "Resize / skew…", "Sketch"), r.map((x) => x.name).join(" | "));
  await toContent();
  await page.screenshot({ path: join(SHOTS, "all-options-desktop-search.png"), fullPage: false });
  await search("resolution");
  r = await names();
  check("“resolution” finds Canvas size and Resize / skew…", has(r, "Canvas size", "Sketch") && has(r, "Resize / skew…", "Sketch"), r.map((x) => x.name).join(" | "));
  await search("transparent");
  r = await names();
  const png = r.find((x) => x.name === "Export PNG");
  check("“transparent” finds Export PNG and Background", !!png && has(r, "Background", "Sketch"), r.map((x) => x.name).join(" | "));
  check("…and Export PNG says it is not see-through", !!png && /not see-through/.test(png.what), png ? png.what : "no Export PNG");
  await search("see-through");
  r = await names();
  check("“see-through” finds them too", has(r, "Export PNG") && has(r, "Background"), r.map((x) => x.name).join(" | "));
  await search("undo");
  r = await names();
  check("“undo” finds the board's Undo and Sketch's Undo", has(r, "Undo", "Idea Board") && has(r, "Undo", "Sketch"), r.map((x) => `${x.group}: ${x.name}`).join(" | "));
  await search("colour");
  const colour = await names();
  await search("color");
  const color = await names();
  check("“colour” and “color” both find Sketch's colours", has(colour, "Primary and secondary colour", "Sketch") && has(color, "Primary and secondary colour", "Sketch"), `${colour.length} and ${color.length} results`);
  await search("voice");
  r = await names();
  check("“voice” finds Talk to BeeZilla", has(r, "Talk to BeeZilla", "Voice"), r.map((x) => x.name).join(" | "));
  await search("privacy");
  r = await names();
  check("“privacy” finds the privacy modes", ["Open", "Advocate", "Lockdown"].every((n) => has(r, n, "Privacy modes")), r.map((x) => x.name).join(" | "));
  await search("key");
  r = await names();
  check("“key” finds Your AI key", has(r, "Your AI key", "Your AI key"), r.map((x) => x.name).join(" | "));
  await search("delete");
  r = await names();
  check("“delete” finds Sketch's Delete mark and the board's Remove", has(r, "Delete mark", "Sketch") && has(r, "Remove", "Idea Board"), r.map((x) => x.name).join(" | "));
  await search("how do I change the resolution");
  r = await names();
  check("a whole question works (small words are ignored)", has(r, "Canvas size", "Sketch") && has(r, "Resize / skew…", "Sketch"), r.map((x) => x.name).join(" | "));
  await page.selectOption("#aoGroup", "Sketch");
  await search("undo");
  r = await names();
  check("the group menu narrows a search to one group", r.length > 0 && r.every((x) => x.group === "Sketch"), r.map((x) => `${x.group}: ${x.name}`).join(" | "));
  await page.selectOption("#aoGroup", "");

  // ── C. nothing matches ───────────────────────────────────────────────────
  await search("zzzqxv");
  const emptyShown = await page.$eval("#aoEmpty", (e) => !e.hidden && e.getBoundingClientRect().height > 0);
  const emptyText = (await page.textContent("#aoEmpty")).replace(/\s+/g, " ").trim();
  const emptyHref = await page.getAttribute("#aoEmpty a", "href");
  check("no match says Nothing matches — ask BeeZilla in Talk", emptyShown && emptyText === "Nothing matches — ask BeeZilla in Talk", `shown=${emptyShown} text="${emptyText}"`);
  check("…and links to Talk", emptyHref === "/buzzy/talk", `href=${emptyHref}`);
  check("…with no options listed", (await names()).length === 0, "options were still listed");

  // ── D. Esc clears; an outside click changes nothing ──────────────────────
  await search("stretch");
  await page.click("h1");
  await page.mouse.click(40, 600);
  await settle(200);
  check("clicking outside the search leaves it alone", (await page.inputValue("#aoQ")) === "stretch" && (await names()).length > 0, "the search was cleared or closed");
  await page.focus("#aoQ");
  await page.keyboard.press("Escape");
  await settle(250);
  check("Esc clears the search", (await page.inputValue("#aoQ")) === "" && (await names()).length === OPTIONS.length, `value="${await page.inputValue("#aoQ")}"`);
  await search("stretch");
  await page.click("#aoClear");
  await settle(200);
  check("the ✕ clears it too", (await page.inputValue("#aoQ")) === "", "the box still had text");

  // ── E. every Open link goes to a served page ─────────────────────────────
  const hrefs = [...new Set(OPTIONS.map((o) => o.href))];
  const cookieHeader = cookie;
  const bad = [];
  for (const h of hrefs) {
    const res = await fetch(ORIGIN + h, { headers: { cookie: cookieHeader }, redirect: "manual" });
    if (res.status !== 200) bad.push(`${h} → ${res.status}`);
  }
  check(`all ${hrefs.length} pages the Open links go to answer 200`, bad.length === 0, bad.join(", "));
  const noHash = OPTIONS.every((o) => !/[#?]/.test(o.href));
  check("no Open link carries a #hash or ?query", noHash, "one does");

  // ── F. Open is a soft move; the gear has the link ────────────────────────
  await page.evaluate(() => { window.__optProbe = "kept"; });
  await search("stretch");
  const first = page.locator("#aoList .ao-item", { hasText: "Resize / skew…" }).first().locator(".ao-open");
  check("an Open link says where it goes", /Open Sketch/.test((await first.textContent()) || ""), (await first.textContent()) || "no link");
  await first.click();
  await page.waitForFunction(() => window.BeeZillaShell.currentKey === "/buzzy/sketch" && !window.BeeZillaShell.busy, null, { timeout: 20000 });
  check("…and it opens that page without reloading", (await page.evaluate(() => window.__optProbe)) === "kept" && (await page.evaluate(() => location.pathname)) === "/buzzy/sketch", "the document reloaded or stayed put");
  await page.evaluate(() => window.BeeZillaShell.go("/buzzy/talk"));
  await page.waitForFunction(() => window.BeeZillaShell.currentKey === "/buzzy/talk" && !window.BeeZillaShell.busy);
  await settle(600);
  await page.click("#bzGear");
  await page.waitForSelector("#bzSettings:not([hidden])");
  await settle(300);
  await page.locator("#bzSettings").screenshot({ path: join(SHOTS, "settings-gear-panel.png") });
  const gearLink = await page.$$eval('#bzSettings a[href="/buzzy/options"]', (a) => a.map((x) => ({ text: x.textContent, shown: !!(x.offsetWidth || x.offsetHeight) })));
  check("the settings gear has an All options link", gearLink.length === 1 && gearLink[0].text === "All options" && gearLink[0].shown, JSON.stringify(gearLink));
  await page.click('#bzSettings a[href="/buzzy/options"]');
  await page.waitForFunction(() => window.BeeZillaShell.currentKey === "/buzzy/options" && !window.BeeZillaShell.busy && document.querySelector("#aoList .ao-item"), null, { timeout: 20000 });
  check("…and it opens All options without reloading", (await page.evaluate(() => window.__optProbe)) === "kept" && (await page.locator("#aoList .ao-item").count()) === OPTIONS.length, "the document reloaded or the list is missing");
  const gearShut = await page.$eval("#bzSettings", (p) => p.hidden);
  check("…and the settings panel put itself away", gearShut, "the panel is still open");

  // ── G. the phone ─────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}/buzzy/options`, { waitUntil: "load" });
  await ready();
  await settle(800);
  const geometry = () => page.evaluate(() => {
    const de = document.documentElement;
    const over = [];
    for (const el of document.querySelectorAll("#bzPage *")) {
      const rc = el.getBoundingClientRect();
      if (!rc.width || !rc.height) continue;
      if (rc.right > de.clientWidth + 0.5 || rc.left < -0.5) over.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} right=${Math.round(rc.right)}`);
    }
    return { scroll: de.scrollWidth, client: de.clientWidth, over: over.slice(0, 6) };
  });
  let g = await geometry();
  check("at 390px the page does not scroll sideways", g.scroll <= g.client, `scrollWidth ${g.scroll} > ${g.client}`);
  check("…and nothing on the page sticks out past the edge", g.over.length === 0, g.over.join("; "));
  await search("stretch");
  g = await geometry();
  check("…also while a search is showing", g.scroll <= g.client && g.over.length === 0, `scrollWidth ${g.scroll}; ${g.over.join("; ")}`);
  await search("");
  const hint = await page.$eval("#aoQ", (i) => {
    const cs = getComputedStyle(i);
    const c = document.createElement("canvas").getContext("2d");
    c.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    return { room: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), need: c.measureText(i.placeholder).width, text: i.placeholder };
  });
  check("the phone's search hint fits its box", hint.need <= hint.room, `“${hint.text}” needs ${Math.round(hint.need)}px in ${Math.round(hint.room)}px`);
  await toContent();
  await page.screenshot({ path: join(SHOTS, "all-options-phone.png"), fullPage: false });
  await page.fill("#aoQ", "resolution");
  await settle(250);
  await toContent();
  await page.screenshot({ path: join(SHOTS, "all-options-phone-search.png"), fullPage: false });

  // ── H. no errors ─────────────────────────────────────────────────────────
  check("no script errors", errors.length === 0, errors.join(" | "));
  console.log(`\nscreenshots: ${SHOTS}`);
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`the probe could not run: ${e && e.message ? e.message : e}`);
  exitCode = 2;
} finally {
  try { if (browser) await browser.close(); } catch { /* the browser may already be gone */ }
}
console.log(exitCode === 0 ? "\nPROBE PASS" : exitCode === 1 ? `\nPROBE FAIL (${failed})` : "\nPROBE DID NOT RUN");
process.exit(exitCode);
