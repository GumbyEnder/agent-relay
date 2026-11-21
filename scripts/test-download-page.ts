/**
 * The /buzzy/download page and the release feed behind it.
 *
 * The download page is the one place a visitor can get the Windows installer, so
 * its failure modes are quiet and expensive:
 *
 *  1. **A page that exists but is not in `PAGES`** — the route answers 404 while
 *     the file sits right there ("form" was listed with no file; this is the
 *     mirror-image mistake).
 *  2. **A hard-coded installer URL.** Asset names carry the version
 *     (`BeeZilla-Setup-<ver>.exe`), so a URL typed into the markup rots on the
 *     next release and the page keeps offering a build nobody can download.
 *     The button must come from `/api/buzzy/desktop-release`, which reads the
 *     same `latest.yml` an installed copy reads.
 *  3. **A second copy of the bytes in the repo.** The installer is a GitHub
 *     release asset; nothing in `public/` may be an executable.
 *  4. **A nav that only some pages get.** The row is written once in
 *     `pages.nitro.ts` and mirrored in `nav.js`; both have to carry the link or
 *     the "one nav" rule quietly stops being true.
 *
 * Run: `npx tsx scripts/test-download-page.ts` (wired into `test:ci`).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const root = join(import.meta.dirname, "..");
const pub = join(root, "public", "buzzy");
const pagePath = join(pub, "download.html");

assert(existsSync(pagePath), "public/buzzy/download.html is missing");
const page = readFileSync(pagePath, "utf8");

// ── registered as a route ────────────────────────────────────────────────
const pagesSrc = readFileSync(join(root, "src", "lib", "buzzy", "pages.nitro.ts"), "utf8");
const pageList = /const PAGES = new Set\(\[([^\]]+)\]\)/.exec(pagesSrc)?.[1] ?? "";
assert(pageList.includes('"download"'), "PAGES does not list download — /buzzy/download would 404");

// ── no hard-coded installer, no bytes in the repo ────────────────────────
assert(
  !/BeeZilla-Setup-\d/.test(page),
  "download.html hard-codes a versioned installer name; resolve it from the release feed instead",
);
assert(page.includes("/api/buzzy/desktop-release"), "download.html does not ask /api/buzzy/desktop-release for the build");
assert(
  !/github\.com\/GumbyEnder\/agent-relay\/releases\/download\/desktop-v/.test(page),
  "download.html pins a desktop-v<version> release URL; those URLs are per-version and go stale",
);
const binaries = readdirSync(pub).filter((f) => /\.(exe|msi|dmg|AppImage|zip)$/i.test(f));
assert(binaries.length === 0, `public/buzzy carries installer bytes: ${binaries.join(", ")}`);

// ── one nav, in both places ──────────────────────────────────────────────
assert(
  /href="\/buzzy\/download" data-nav="download"/.test(pagesSrc),
  "the served nav row (pages.nitro.ts NAV_ROW) has no Download link",
);
const navJs = readFileSync(join(pub, "nav.js"), "utf8");
assert(
  /id: "download",\s*href: "\/buzzy\/download",\s*label: "Download"/.test(navJs),
  "nav.js LINKS has no Download entry — the row and the state engine would disagree",
);

// ── one nav: the places row, NAV_ROW, nav.js LINKS and the raw Talk header ──
// #350 put Download in today's nav; CR-10 turned that nav into one row of places
// inside #bzPlaces. Nobody writes the order down here: it is READ out of the two
// nav sources (NAV_ROW in pages.nitro.ts and LINKS in nav.js) and every hand-
// written copy is held to them. A hard-coded expectation in this file would have
// to be edited in the same breath as the nav, which is exactly how the copies
// drifted apart in the first place.
const navRowSrc = /const NAV_ROW = \[([\s\S]*?)\]\.join\(/.exec(pagesSrc)?.[1] ?? "";
assert(navRowSrc, "pages.nitro.ts no longer builds NAV_ROW as a joined array");
const navRowLinks = [...navRowSrc.matchAll(/href="([^"]+)"\s+data-nav="([a-z-]+)"[^>]*>([^<]*)</g)].map(
  (m) => ({ href: m[1], id: m[2], label: m[3].trim() }),
);
assert(navRowLinks.length >= 6, `NAV_ROW parsed to only ${navRowLinks.length} links`);

const linksSrc = /var LINKS = \[([\s\S]*?)\n  \];/.exec(navJs)?.[1] ?? "";
assert(linksSrc, "nav.js no longer declares LINKS");
const navLinks = [...linksSrc.matchAll(/\{\s*id: "([a-z-]+)",\s*href: "([^"]+)",\s*label: "([^"]+)"([^}]*)\}/g)].map(
  (m) => ({ id: m[1], href: m[2], label: m[3], more: /\bmore:\s*true\b/.test(m[4]) }),
);
assert(navLinks.length === navRowLinks.length, `LINKS has ${navLinks.length} entries, NAV_ROW has ${navRowLinks.length}`);

// The served row and the state engine are the same row, in the same order, with
// the same words — the failure this catches is "Studio" vs "Music studio".
assert(
  navLinks.map((l) => l.id).join(",") === navRowLinks.map((l) => l.id).join(","),
  `NAV_ROW order (${navRowLinks.map((l) => l.id).join(",")}) disagrees with LINKS (${navLinks.map((l) => l.id).join(",")})`,
);
for (const l of navLinks) {
  const row = navRowLinks.find((r) => r.id === l.id)!;
  assert(row.href === l.href, `NAV_ROW href for "${l.id}" is ${row.href}, LINKS says ${l.href}`);
  assert(row.label === l.label, `NAV_ROW label for "${l.id}" is "${row.label}", LINKS says "${l.label}"`);
}

// The places row is the nav's extras: everything after the main places (the ones
// before the first `more: true` entry), in nav order. Download is one of those
// places even though it is not collapsed under "More".
const firstExtra = navLinks.findIndex((l) => l.more);
assert(firstExtra > 0, "nav.js LINKS marks no entry `more: true` — there are no extras to place");
const mainIds = navLinks.slice(0, firstExtra).map((l) => l.id);
const expectedPlaces = navLinks.map((l) => l.id).filter((id) => !mainIds.includes(id))
  // Defensive: LINKS order and NAV_ROW order already agree, but read the row's
  // order from NAV_ROW so this holds even if someone reorders only one of them.
  .sort((a, b) => navRowLinks.findIndex((r) => r.id === a) - navRowLinks.findIndex((r) => r.id === b));

const rawTalk = readFileSync(join(pub, "talk.html"), "utf8");
const placesRow = /<nav class="bz-places"[^>]*>([\s\S]*?)<\/nav>/.exec(rawTalk)?.[1] ?? "";
const placeIds = [...placesRow.matchAll(/data-place="([a-z-]+)"/g)].map((m) => m[1]);
assert(
  placeIds.length > 0,
  "talk.html has no #bzPlaces places row — CR-10's one row of places is gone",
);
assert(
  placeIds.join(",") === expectedPlaces.join(","),
  `#bzPlaces order (${placeIds.join(",")}) does not match the nav's extras (${expectedPlaces.join(",")}) — the places row and the nav disagree`,
);

// The raw file is what /buzzy/talk.html serves directly; the rendered /buzzy/talk
// gets NAV_ROW substituted into the same <nav id="bzNav">. Both are read by real
// people, so the hand-written header must carry the same links in the same order.
const rawNav = /<nav id="bzNav"[^>]*>([\s\S]*?)<\/nav>/.exec(rawTalk)?.[1] ?? "";
const rawNavLinks = [...rawNav.matchAll(/href="([^"]+)"\s+data-nav="([a-z-]+)"[^>]*>([^<]*)</g)].map(
  (m) => ({ href: m[1], id: m[2], label: m[3].trim() }),
);
assert(
  rawNavLinks.map((l) => l.id).join(",") === navRowLinks.map((l) => l.id).join(","),
  `talk.html's hand-written #bzNav (${rawNavLinks.map((l) => l.id).join(",")}) disagrees with NAV_ROW (${navRowLinks.map((l) => l.id).join(",")})`,
);
for (const r of rawNavLinks) {
  const row = navRowLinks.find((n) => n.id === r.id)!;
  assert(row.href === r.href, `talk.html #bzNav href for "${r.id}" is ${r.href}, NAV_ROW says ${row.href}`);
  assert(row.label === r.label, `talk.html #bzNav label for "${r.id}" is "${r.label}", NAV_ROW says "${row.label}"`);
}

// ── the page is a front door, not a signed-in screen ─────────────────────
assert(
  !/window\.location\.replace\("\/buzzy\/landing"\)/.test(page),
  "download.html bounces signed-out visitors to /buzzy/landing; the installer is public",
);

// ── an unknown route must not be served by it ────────────────────────────
assert(!pageList.includes('"download.html"'), "PAGES holds a file name; it holds page names without extensions");

console.log("download page: ok (route, feed-resolved link, no bytes in repo, nav in both lists)");
