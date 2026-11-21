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
 * without that session; runs the welcome page's own check and the shell's
 * isShellPath against stand-ins for the browser.
 *
 * Run: `npx tsx scripts/test-signed-in-skips-sign-in.ts` (wired into `test:ci`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { H3 } from "h3";
import { handleAuthRequest } from "../src/lib/auth/server";
import { latestDevMailFor } from "../src/lib/mailer";
import pages, { answerWithin, signedInDestination } from "../src/lib/buzzy/pages.nitro";

const ROOT = join(import.meta.dirname, "..");
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
for (const path of ["/buzzy/landing", "/buzzy/login", "/buzzy/login?next=%2Fbuzzy%2Fjoin"]) {
  const r = await ask(path);
  assert.equal(r.status, 200, `${path} signed out → 200, got ${r.status}`);
  assert.equal(r.cache, "no-store", `${path} must not be stored (a signed-out copy replayed after sign-in)`);
}
const someoneElse = await ask("/buzzy/landing", { cookie: "agent-relay.session_token=not-a-session.sig; other=1" });
assert.equal(someoneElse.status, 200, "a cookie that is not a session still gets the welcome page");
console.log("✓ signed out: welcome and sign-in pages served, no-store");

// ── signed in: straight to Talk ──────────────────────────────────────────
const plainVisits = [
  "/buzzy/landing",
  "/buzzy/landing/",
  "/buzzy/login",
  "/buzzy/login?mode=register",
  "/buzzy/login?verified=1",
  // What a shared or advertised link carries must not decide who is recognised.
  "/buzzy/login?utm_source=newsletter",
  "/buzzy/login?mode=register&fbclid=abc",
  "/buzzy/landing?gclid=abc",
];
for (const c of [cookie, tokenOnly]) {
  for (const path of plainVisits) {
    const r = await ask(path, { cookie: c });
    assert.equal(r.status, 302, `${path} signed in → 302, got ${r.status}`);
    assert.equal(r.location, "/buzzy/talk", `${path} signed in → /buzzy/talk, got ${r.location}`);
    assert.equal(r.cache, "no-store", `${path} redirect must not be stored`);
  }
}
const head = await ask("/buzzy/landing", { cookie, method: "HEAD" });
assert.equal(head.status, 302, "HEAD answers like GET (the welcome page's own check asks with HEAD)");
console.log("✓ signed in: welcome and sign-in pages go to Talk (with or without the cache cookie, tracking words too, GET and HEAD)");

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
// shown to someone who is signed in; the expired-link message), the shell's own fetch
// (it would paint Talk under this address), and every other page.
for (const path of ["/buzzy/login?step=password", "/buzzy/login?link=expired", "/buzzy/login?error=INVALID_TOKEN"]) {
  const r = await ask(path, { cookie });
  assert.equal(r.status, 200, `${path}: a sign-in page step is served to a signed-in visitor, got ${r.status}`);
}
const shell = await ask("/buzzy/landing", { cookie, headers: { "x-bz-shell": "1" } });
assert.equal(shell.status, 200, "an (old, cached) shell's fetch gets the page instead of a redirect it would follow");
const talk = await ask("/buzzy/talk", { cookie });
assert.equal(talk.status, 200, "Talk itself is served");
assert.notEqual(talk.cache, "no-store", "other pages keep their caching");
console.log("✓ page steps, the shell's fetch and other pages are untouched");

// ── a disabled account is "signed out" to the page, as it is to the APIs ──
// Disabling deletes the sessions that exist, but signing in again makes a new one.
// The page must then agree with the APIs (which answer 401), or the welcome page and
// Talk would hand the reader back and forth.
{
  const signIn = async (address: string) => {
    await handleAuthRequest(
      new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, accept: "application/json" },
        body: JSON.stringify({ email: address, callbackURL: "/buzzy/talk" }),
      }),
    );
    const res = await handleAuthRequest(new Request(latestDevMailFor(address)!.actionUrl!, { headers: { accept: "text/html" } }));
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => /session_token=./.test(c)).join("; ");
  };
  const address = `disabled-${Date.now()}@example.com`;
  const first = await signIn(address);
  const who = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: first } }));
  const userId = ((await who.json()) as { user?: { id?: string } } | null)?.user?.id;
  assert.ok(userId, "the second account is signed in");
  const { boardOps } = await import("../src/lib/board-server");
  await boardOps.setUserDisabled({ userId: userId!, disabled: true, reason: "test" });
  const again = await signIn(address);
  assert.ok(again, "a disabled account can still sign in (Better Auth does not know about it)");
  for (const method of ["GET", "HEAD"]) {
    const r = await ask("/buzzy/landing", { cookie: again, method });
    assert.equal(r.status, 200, `${method}: a disabled account gets the welcome page, like the APIs' 401, got ${r.status}`);
  }
}
console.log("✓ a disabled account is not sent to Talk (same answer as the APIs)");

