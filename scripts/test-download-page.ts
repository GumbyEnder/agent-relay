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

// ── the places row on Talk agrees with the nav (landing-order note on #350) ─
// #350 put Download in today's nav; CR-10 turned that nav into one row of places
// inside #bzPlaces. If Download stays only in NAV_ROW/LINKS the row a visitor
// actually reads on Talk has no installer in it, and the two navs disagree again.
const talk = readFileSync(join(pub, "talk.html"), "utf8");
const placesRow = /<nav class="bz-places"[^>]*>([\s\S]*?)<\/nav>/.exec(talk)?.[1] ?? "";
const placeIds = [...placesRow.matchAll(/data-place="([a-z-]+)"/g)].map((m) => m[1]);
assert(
  placeIds.length > 0,
  "talk.html has no #bzPlaces places row — CR-10's one row of places is gone",
);
assert(
  placeIds.join(",") === "sketch,studio,capabilities,download,wallet,publish",
  `#bzPlaces order (${placeIds.join(",")}) does not match nav.js LINKS / NAV_ROW — the places row and the nav disagree`,
);

// ── the page is a front door, not a signed-in screen ─────────────────────
assert(
  !/window\.location\.replace\("\/buzzy\/landing"\)/.test(page),
  "download.html bounces signed-out visitors to /buzzy/landing; the installer is public",
);

// ── an unknown route must not be served by it ────────────────────────────
assert(!pageList.includes('"download.html"'), "PAGES holds a file name; it holds page names without extensions");

console.log("download page: ok (route, feed-resolved link, no bytes in repo, nav in both lists)");
