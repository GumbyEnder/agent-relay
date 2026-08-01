/**
 * Register → verification mail captured → verify token path → sign-in gate.
 */
import assert from "node:assert/strict";
import { sendVerificationMail, latestDevMailFor, isDevMailInboxEnabled } from "../src/lib/mailer";

assert.equal(isDevMailInboxEnabled(), true);

const url = "http://127.0.0.1:8090/api/auth/verify-email?token=testtoken&callbackURL=%2Flogin%3Fverified%3D1";
const mail = await sendVerificationMail({
  to: "ops@example.com",
  name: "Ops",
  url,
});
assert.equal(mail.transport, "dev");
assert.ok(mail.actionUrl?.includes("verify-email"));
const latest = latestDevMailFor("ops@example.com");
assert.ok(latest);
assert.equal(latest!.actionUrl, url);
assert.ok(/verif/i.test(mail.text), "body mentions verification");
assert.ok(/verif/i.test(mail.subject), "subject mentions verification");
console.log("✓ mailer verification template + dev inbox");
console.log("\nAuth email unit checks passed.");
