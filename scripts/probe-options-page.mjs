// "All options" (/buzzy/options): a tester said the options are everywhere and asked for one
// page where all of them are listed, with a way to find the one you can't see. This checks it
// in a real browser, signed in, against a built server:
//   A. The page lists every option in public/buzzy/options-data.js, grouped, with its heading.
//   B. Search finds the right options by the words people use:
//        "stretch" → Sketch's Resize / skew…      "resolution" → Canvas size and Resize / skew…
//        "transparent" → Export PNG and Background (which says a JPG export is always on white)
//        "undo", "colour" and "color", "voice", "privacy", "key", "delete"
//      A chosen group is searched before "all words" or "closest" is decided: Sketch + "stretch
//      conversation" shows Sketch's closest options although Talk has a full match; a group with
//      nothing says which others have it; both hand-offs between Orchestrate and the Idea Board
//      are found.
//   C. A search with no match says "Nothing matches — ask BeeZilla in Talk", linking to Talk, and
//      says "Nothing matches" in the live region (#aoCount) too, so a screen reader hears it.
//   D. Esc clears the search; clicking outside it changes nothing (nothing here closes on an
//      outside click). With Settings (or Feedback) open, the first Esc closes only that panel and the
//      search keeps its words and the focus; the next Esc, with nothing clicked in between, clears
//      it (on the page opened directly and on the one the settings gear opened in place). Esc from
//      inside Settings still gives the focus back to the gear.
//   E. Every "Open" link goes to a page the server serves.
//   F. An "Open" link is a soft move (nothing reloads); the settings gear has an All options link.
//      Leaving the page takes its window resize listener off again (no detached page kept alive).
//   G. At 390px wide there is no sideways scroll and nothing sticks out past the right edge.
//   H. No script errors; a desktop and a phone screenshot are saved.
//   I. Open, Advocate and Lockdown are drawn in the privacy button's colours (read from privacy.css).
//   J. An option drags onto the Idea Board by its handle, with real mouse drags: the handle has a
//      grab cursor (the card itself does not drag), the header's strip comes up, and dropped there
//      it lands on the board as a note (name, what it does, where it is). The Open link still drags
//      as a link (what lands keeps its address), and the words can be selected with the mouse; a
//      drag of selected words carries the words, not the option's note.
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
// The privacy button's own colours (privacy.css): Open green, Advocate yellow, Lockdown red.
const privacyCss = readFileSync(join("public", "buzzy", "privacy.css"), "utf8");
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
const MODE_RGB = Object.fromEntries(["open", "advocate", "lockdown"].map((m) => {
  const hex = new RegExp(`\\.privacy-btn\\[data-mode="${m}"\\]\\s*\\{\\s*color:\\s*(#[0-9a-f]{6})`, "i").exec(privacyCss)?.[1];
  return [m, hex ? rgbOf(hex) : "?"];
}));

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
  // Which window "resize" listeners the page (its fitHint) adds and takes off again.
  await page.addInitScript(() => {
    const spy = { added: [], removed: [] };
    window.__optResize = spy;
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, fn, ...rest) => { if (type === "resize" && fn && fn.name === "fitHint") spy.added.push(fn); return add(type, fn, ...rest); };
    window.removeEventListener = (type, fn, ...rest) => { if (type === "resize" && fn && fn.name === "fitHint") spy.removed.push(fn); return remove(type, fn, ...rest); };
  });
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
  // The card whose NAME is exactly this (another card's text may mention it: Canvas size says "use Resize / skew…").
  const cardOf = (name) => {
    const exact = new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "$");
    return page.locator("#aoList .ao-item").filter({ has: page.locator(".ao-name", { hasText: exact }) }).first();
  };
  // A panel (Settings, Feedback) stays open while you type in the search: the first Esc closes only
  // that panel, and the search keeps its words and the focus, so the next Esc clears the search
  // with nothing clicked in between.
  const focusedId = () => page.evaluate(() => (document.activeElement && document.activeElement.id) || "");
  const escWithPanel = async (where, panel) => {
    await search("stretch");
    await page.click(panel.opener);
    await page.waitForSelector(panel.open);
    await page.click("#aoQ");                          // back to the search; the panel stays open
    await settle(150);
    const openBefore = !!(await page.$(panel.open));
    await page.keyboard.press("Escape");
    await settle(300);
    const openAfter = !!(await page.$(panel.open));
    const kept = await page.inputValue("#aoQ");
    const focus = await focusedId();
    check(`${where}: Esc with ${panel.name} open closes only ${panel.name}; the search keeps its words and the focus`, openBefore && !openAfter && kept === "stretch" && focus === "aoQ" && (await names()).length > 0, `${panel.name} open before=${openBefore} after=${openAfter}; search="${kept}"; focus on "${focus}"`);
    await page.keyboard.press("Escape");               // nothing clicked in between
    await settle(250);
    check(`${where}: …and the next Esc, with nothing clicked in between, clears the search`, (await page.inputValue("#aoQ")) === "" && (await names()).length === OPTIONS.length, `search="${await page.inputValue("#aoQ")}"; focus on "${await focusedId()}"`);
  };
  const SETTINGS = { name: "Settings", opener: "#bzGear", open: "#bzSettings:not([hidden])" };
  const FEEDBACK = { name: "Feedback", opener: 'button[aria-controls="bzFeedback"]', open: "#bzFeedback.open:not(.min)" };

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
  const bg = r.find((x) => x.name === "Background" && x.group === "Sketch");
  check("…and Background says a JPG export is always on white", !!bg && /JPG export always has a white background/.test(bg.what), bg ? bg.what : "no Background");
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
  check("“delete” finds Sketch's Delete and the board's Remove", has(r, "Delete", "Sketch") && has(r, "Remove", "Idea Board"), r.map((x) => `${x.group}: ${x.name}`).join(" | "));
  await search("how do I change the resolution");
  r = await names();
  check("a whole question works (small words are ignored)", has(r, "Canvas size", "Sketch") && has(r, "Resize / skew…", "Sketch"), r.map((x) => x.name).join(" | "));
  await page.selectOption("#aoGroup", "Sketch");
  await search("undo");
  r = await names();
  check("the group menu narrows a search to one group", r.length > 0 && r.every((x) => x.group === "Sketch"), r.map((x) => `${x.group}: ${x.name}`).join(" | "));
  // The group is searched BEFORE "all the words" or "the closest" is decided. Over all groups,
  // "stretch conversation" has one full match (Talk's Make a box bigger or smaller, the only option
  // with both words); with Sketch chosen that match must not hide Sketch's own closest options.
  // (The first example, "stretch the board", no longer shows it: Sketch's Resize / skew… now says
  // "click the board", so Sketch has a full match of its own.)
  await page.selectOption("#aoGroup", "");
  await search("stretch conversation");
  r = await names();
  check("“stretch conversation” has a full match over all groups (Talk's Make a box bigger or smaller)", r.length === 1 && has(r, "Make a box bigger or smaller", "Talk"), r.map((x) => `${x.group}: ${x.name}`).join(" | "));
  await page.selectOption("#aoGroup", "Sketch");
  await search("stretch conversation");
  r = await names();
  const sketchLine = await page.textContent("#aoCount");
  check("…with Sketch chosen, Sketch's closest options show instead of nothing", r.length > 0 && r.every((x) => x.group === "Sketch") && has(r, "Resize / skew…", "Sketch") && has(r, "Canvas size", "Sketch"), r.map((x) => `${x.group}: ${x.name}`).join(" | ") || "nothing shown");
  check("…and the line says no option in Sketch has all of those words", /^No option in Sketch has all of those words\. The closest \d+:$/.test(sketchLine), sketchLine);
  await page.selectOption("#aoGroup", "Honey Drops");
  await search("stretch");
  const otherLine = await page.textContent("#aoCount");
  check("a group with nothing says other groups have it", (await names()).length === 0 && /^Nothing in Honey Drops matches, but \d+ other options? (do|does): choose All groups\.$/.test(otherLine), otherLine);
  await page.selectOption("#aoGroup", "");
  await search("orchestrate");
  r = await names();
  check("both hand-offs are listed: Put on the Idea Board (Orchestrate) and Open in Orchestrate (Idea Board)", has(r, "Put on the Idea Board", "Orchestrate") && has(r, "Open in Orchestrate", "Idea Board"), r.map((x) => `${x.group}: ${x.name}`).join(" | "));

  // ── C. nothing matches ───────────────────────────────────────────────────
  await search("zzzqxv");
  const emptyShown = await page.$eval("#aoEmpty", (e) => !e.hidden && e.getBoundingClientRect().height > 0);
  const emptyText = (await page.textContent("#aoEmpty")).replace(/\s+/g, " ").trim();
  const emptyHref = await page.getAttribute("#aoEmpty a", "href");
  check("no match says Nothing matches — ask BeeZilla in Talk", emptyShown && emptyText === "Nothing matches — ask BeeZilla in Talk", `shown=${emptyShown} text="${emptyText}"`);
  check("…and links to Talk", emptyHref === "/buzzy/talk", `href=${emptyHref}`);
  check("…with no options listed", (await names()).length === 0, "options were still listed");
  const liveNo = await page.$eval("#aoCount", (e) => ({ text: e.textContent, role: e.getAttribute("role"), live: e.getAttribute("aria-live") }));
  check("…and the live region (#aoCount) says Nothing matches, so a screen reader hears it", /^Nothing matches “zzzqxv”\.$/.test(liveNo.text) && liveNo.role === "status" && liveNo.live === "polite", JSON.stringify(liveNo));

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
  await escWithPanel("opened directly", SETTINGS);
  await escWithPanel("opened directly", FEEDBACK);
  // Only a box on the page keeps the focus: Esc from inside Settings gives it back to the gear.
  await page.click("#bzGear");
  await page.waitForSelector(SETTINGS.open);
  await settle(150);
  const inPanel = await page.evaluate(() => !!(document.activeElement && document.activeElement.closest("#bzSettings")));
  await page.keyboard.press("Escape");
  await settle(250);
  const backToGear = await page.evaluate(() => ({ shut: document.getElementById("bzSettings").hidden, focus: (document.activeElement && document.activeElement.id) || "" }));
  check("Esc from inside Settings closes it and gives the focus back to the gear", inPanel && backToGear.shut && backToGear.focus === "bzGear", `focus in the panel first=${inPanel}; ${JSON.stringify(backToGear)}`);

  // ── I. the privacy modes in the privacy button's colours ─────────────────
  await search("privacy");
  const modeRows = await page.$$eval("#aoList .ao-item", (els) => els.map((e) => ({
    name: e.querySelector(".ao-name").textContent,
    group: e.closest(".ao-group").querySelector(".ao-gh").firstChild.textContent,
    colour: getComputedStyle(e.querySelector(".ao-name")).color,
  })));
  for (const m of ["Open", "Advocate", "Lockdown"]) {
    const got = modeRows.find((x) => x.name === m && x.group === "Privacy modes");
    check(`${m} is drawn in its mode colour (the privacy button's ${MODE_RGB[m.toLowerCase()]})`, !!got && got.colour === MODE_RGB[m.toLowerCase()], got ? got.colour : "not listed");
  }
  await search("open");
  const libOpen = (await page.$$eval("#aoList .ao-item", (els) => els.map((e) => ({
    name: e.querySelector(".ao-name").textContent,
    group: e.closest(".ao-group").querySelector(".ao-gh").firstChild.textContent,
    colour: getComputedStyle(e.querySelector(".ao-name")).color,
  })))).find((x) => x.name === "Open" && x.group === "Library");
  check("…and only those three: the Library's Open is not green", !!libOpen && libOpen.colour !== MODE_RGB.open, libOpen ? libOpen.colour : "no Library Open");
  await search("privacy");
  await page.locator("#aoList .ao-gh", { hasText: "Privacy modes" }).first().scrollIntoViewIfNeeded();
  await settle(200);
  await page.screenshot({ path: join(SHOTS, "all-options-privacy-modes.png"), fullPage: false });
  await search("");

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
  const first = cardOf("Resize / skew…").locator(".ao-open");
  check("an Open link says where it goes", /Open Sketch/.test((await first.textContent()) || ""), (await first.textContent()) || "no link");
  await first.click();
  await page.waitForFunction(() => window.BeeZillaShell.currentKey === "/buzzy/sketch" && !window.BeeZillaShell.busy, null, { timeout: 20000 });
  check("…and it opens that page without reloading", (await page.evaluate(() => window.__optProbe)) === "kept" && (await page.evaluate(() => location.pathname)) === "/buzzy/sketch", "the document reloaded or stayed put");
  const resizeLeft = () => page.evaluate(() => ({ added: window.__optResize.added.length, left: window.__optResize.added.filter((fn) => window.__optResize.removed.includes(fn)).length }));
  let rz = await resizeLeft();
  check("leaving the page takes its window resize listener off again", rz.added === 1 && rz.left === 1, `${rz.added} added, ${rz.left} taken off`);
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
  await escWithPanel("opened by the gear", SETTINGS);

  // ── J. an option drags onto the Idea Board by its handle ─────────────────
  // Real mouse drags (Playwright drives Chromium's own drag and drop). Only the handle carries the
  // option: the Open link drags as a link, and the words can be selected and dragged as words.
  await search("stretch");
  await page.waitForSelector(".bz-dropstrip", { state: "attached", timeout: 20000 });
  const want = OPTIONS.find((o) => o.group === "Sketch" && o.name === "Resize / skew…");
  const optCard = cardOf("Resize / skew…");
  const looks = await optCard.evaluate((li) => {
    const grip = li.querySelector(".ao-grab");
    return {
      handle: !!grip && grip.draggable === true, handleCursor: grip ? getComputedStyle(grip).cursor : "",
      card: li.draggable, cardPayload: li.hasAttribute("data-bz-card"), cardCursor: getComputedStyle(li).cursor,
    };
  });
  check("an option has a drag handle with a grab cursor; the card itself does not drag", looks.handle && looks.handleCursor === "grab" && looks.card === false && !looks.cardPayload && looks.cardCursor !== "grab", JSON.stringify(looks));
  const notes = () => page.$$eval(".wb-card.wb-k-note", (els) => els.map((n) => (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim()));
  // Every card on every board, as this browser keeps them.
  const boardCards = () => page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("bz.board.")) continue;
      try { (JSON.parse(localStorage.getItem(k)).cards || []).forEach((c) => out.push({ kind: c.kind, title: c.title, url: c.url })); } catch { /* not a board */ }
    }
    return out;
  });
  // Press at `at`, move a little (the drag starts and the header's strip comes up), let go on the strip.
  const dragToStrip = async (at) => {
    if (!at) return false;                             // nothing there to press on
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 24, at.y + 24, { steps: 5 });
    await settle(200);
    const strip = await page.evaluate(() => {
      const s = document.querySelector(".bz-dropstrip");
      const r = s.getBoundingClientRect();
      return { shown: !s.hidden && r.height > 0, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (strip.shown) await page.mouse.move(strip.x, strip.y, { steps: 10 });
    await settle(150);
    await page.mouse.up();
    await settle(1300);
    return strip.shown;
  };
  // A box to press in, or null when the element is not there.
  const boxOf = async (sel) => ((await optCard.locator(sel).count()) ? optCard.locator(sel).first().boundingBox() : null);
  await optCard.scrollIntoViewIfNeeded();
  const hb = await boxOf(".ao-grab");
  check("dragging the handle brings up the header's strip to say where to drop it", await dragToStrip(hb && { x: hb.x + hb.width / 2, y: hb.y + 20 }), hb ? "the drop strip did not show" : "there is no handle");
  const landed = await notes();
  check("dropped on the strip, it lands on the Idea Board as a note: the option's name, what it does and where it is", landed.some((t) => t.includes(want.name) && t.includes(want.what.slice(0, 40)) && t.includes(want.where)), JSON.stringify(landed));
  await page.screenshot({ path: join(SHOTS, "all-options-dropped-on-board.png"), fullPage: false });
  // The Open link drags as a link: what lands keeps its address (the whole card used to drag, and
  // turned the link into the option's note without it).
  const href = await optCard.locator(".ao-open").evaluate((a) => a.href);
  const namedNotes = async () => (await notes()).filter((t) => t.includes(want.where)).length;
  const namedBefore = await namedNotes();
  await optCard.scrollIntoViewIfNeeded();
  const lb = await boxOf(".ao-open");
  await dragToStrip(lb && { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 });
  const linked = (await boardCards()).filter((c) => c.url === href);
  const namedAfter = await namedNotes();
  check("the Open link still drags as a link: it lands on the board with its address, not as the option's note", linked.length >= 1 && linked.every((c) => c.kind !== "note") && namedAfter === namedBefore, `cards with ${href}: ${JSON.stringify(linked)}; option notes ${namedBefore} → ${namedAfter}`);
  // The words can be selected with the mouse (a card that drags as a whole starts a drag instead)…
  await optCard.scrollIntoViewIfNeeded();
  const wb = await boxOf(".ao-what");
  if (wb) {
    await page.mouse.move(wb.x + 3, wb.y + 9);
    await page.mouse.down();
    await page.mouse.move(wb.x + Math.min(wb.width - 8, 260), wb.y + 9, { steps: 8 });
    await page.mouse.up();
  }
  const picked = (await page.evaluate(() => String(window.getSelection()))).trim();
  check("the words on an option can be selected with the mouse", picked.length >= 12 && want.what.includes(picked), `selected “${picked}”`);
  // …and a drag of selected words carries the words, not the option's note. A windowless browser
  // does not start a drag from a press on a selection, so the dragstart is sent as the browser sends
  // it (from the selected text, with its words) and dropped on the strip.
  const wordsDrag = await page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    if (!node) return { node: 0, carried: null };
    const dt = new DataTransfer();
    dt.setData("text/plain", String(sel));
    node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const carried = Array.from(dt.types).includes("application/x-beezilla-card");
    document.querySelector(".bz-dropstrip").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { node: node.nodeType, carried };
  });
  await settle(1300);
  const wordNotes = (await notes()).filter((t) => t.includes(picked) && !t.includes(want.where));
  check("…and a drag of selected words carries the words (not the option's note): they land as a note of their own", wordsDrag.node === 3 && wordsDrag.carried === false && wordNotes.length >= 1, JSON.stringify({ ...wordsDrag, wordNotes }));
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.evaluate(() => window.BeeZillaShell.go("/buzzy/sketch"));
  await page.waitForFunction(() => window.BeeZillaShell.currentKey === "/buzzy/sketch" && !window.BeeZillaShell.busy, null, { timeout: 20000 });
  rz = await resizeLeft();
  check("…and the page opened by the gear takes its resize listener off when you leave it too", rz.added === 2 && rz.left === 2, `${rz.added} added, ${rz.left} taken off`);

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
