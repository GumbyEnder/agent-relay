// Raw-HTML probe of the served BeeZilla chrome. No hydration, no JS: what the
// server ships is what a crawler and a cold browser see first (BZ-11 evidence).
// usage: node probe-chrome.mjs [origin]
const ORIGIN = process.argv[2] || "https://beezilla.net";
const PAGES = [
  "talk", "sketch", "studio", "library", "capabilities", "memory",
  "experts", "recipes", "wallet", "upload", "profile",
];
const crypto = await import("node:crypto");

const rows = [];
for (const p of PAGES) {
  const url = `${ORIGIN}/buzzy/${p}`;
  const res = await fetch(url, { redirect: "follow", headers: { "cache-control": "no-cache" } });
  const html = await res.text();
  // Only anchors inside the nav count. Pages also carry CSS selectors like
  // `#bzNav a[data-nav="sketch"]`, which a naive regex counts as links and has
  // twice made a correct page look like a divergent template.
  const navBlock = (html.match(/<nav id="bzNav"[^>]*>([\s\S]*?)<\/nav>/i) || [, ""])[1];
  const navIds = [...navBlock.matchAll(/<a[^>]*\sdata-nav="([^"]+)"/g)].map((m) => m[1]);
  // drop the duplicates nav.js's LINKS list can add; keep document order
  const uniq = navIds.filter((v, i) => navIds.indexOf(v) === i);
  const sig = crypto.createHash("md5").update(uniq.join(",")).digest("hex").slice(0, 8);
  const libMatch = navBlock.match(/<a[^>]*data-nav="library"[^>]*>/i);
  const lib = libMatch ? libMatch[0] : "(no library anchor)";
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [, "(no title)"])[1];
  const ownHeader = /id="bzHeader"|class="[^"]*page-header/.test(html) && !/id="bzNav"/.test(html);
  rows.push({
    page: p, status: res.status, bytes: html.length, anchors: uniq.length, sig,
    libBlank: /target\s*=\s*["']_blank["']/i.test(lib), lib, title, navId: /id="bzNav"/.test(html),
  });
}

// ---------------------------------------------------------------------------
// Two different questions get asked about `target="_blank"`, and conflating them
// once let a gate claim "0 on 11/11" over a page that ships one.
//   1. NAV ANCHOR (BZ-14): the nav must never open a new tab — a new tab rips the
//      live mic out of the header. That is a defect, and the gate is absolute.
//   2. DOCUMENT/EXTERNAL LINK: opening a produced file (PDF/DOCX/image) or an
//      off-site source URL in a new tab is deliberate. Leaving it in-tab would
//      replace the Library or the conversation with a binary. Allowed, but
//      enumerated here — a new one fails the gate until it is justified in code.
// ---------------------------------------------------------------------------
const ALLOW_BLANK = {
  "public/buzzy/library.html": "Library file grid opens the produced document, not a page route",
  "public/buzzy/chat.js": "chat file card: Open image / Download of a produced asset",
  "public/buzzy/companies.js": "source line links out to the customer's own website",
};
const fs = await import("node:fs/promises");
const path = await import("node:path");
const root = path.resolve(import.meta.dirname, "..");
const blankHits = [];
for (const file of Object.keys(ALLOW_BLANK)) {
  let text;
  try { text = await fs.readFile(path.join(root, file), "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    if (!/_blank/.test(line)) return;
    const window = text.split("\n").slice(Math.max(0, i - 2), i + 3).join("\n");
    blankHits.push({
      file, line: i + 1,
      allowed: ALLOW_BLANK[file],
      noopener: /rel\s*=\s*["']noopener|\.rel\s*=\s*["']noopener/.test(window),
    });
  });
}
const strayBlanks = blankHits.filter((h) => !h.allowed || !h.noopener);
console.log("\ndocument/external _blank (not nav):");
console.log(blankHits.length
  ? blankHits.map((h) => `  ${h.file}:${h.line}  ${h.noopener ? "rel=noopener" : "NO rel=noopener"}  ${h.allowed || "STRAY — not enumerated"}`).join("\n")
  : "  none");

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("page", 13) + pad("http", 6) + pad("anchors", 9) + pad("sig", 11) + pad("libBlank", 10) + "title");
for (const r of rows) {
  console.log(pad(r.page, 13) + pad(r.status, 6) + pad(r.anchors, 9) + pad(r.sig, 11) + pad(r.libBlank ? "YES" : "no", 10) + r.title);
}
const sigs = [...new Set(rows.map((r) => r.sig + "/" + r.anchors))];
const blanks = rows.filter((r) => r.libBlank).map((r) => r.page);
console.log("\nnav signatures:", sigs.join(" | "));
console.log("library NAV ANCHOR target=_blank on:", blanks.length ? blanks.join(", ") : "none (0/11)");
const badTitle = rows.filter((r) => !/^BeeZilla — /.test(r.title));
console.log("titles off the shared shape:", badTitle.length ? badTitle.map((r) => `${r.page}=${r.title}`).join(", ") : "none");
const verdict = sigs.length === 1 && blanks.length === 0 && badTitle.length === 0 && strayBlanks.length === 0;
if (strayBlanks.length) console.log("STRAY _blank (must be enumerated + rel=noopener):", strayBlanks.map((h) => `${h.file}:${h.line}`).join(", "));
console.log("\nGATE: one nav signature, 0 nav-anchor _blank, shared titles, no unenumerated _blank");
console.log("\nVERDICT:", verdict ? "PASS" : "FAIL");
process.exit(verdict ? 0 : 1);
