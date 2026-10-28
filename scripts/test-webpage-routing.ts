/**
 * read_web_page routing tests (plan wave 1, B1/D8).
 *
 * The whole point of the tool is that the ROUTING is deterministic: plain HTTP
 * first, browser only when the page reads as a shell. These tests pin that with
 * a stubbed fetch, so no network is used:
 *   - a thick page takes the HTTP path and never calls the provider
 *   - a thin page falls through to the browser and reports path=browser
 *   - a private address is refused before anything is fetched
 *   - a provider failure falls back to the raw page with an honest note
 *
 * Hosts are real (DNS resolves) but every HTTP call is stubbed — the SSRF guard
 * legitimately refuses unresolvable hosts, so fake TLDs would test the guard
 * instead of the routing.
 *
 * Run: BZ_HYPERBROWSER_KEY=test npx tsx scripts/test-webpage-routing.ts
 */
process.env.BZ_HYPERBROWSER_KEY = process.env.BZ_HYPERBROWSER_KEY || "test-key";

import { htmlToText, fetchPageText, readWebPage } from "../src/lib/buzzy/webpage";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const THICK = `<html><head><title>Supplier</title><style>.x{color:red}</style><script>var a=1;</script></head>
<body><h1>Fence supply</h1>${"<p>Six foot cedar pickets are priced per linear foot and delivered within five days.</p>".repeat(30)}</body></html>`;
const THIN = `<html><head><title>App</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>`;

const realFetch = globalThis.fetch;
let calls: string[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

console.log("htmlToText:");
const text = htmlToText(THICK);
check("drops script content", !text.includes("var a=1"));
check("drops style content", !text.includes("color:red"));
check("keeps the prose", text.includes("cedar pickets"));

console.log("private address:");
{
  stubFetch(() => html(THICK));
  const res = await fetchPageText("http://127.0.0.1/admin");
  check("loopback is refused", !res.ok && res.code === "blocked", JSON.stringify(res));
  check("nothing was fetched", calls.length === 0, calls.join(","));
}

console.log("thick page takes the HTTP path:");
{
  stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
    return html(THICK);
  });
  const res = await readWebPage("https://example.com/fence");
  check("path is http", res.ok && res.path === "http", JSON.stringify({ ok: res.ok, path: res.path }));
  check("no provider call was made", !calls.some((u) => u.includes("hyperbrowser")), calls.join(","));
  check("text came from the page", res.text.includes("cedar pickets"));
}

console.log("thin page falls through to the browser:");
{
  stubFetch((url) => {
    if (url.includes("hyperbrowser.ai/api/scrape") && url.endsWith("/scrape")) {
      return new Response(JSON.stringify({ jobId: "job_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/scrape/job_1")) {
      return new Response(
        JSON.stringify({
          jobId: "job_1",
          status: "completed",
          data: { markdown: "# Grant portal\n\nApplications close 14 March. Fee: $250.", metadata: { title: "Grant portal", finalUrl: "https://example.com/grants" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
    return html(THIN);
  });
  const res = await readWebPage("https://example.com/grants");
  check("path is browser", res.ok && res.path === "browser", JSON.stringify({ ok: res.ok, path: res.path, err: res.error }));
  check("rendered text is used", res.text.includes("Applications close 14 March"), res.text.slice(0, 80));
  check("robots verdict is reported", res.robots === "allow", String(res.robots));
  check("a note explains the render", !!res.note && /render/i.test(res.note), String(res.note));
}

console.log("browser failure falls back honestly:");
{
  stubFetch((url) => {
    if (url.endsWith("/scrape")) return new Response(JSON.stringify({ jobId: "job_2" }), { status: 200 });
    if (url.includes("/api/scrape/job_2")) return new Response(JSON.stringify({ jobId: "job_2", status: "failed", error: "blocked by site" }), { status: 200 });
    return html(THIN);
  });
  const res = await readWebPage("https://example.com/broken");
  check("still returns the raw page", res.ok && res.path === "http", JSON.stringify({ ok: res.ok, path: res.path }));
  check("says the render failed", !!res.note && /failed/i.test(res.note), String(res.note));
}

globalThis.fetch = realFetch;

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("webpage routing: all checks passed");
