/**
 * Register → verification mail captured → verify token path → sign-in gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendVerificationMail, latestDevMailFor, isDevMailInboxEnabled } from "../src/lib/mailer";
import { handleAuthRequest } from "../src/lib/auth/server";

assert.equal(isDevMailInboxEnabled(), true);

const url = "http://127.0.0.1:8090/api/auth/verify-email?token=testtoken&callbackURL=%2Flogin%3Fverified%3D1";
const mail = await sendVerificationMail({
  to: "ops@example.com",
  name: "Ops",
  url,
});
assert.equal(mail.transport, "dev");
assert.ok(mail.actionUrl?.includes("verify-email"));
assert.ok(mail.actionUrl?.includes("callbackURL"), "verify url carries callbackURL");
const latest = latestDevMailFor("ops@example.com");
assert.ok(latest);
assert.equal(latest!.actionUrl, url);
assert.ok(/verif/i.test(mail.text), "body mentions verification");
assert.ok(/verif/i.test(mail.subject), "subject mentions verification");
console.log("✓ mailer verification template + dev inbox");

{
  const loginSrc = readFileSync(new URL("../src/routes/login.tsx", import.meta.url), "utf8");
  const registerSrc = readFileSync(
    new URL("../src/routes/register.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(loginSrc.includes("githubOAuth"), "GitHub button gated on githubOAuth");
  assert.ok(
    /import\.meta\.env\.DEV[\s\S]*GITHUB_CLIENT_ID[\s\S]*GITHUB_CLIENT_SECRET/.test(loginSrc),
    "env var names only in DEV help",
  );
  assert.match(registerSrc, /password !== confirm/);
  assert.match(registerSrc, /minLength=\{8\}/);
  console.log("✓ login GitHub gate + register confirm");
}

{
  const res = await handleAuthRequest(
    new Request("http://127.0.0.1:8090/api/auth/verify-email?token=not-a-real-token", {
      headers: { accept: "text/html" },
    }),
  );
  assert.ok(res.status === 302 || res.status === 307, `verify invalid redirects, got ${res.status}`);
  const loc = res.headers.get("location") ?? "";
  assert.ok(
    loc.includes("/login?verified=0") || loc.includes("verified=0"),
    `invalid token lands on verified=0, got ${loc || res.status}`,
  );
  const ct = res.headers.get("content-type") ?? "";
  assert.ok(!ct.includes("application/json"), "browser verify must not return JSON");
  console.log("✓ verify-email invalid token redirects, not JSON");
}

{
  // Magic link: request one for a fresh address, expect a one-time link email.
  const res = await handleAuthRequest(
    new Request("http://127.0.0.1:8090/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:8090",
        accept: "application/json",
      },
      body: JSON.stringify({
        email: "magic@example.com",
        callbackURL: "/",
      }),
    }),
  );
  assert.ok(res.ok, `magic-link/send should succeed, got ${res.status}`);
  const magic = latestDevMailFor("magic@example.com");
  assert.ok(magic, "magic link email captured in dev inbox");
  assert.ok(magic!.actionUrl?.includes("magic-link/verify"), `action URL is a magic-link verify: ${magic!.actionUrl}`);
  assert.ok(/sign-?in/i.test(magic!.subject), "subject mentions sign in");
  console.log("✓ magic-link send → one-time sign-in link email");
}

{
  const { handleAgentApiRequest } = await import("../src/lib/agent-api.server");
  const me = await handleAgentApiRequest(
    new Request("http://127.0.0.1:8090/api/agent/me", {
      headers: { "sec-fetch-site": "same-origin", accept: "application/json" },
    }),
  );
  const body = (await me.json()) as { githubOAuth?: boolean };
  assert.equal(typeof body.githubOAuth, "boolean");
  const raw = JSON.stringify(body);
  assert.equal(raw.includes("GITHUB_CLIENT_ID"), false);
  assert.equal(raw.includes("GITHUB_CLIENT_SECRET"), false);
  console.log("✓ GET /me githubOAuth boolean, no env names");
}

console.log("\nAuth email unit checks passed.");
