/**
 * BeeZilla email-first sign-in, end to end against the real Better Auth handler:
 * lookup → sign-in link (creates the account) → set a password → password
 * sign-in → forgot password (link → new password, other devices signed out)
 * → "forever" session cookie.
 */
import assert from "node:assert/strict";
import { latestDevMailFor, isDevMailInboxEnabled } from "../src/lib/mailer";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { auth, handleAuthRequest } from "../src/lib/auth/server";
import { emailFirst, RECENT_SIGN_IN_SECONDS } from "../src/lib/auth/email-first";

assert.equal(isDevMailInboxEnabled(), true);

const ORIGIN = "http://127.0.0.1:8090";
const EMAIL = `bee-${Date.now()}@example.com`;
const AFTER_LINK = "/buzzy/login?step=password";

type Res = { status: number; data: any; headers: Headers };

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { origin: ORIGIN, accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await handleAuthRequest(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** The `name=value` of the session-token cookie a response set. */
function sessionCookie(res: Res): string {
  const all = res.headers.getSetCookie();
  const token = all.find((c) => c.startsWith("agent-relay.session_token="));
  assert.ok(token, `expected a session cookie, got: ${all.join(" | ") || "none"}`);
  return token!.split(";")[0]!;
}

function maxAgeOf(res: Res): number {
  const token = res.headers.getSetCookie().find((c) => c.startsWith("agent-relay.session_token="));
  const m = token?.match(/Max-Age=(\d+)/i);
  return m ? Number(m[1]) : 0;
}

async function openLatestLink(email: string): Promise<Res> {
  const mail = latestDevMailFor(email);
  assert.ok(mail?.actionUrl?.includes("/magic-link/verify"), "sign-in link emailed");
  const url = new URL(mail!.actionUrl!);
  return call("GET", url.pathname.replace(/^\/api\/auth/, "") + url.search);
}

// 1. Unknown email → no account, no password.
{
  const res = await call("POST", "/email-first/lookup", { body: { email: EMAIL.toUpperCase() } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { exists: false, hasPassword: false });
  const bad = await call("POST", "/email-first/lookup", { body: { email: "not-an-email" } });
  assert.equal(bad.status, 400);
  console.log("✓ lookup: unknown email, invalid email rejected");
}

// 2. Register = sign-in link; opening it creates the account and signs in.
let deviceA = "";
{
  const send = await call("POST", "/sign-in/magic-link", {
    body: { email: EMAIL, callbackURL: AFTER_LINK, newUserCallbackURL: AFTER_LINK },
  });
  assert.equal(send.status, 200, `send link: ${JSON.stringify(send.data)}`);
  const open = await openLatestLink(EMAIL);
  assert.ok(open.status === 302 || open.status === 307, `link redirects, got ${open.status}`);
  assert.ok((open.headers.get("location") ?? "").includes(AFTER_LINK), "new user lands on set-password step");
  deviceA = sessionCookie(open);
  assert.ok(maxAgeOf(open) >= 60 * 60 * 24 * 399, `forever cookie, got Max-Age=${maxAgeOf(open)}`);

  const status = await call("GET", "/email-first/status", { cookie: deviceA });
  assert.equal(status.status, 200);
  assert.deepEqual(status.data, { hasPassword: false, canReplace: true });
  const lookup = await call("POST", "/email-first/lookup", { body: { email: EMAIL } });
  assert.deepEqual(lookup.data, { exists: true, hasPassword: false });
  console.log("✓ link creates the account, signs in for 400 days, lands on set-password");
}

// 3. Set the first password (no current password needed).
{
  const anon = await call("POST", "/email-first/set-password", { body: { newPassword: "honeycomb-42" } });
  assert.equal(anon.status, 401, "signed-out visitors cannot set a password");
  const short = await call("POST", "/email-first/set-password", {
    cookie: deviceA,
    body: { newPassword: "short" },
  });
  assert.equal(short.status, 400);
  assert.equal(short.data?.code, "PASSWORD_TOO_SHORT");
  const set = await call("POST", "/email-first/set-password", {
    cookie: deviceA,
    body: { newPassword: "honeycomb-42" },
  });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(set.data, { status: true, replaced: false });
  const lookup = await call("POST", "/email-first/lookup", { body: { email: EMAIL } });
  assert.deepEqual(lookup.data, { exists: true, hasPassword: true });
  console.log("✓ first password set after link sign-in");
}

// 4. Password sign-in: wrong → 401, right → signed in (device B).
let deviceB = "";
{
  const wrong = await call("POST", "/sign-in/email", { body: { email: EMAIL, password: "honeycomb-41" } });
  assert.equal(wrong.status, 401);
  const right = await call("POST", "/sign-in/email", {
    body: { email: EMAIL, password: "honeycomb-42", rememberMe: true },
  });
  assert.equal(right.status, 200, JSON.stringify(right.data));
  deviceB = sessionCookie(right);
  assert.ok(maxAgeOf(right) >= 60 * 60 * 24 * 399, "password sign-in is also a forever session");
  console.log("✓ password sign-in: wrong rejected, right accepted");
}

// 5. A stale session (signed in > 15 min ago) cannot replace the password.
{
  const ctx = await auth.$context;
  const token = decodeURIComponent(deviceA.split("=")[1]!).split(".")[0]!;
  await ctx.internalAdapter.updateSession(token, {
    createdAt: new Date(Date.now() - (RECENT_SIGN_IN_SECONDS + 60) * 1000),
  });
  const status = await call("GET", "/email-first/status", { cookie: deviceA });
  assert.deepEqual(status.data, { hasPassword: true, canReplace: false });
  const stale = await call("POST", "/email-first/set-password", {
    cookie: deviceA,
    body: { newPassword: "stolen-cookie-1" },
  });
  assert.equal(stale.status, 403);
  assert.equal(stale.data?.code, "SIGN_IN_AGAIN");
  console.log("✓ an old session cannot change the password");
}

// 6. Forgot password: link → new password; other devices signed out; notice emailed.
{
  const send = await call("POST", "/sign-in/magic-link", {
    body: { email: EMAIL, callbackURL: AFTER_LINK },
  });
  assert.equal(send.status, 200);
  const open = await openLatestLink(EMAIL);
  assert.ok((open.headers.get("location") ?? "").includes(AFTER_LINK), "existing user lands on set-password step");
  const deviceC = sessionCookie(open);
  const status = await call("GET", "/email-first/status", { cookie: deviceC });
  assert.deepEqual(status.data, { hasPassword: true, canReplace: true });

  const reset = await call("POST", "/email-first/set-password", {
    cookie: deviceC,
    body: { newPassword: "new-honey-77" },
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.deepEqual(reset.data, { status: true, replaced: true });

  const notice = latestDevMailFor(EMAIL);
  assert.ok(notice && /password was changed/i.test(notice.subject), "password-changed notice emailed");

  // Mail is branded by the host the browser used.
  const bz = await handleAuthRequest(
    new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        accept: "application/json",
        "content-type": "application/json",
        "x-forwarded-host": "beezilla.net",
      },
      body: JSON.stringify({ email: EMAIL, callbackURL: AFTER_LINK }),
    }),
  );
  assert.equal(bz.status, 200);
  assert.match(latestDevMailFor(EMAIL)!.subject, /BeeZilla sign-in link/, "beezilla.net link mail says BeeZilla");

  const stillIn = await call("GET", "/get-session", { cookie: deviceC });
  assert.ok(stillIn.data?.session, "the device that reset stays signed in");
  for (const [label, cookie] of [["A", deviceA], ["B", deviceB]] as const) {
    const gone = await call("GET", "/get-session", { cookie });
    assert.ok(!gone.data?.session, `device ${label} was signed out`);
  }

  const oldPw = await call("POST", "/sign-in/email", { body: { email: EMAIL, password: "honeycomb-42" } });
  assert.equal(oldPw.status, 401, "old password no longer works");
  const newPw = await call("POST", "/sign-in/email", { body: { email: EMAIL, password: "new-honey-77" } });
  assert.equal(newPw.status, 200, "new password works");
  console.log("✓ forgot password: link → new password, other devices out, notice sent");
}

// 7. A used or bogus link lands back on the page with an error, not JSON.
{
  const res = await call(
    "GET",
    `/magic-link/verify?token=not-a-real-token&callbackURL=${encodeURIComponent(AFTER_LINK)}&errorCallbackURL=${encodeURIComponent("/buzzy/login?link=expired")}`,
  );
  assert.ok(res.status === 302 || res.status === 307, `bad link redirects, got ${res.status}`);
  assert.ok((res.headers.get("location") ?? "").includes("/buzzy/login?link=expired"));
  console.log("✓ expired link returns to the sign-in page");
}

// 8. The page checks a password 2 s after typing stops, so a person fixing a
//    typo spends several sign-in attempts quickly. With rate limiting on (as in
//    production) ten wrong tries are judged; the eleventh gets a 429 with a
//    retry hint. Better Auth's own default would have refused the fourth.
{
  const limited = betterAuth({
    baseURL: ORIGIN,
    secret: "rate-limit-check-secret-0123456789abcdef",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: true, storage: "memory" },
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    plugins: [emailFirst()],
  });
  const post = (path: string, body: unknown) =>
    limited.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify(body),
      }),
    );
  const user = { email: "limit@example.com", password: "right-pass-1" };
  const up = await post("/sign-up/email", { ...user, name: "" });
  assert.equal(up.status, 200, `sign-up for the rate-limit check: ${up.status}`);
  for (let i = 1; i <= 10; i++) {
    const res = await post("/sign-in/email", { email: user.email, password: `wrong-pass-${i}` });
    assert.equal(res.status, 401, `wrong try ${i} is judged, not rate limited (got ${res.status})`);
  }
  const blocked = await post("/sign-in/email", { email: user.email, password: user.password });
  assert.equal(blocked.status, 429, "the eleventh try in a minute is refused");
  assert.ok(Number(blocked.headers.get("X-Retry-After")) > 0, "the refusal says when to retry");
  console.log("✓ sign-in allows 10 tries a minute (2 s auto-check is safe), then 429 with a retry hint");
}

console.log("\nEmail-first sign-in checks passed.");
process.exit(0);
