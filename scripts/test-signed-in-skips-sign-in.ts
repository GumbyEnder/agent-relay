/**
 * A signed-in visitor never gets the sign-in pages.
 *
 * Owner, 2026-11-21 (Brave): "when you're already logged in and you go to the
 * website again… it forces you back to the login screen. But when you click any
 * of the buttons in the top right, you're actually back in BeeZilla, logged in."
 * /buzzy/landing and /buzzy/login were served as-is to someone with a live
 * session, their own name in the top right. Those two addresses are the ones
 * every sign-in walks through, so they are what the address bar suggests and a
 * bookmark or a restored tab reopens.
 *
 * Signs a real account in through the real auth handler (magic link, dev inbox,
 * in-process PGlite), then asks the real page handler for each address with and
 * without that session.
 *
 * Run: `npx tsx scripts/test-signed-in-skips-sign-in.ts` (wired into `test:ci`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { H3 } from "h3";
import { handleAuthRequest } from "../src/lib/auth/server";
import { latestDevMailFor } from "../src/lib/mailer";
import pages, { signedInDestination } from "../src/lib/buzzy/pages.nitro";

const ORIGIN = "http://127.0.0.1:8090";
const app = new H3();
app.all("/**", pages);

async function ask(path: string, opts: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "127.0.0.1:8090", ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.fetch(new Request(ORIGIN + path, { method: opts.method ?? "GET", headers }));
  return { status: res.status, location: res.headers.get("location"), cache: res.headers.get("cache-control"), body: await res.text() };
}

// ── a real session ───────────────────────────────────────────────────────
const email = `signed-in-${Date.now()}@example.com`;
const send = await handleAuthRequest(
  new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, accept: "application/json" },
    body: JSON.stringify({ email, callbackURL: "/buzzy/talk" }),
  }),
);
assert.ok(send.ok, `magic link send: ${send.status}`);
const link = latestDevMailFor(email)?.actionUrl;
assert.ok(link, "magic link captured in the dev inbox");
const verify = await handleAuthRequest(new Request(link!, { headers: { accept: "text/html" } }));
const cookie = verify.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .filter((c) => /session_token=./.test(c) || /session_data=./.test(c))
  .join("; ");
assert.ok(/session_token=/.test(cookie), `the link signs in (status ${verify.status})`);
// Only the token, as after the 5-minute cache cookie has expired: the check must go
// to the session store, not just trust the cache cookie.
const tokenOnly = cookie.split("; ").filter((c) => /session_token=/.test(c)).join("; ");
console.log("✓ signed in through the real auth handler");

// ── signed out: both pages served, never stored ──────────────────────────
for (const path of ["/buzzy/landing", "/buzzy/login"]) {
  const r = await ask(path);
  assert.equal(r.status, 200, `${path} signed out → 200, got ${r.status}`);
  assert.equal(r.cache, "no-store", `${path} must not be stored (a signed-out copy replayed after sign-in)`);
}
const someoneElse = await ask("/buzzy/landing", { cookie: "agent-relay.session_token=not-a-session.sig; other=1" });
assert.equal(someoneElse.status, 200, "a cookie that is not a session still gets the welcome page");
console.log("✓ signed out: welcome and sign-in pages served, no-store");

// ── signed in: straight to Talk ──────────────────────────────────────────
for (const c of [cookie, tokenOnly]) {
  for (const path of ["/buzzy/landing", "/buzzy/landing/", "/buzzy/login", "/buzzy/login?mode=register", "/buzzy/login?verified=1"]) {
    const r = await ask(path, { cookie: c });
    assert.equal(r.status, 302, `${path} signed in → 302, got ${r.status}`);
    assert.equal(r.location, "/buzzy/talk", `${path} signed in → /buzzy/talk, got ${r.location}`);
    assert.equal(r.cache, "no-store", `${path} redirect must not be stored`);
  }
}
const head = await ask("/buzzy/landing", { cookie, method: "HEAD" });
assert.equal(head.status, 302, "HEAD answers like GET");
console.log("✓ signed in: welcome and sign-in pages go to Talk (with or without the cache cookie, GET and HEAD)");

// ── `next` is followed only to a BeeZilla page on this origin ─────────────
const invite = await ask("/buzzy/login?next=" + encodeURIComponent("/buzzy/join?invite=abc"), { cookie });
assert.equal(invite.location, "/buzzy/join?invite=abc", `next to an invitation is kept, got ${invite.location}`);
const unencoded = await ask("/buzzy/login?mode=register&next=/buzzy/join?invite=abc", { cookie });
assert.equal(unencoded.location, "/buzzy/join?invite=abc", `an unencoded next keeps its own query, got ${unencoded.location}`);
for (const bad of [
  "//evil.example/x",
  "/\\evil.example/x",
  "https://evil.example/buzzy/talk",
  "/buzzy/../admin",
  "/admin",
  "/buzzy/landing",
  "/buzzy/login?next=/buzzy/talk",
  "buzzy/talk",
]) {
  assert.equal(signedInDestination("login", new URLSearchParams({ next: bad })), "/buzzy/talk", `unsafe next ${bad}`);
}
assert.equal(signedInDestination("landing", new URLSearchParams({ next: "/buzzy/library" })), "/buzzy/talk", "landing ignores next");
console.log("✓ next: same-origin BeeZilla pages only, never a sign-in page");

// ── what is NOT redirected ────────────────────────────────────────────────
// A step of the sign-in page itself (the set-password step after an emailed link is
// shown to someone who is signed in), the shell's own fetch (it would paint Talk under
// this address), and every other page.
const step = await ask("/buzzy/login?step=password", { cookie });
assert.equal(step.status, 200, "a sign-in page step is served to a signed-in visitor");
const shell = await ask("/buzzy/landing", { cookie, headers: { "x-bz-shell": "1" } });
assert.equal(shell.status, 200, "the shell's fetch gets the page; the page's own check moves the reader");
const talk = await ask("/buzzy/talk", { cookie });
assert.equal(talk.status, 200, "Talk itself is served");
assert.notEqual(talk.cache, "no-store", "other pages keep their caching");
console.log("✓ steps, the shell's fetch and other pages are untouched");

// ── the welcome page checks too, for a copy the server never saw ──────────
const landing = readFileSync(join(import.meta.dirname, "..", "public", "buzzy", "landing.html"), "utf8");
assert.match(landing, /\/api\/auth\/get-session/, "landing.html asks who is signed in");
assert.match(landing, /pageshow/, "landing.html re-checks a page restored by Back");
assert.match(landing, /location\.replace\("\/buzzy\/talk"\)/, "landing.html moves a signed-in reader to Talk");
console.log("✓ landing.html re-checks copies the server never saw");

// ── signed out again: the pages come back ─────────────────────────────────
const out = await handleAuthRequest(
  new Request(`${ORIGIN}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: "{}",
  }),
);
assert.ok(out.ok, `sign-out ${out.status}`);
const after = await ask("/buzzy/landing", { cookie: tokenOnly });
assert.equal(after.status, 200, "after signing out the welcome page is served again");
console.log("✓ signed out again: welcome page served");

console.log("\nSigned-in visitors skip the sign-in pages.");
process.exit(0);
