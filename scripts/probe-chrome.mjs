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

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("page", 13) + pad("http", 6) + pad("anchors", 9) + pad("sig", 11) + pad("libBlank", 10) + "title");
for (const r of rows) {
  console.log(pad(r.page, 13) + pad(r.status, 6) + pad(r.anchors, 9) + pad(r.sig, 11) + pad(r.libBlank ? "YES" : "no", 10) + r.title);
}
const sigs = [...new Set(rows.map((r) => r.sig + "/" + r.anchors))];
const blanks = rows.filter((r) => r.libBlank).map((r) => r.page);
console.log("\nnav signatures:", sigs.join(" | "));
console.log("library target=_blank on:", blanks.length ? blanks.join(", ") : "none");
const badTitle = rows.filter((r) => !/^BeeZilla — /.test(r.title));
console.log("titles off the shared shape:", badTitle.length ? badTitle.map((r) => `${r.page}=${r.title}`).join(", ") : "none");
const verdict = sigs.length === 1 && blanks.length === 0 && badTitle.length === 0;
console.log("\nVERDICT:", verdict ? "PASS" : "FAIL");
process.exit(verdict ? 0 : 1);
