#!/usr/bin/env node
/**
 * The reader behind Talk's address bar — /api/buzzy/read.
 *
 * Ported to the desktop line for browse.js's reader half (open a typed web address
 * as text). Three things must hold, and each has failed somewhere before:
 *
 *   1. The parser: <title> and the page's links come back absolute, de-duplicated,
 *      http(s) only — a reader with dead or mailto links is worse than none.
 *   2. The guard: a private address (loopback, link-local, RFC1918) is refused by
 *      NAME. The cloud metadata address is the classic SSRF target, and "it's on
 *      localhost" is not a reason to read it.
 *   3. The route: signed-in, it answers {ok, url, title, text, links} for a public
 *      page, and 400 for an address it cannot parse.
 *
 * The live fetch needs egress; it SKIPs rather than failing when there is none, so
 * this test is honest in a sandbox and strict on a machine with a network.
 *
 * Run: npx tsx scripts/test-buzzy-read.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fetchPageText, pageLinks, pageTitle } from "../src/lib/buzzy/webpage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><title>  Ridge &amp; Co —
  Pressure washing </title></head><body>
  <p>We wash driveways in Oviedo.</p>
  <a href="/about">About us</a>
  <a href="/about">About us</a>
  <a href="mailto:hi@example.com">Email</a>
  <a href="https://example.com/x#frag">External</a>
  <a href="  ">Blank</a>
</body></html>`;

// ── 1. parser ───────────────────────────────────────────────────────────────
{
  check("title is decoded and collapsed", pageTitle(HTML) === "Ridge & Co — Pressure washing", JSON.stringify(pageTitle(HTML)));
  check("no <title> is an empty string, not undefined", pageTitle("<p>hi</p>") === "", JSON.stringify(pageTitle("<p>hi</p>")));
  const links = pageLinks(HTML, "https://ridge.example/dir/page");
  check("relative links are made absolute", links.some((l) => l.href === "https://ridge.example/about"), JSON.stringify(links.map((l) => l.href)));
  check("duplicates collapse to one", links.filter((l) => l.href === "https://ridge.example/about").length === 1, String(links.length));
  check("mailto is not a readable link", !links.some((l) => /^mailto:/i.test(l.href)), "no mailto");
  check("the fragment is dropped", links.some((l) => l.href === "https://example.com/x"), JSON.stringify(links.map((l) => l.href)));
  check("a blank href is not a link", links.every((l) => l.href && l.text), "all carry href and text");
}

// ── 2. guard ────────────────────────────────────────────────────────────────
{
  const loop = await fetchPageText("http://127.0.0.1:9/");
  check("loopback is refused by name", loop.ok === false && loop.code === "blocked", JSON.stringify(loop));
  const meta = await fetchPageText("http://169.254.169.254/latest/meta-data/");
  check("the cloud metadata address is refused", meta.ok === false && meta.code === "blocked", JSON.stringify(meta));
  const bad = await fetchPageText("not a url");
  check("a non-URL is a bad_url, not a crash", bad.ok === false && bad.code === "bad_url", JSON.stringify(bad));
}

// ── 3. the route, on the built runtime ──────────────────────────────────────
async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "bz-read-"));
  const child = spawn(process.execPath, [join(ROOT, "scripts", "beezilla-local.mjs")], {
    cwd: ROOT,
    env: { ...process.env, BZ_RUNTIME: "local", BZ_DATA_DIR: dataDir, HOST: "127.0.0.1", BZ_BRAVE_KEY: "" },
    stdio: "ignore",
  });
  let rt: { host: string; port: number; token: string } | null = null;
  for (let i = 0; i < 120 && !rt; i++) {
    try {
      const parsed = JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8"));
      if (parsed?.port) rt = parsed;
    } catch { /* not up yet */ }
    if (!rt) await sleep(500);
  }
  return { child, dataDir, rt };
}

{
  const { child, dataDir, rt } = await boot();
  check("runtime boots", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");
  if (rt) {
    const call = async (path: string) => {
      const res = await fetch(`http://${rt.host}:${rt.port}${path}`, { headers: { authorization: `Bearer ${rt.token}` } });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    const noUrl = await call("/api/buzzy/read");
    check("no url is a 400 with a sentence", noUrl.status === 400 && noUrl.body.code === "bad_url", `${noUrl.status} ${JSON.stringify(noUrl.body)}`);

    const priv = await call("/api/buzzy/read?url=" + encodeURIComponent("http://127.0.0.1:9/"));
    check("the route refuses a private address too", priv.status === 422 && priv.body.code === "blocked", `${priv.status} ${JSON.stringify(priv.body)}`);

    if (process.env.BZ_NO_EGRESS) {
      console.log("SKIP  public page (BZ_NO_EGRESS)");
    } else {
      const pub = await call("/api/buzzy/read?url=" + encodeURIComponent("https://example.com/"));
      const ok = pub.status === 200 && pub.body.ok === true && typeof pub.body.text === "string" && pub.body.text.length > 0;
      check("a public page reads as text", ok, `${pub.status} ${String(pub.body.title ?? "")} ${String(pub.body.text ?? "").length} chars`);
      // A reader that cannot name the page or open its links is a text dump.
      check("the page's title comes back", typeof pub.body.title === "string" && pub.body.title.length > 0, JSON.stringify(pub.body.title));
      check("the page's links come back absolute", Array.isArray(pub.body.links) && pub.body.links.every((l: { href: string }) => /^https?:\/\//.test(l.href)), `${(pub.body.links ?? []).length} link(s)`);
    }
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nbuzzy read: passed" : `\nbuzzy read: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