// ── a slow session store never holds the page ─────────────────────────────
{
  const started = Date.now();
  assert.equal(await answerWithin(new Promise(() => {}), 50), null, "no answer in time → null (page served)");
  assert.ok(Date.now() - started < 1000, "gave up on time");
  assert.equal(await answerWithin(Promise.resolve("user"), 1000), "user", "an answer in time is kept");
  await assert.rejects(answerWithin(Promise.reject(new Error("db down")), 1000), /db down/, "a failure stays a failure (caught → page served)");
}
console.log("✓ the session check gives up after a moment instead of holding the page");

// ── the welcome page's own check, for a copy the server never saw ─────────
// Run the page's script against stand-ins for the browser: it must ask the server the
// same question a page load asks (this address, HEAD, without following a redirect),
// move on only when the answer is a redirect, and only while it is still showing.
{
  const landing = readFileSync(join(ROOT, "public", "buzzy", "landing.html"), "utf8");
  const scripts = [...landing.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, "landing.html carries one inline script");
  const run = async (answer: { type?: string; status?: number } | Error, path = "/buzzy/landing") => {
    const asked: { url: string; init: RequestInit }[] = [];
    const replaced: string[] = [];
    const shown: ((e: { persisted: boolean }) => void)[] = [];
    const location = { pathname: path, search: "", replace: (u: string) => replaced.push(u) };
    const win: Record<string, unknown> = {
      location,
      addEventListener: (type: string, fn: (e: { persisted: boolean }) => void) => { if (type === "pageshow") shown.push(fn); },
    };
    const fetch = (url: string, init: RequestInit) => {
      asked.push({ url, init });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ type: "basic", status: 200, ...answer });
    };
    vm.runInNewContext(scripts[0], { window: win, location, fetch });
    await new Promise((r) => setTimeout(r, 10));
    return { asked, replaced, shown, location };
  };
  const yes = await run({ type: "opaqueredirect", status: 0 });
  assert.equal(yes.asked.length, 1, "asks once on load");
  assert.equal(yes.asked[0].url, "/buzzy/landing", "asks for this very address");
  assert.equal(yes.asked[0].init.method, "HEAD");
  assert.equal(yes.asked[0].init.redirect, "manual", "does not follow the answer");
  assert.ok(!JSON.stringify(yes.asked[0].init).includes("x-bz-shell"), "asks as a page load, not as the shell");
  assert.deepEqual(yes.replaced, ["/buzzy/talk"], "a redirect moves the reader to Talk");
  const no = await run({ type: "basic", status: 200 });
  assert.deepEqual(no.replaced, [], "a 200 (signed out, or a disabled account) leaves the page alone");
  const down = await run(new Error("offline"));
  assert.deepEqual(down.replaced, [], "no answer leaves the page alone");
  const gone = await run({ type: "opaqueredirect", status: 0 }, "/buzzy/library");
  assert.equal(gone.asked.length, 0, "does nothing once another page is showing");
  // Back from the page cache: pageshow with persisted re-asks.
  const back = await run({ type: "basic", status: 200 });
  assert.equal(back.shown.length, 1, "listens for pageshow");
  back.shown[0]({ persisted: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(back.asked.length, 2, "a page restored by Back asks again");
}
console.log("✓ landing.html re-checks a copy the server never saw, with the server's own answer");

// ── the shell loads the sign-in pages for real ───────────────────────────
{
  const nav = readFileSync(join(ROOT, "public", "buzzy", "nav.js"), "utf8");
  const src = /function isShellPath\(u\) \{[\s\S]*?\n {2}\}/.exec(nav)?.[0];
  assert.ok(src, "nav.js still has isShellPath");
  const isShellPath = vm.runInNewContext(`(${src})`, { location: { origin: ORIGIN } }) as (u: URL) => boolean;
  for (const p of ["/buzzy/landing", "/buzzy/login", "/buzzy/login?mode=register", "/buzzy/landing/"]) {
    assert.equal(isShellPath(new URL(ORIGIN + p)), false, `${p} is a real page load, not a shell fetch`);
  }
  for (const p of ["/buzzy/talk", "/buzzy/library", "/buzzy/", "/buzzy/login-help"]) {
    assert.equal(isShellPath(new URL(ORIGIN + p)), true, `${p} stays in the shell`);
  }
}
console.log("✓ nav.js loads the sign-in pages for real, so the server decides");

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
