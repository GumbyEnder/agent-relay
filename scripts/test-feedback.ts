/**
 * Feedback: the rules that must hold before anything is written.
 *
 * 7318/7319 pin four of them, and each has a failure mode that is invisible in
 * the happy path:
 *
 *  1. an empty or 4001-character report is refused with a sentence, not stored;
 *  2. a screenshot is not a field — v1 has none, so a caller that sends one must
 *     not have it silently persisted;
 *  3. diagnostics are capped and redacted, because a page can hand us anything;
 *  4. the anonymous dictation ceiling is DECODED duration, not byte size — an
 *     8 MB file of 192 kHz stereo is 10 seconds and must be refused on seconds.
 *
 * Run: npx tsx scripts/test-feedback.ts   (wired into test:ci)
 */
import {
  checkFeedback,
  redact,
  ipHash,
  referenceFor,
  wavDurationSeconds,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_AUDIO_MAX_SECONDS,
  IP_LIMIT,
} from "../src/lib/buzzy/feedback";

let failed = 0;
function ok(label: string, pass: boolean, detail?: unknown) {
  if (pass) console.log("  ok   " + label);
  else {
    failed++;
    console.log("  FAIL " + label + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}

console.log("a report is a paragraph, and an empty one is refused in words:");
ok("empty is refused", checkFeedback({ message: "   " }).ok === false, checkFeedback({ message: "   " }));
ok("4000 characters is accepted", checkFeedback({ message: "x".repeat(FEEDBACK_TEXT_MAX) }).ok === true);
ok(`${FEEDBACK_TEXT_MAX + 1} characters is refused`, checkFeedback({ message: "x".repeat(FEEDBACK_TEXT_MAX + 1) }).ok === false);

console.log("the kind is one of four, and anything else becomes general:");
const kinds = ["bug", "confusing", "idea", "general"].map((k) => {
  const r = checkFeedback({ message: "hi", kind: k });
  return r.ok ? r.report.kind : "REFUSED";
});
ok("each kind survives", kinds.join(",") === "bug,confusing,idea,general", kinds);
const odd = checkFeedback({ message: "hi", kind: "urgent!!" });
ok("an unknown kind falls back to general", odd.ok && odd.report.kind === "general", odd.ok ? odd.report.kind : odd);

console.log("v1 has NO screenshot field:");
const noShot = checkFeedback({ message: "hi", screenshot: "data:image/png;base64,AAA" } as never);
ok("a screenshot on the wire is not stored", noShot.ok && !("screenshot" in noShot.report), noShot.ok ? Object.keys(noShot.report) : noShot);

console.log("diagnostics are trimmed to what the panel showed, and redacted:");
const diag = checkFeedback({
  message: "hi",
  diagnostics: {
    page: "https://beezilla.net/buzzy/talk",
    token: "sk_live_abcdefgh12345678",
    nested: { deep: "not stored" },
    errors: ["a", "b"],
    n: 3,
  },
});
ok("string leaves survive", diag.ok && (diag.report.diagnostics as Record<string, unknown>)?.page === "https://beezilla.net/buzzy/talk");
ok("a key-shaped string is redacted", diag.ok && String((diag.report.diagnostics as Record<string, unknown>)?.token) === "[redacted]", diag.ok ? (diag.report.diagnostics as Record<string, unknown>)?.token : diag);
ok("a nested object is dropped, not serialised", diag.ok && !("nested" in ((diag.report.diagnostics as Record<string, unknown>) || {})));
ok("an array is kept, capped", diag.ok && Array.isArray((diag.report.diagnostics as Record<string, unknown>)?.errors));
ok("no diagnostics means null, not {}", checkFeedback({ message: "hi" }).ok && (checkFeedback({ message: "hi" }) as { report: { diagnostics: unknown } }).report.diagnostics === null);

console.log("redaction covers the shapes a person pastes:");
ok("sk_/pk_/rk_ keys", redact("key sk_live_abcd1234efgh") === "key [redacted]", redact("key sk_live_abcd1234efgh"));
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz1";
ok("a jwt-shaped string", redact(jwt) === "[redacted]", redact(jwt));

console.log("the limiter key is stable, salted and non-reversible:");
ok("same address, same key", ipHash("1.2.3.4") === ipHash("1.2.3.4"));
ok("different address, different key", ipHash("1.2.3.4") !== ipHash("1.2.3.5"));
ok("the address is not in the key", !ipHash("1.2.3.4").includes("1.2.3.4"));
ok("a different salt gives a different key", ipHash("1.2.3.4", "a") !== ipHash("1.2.3.4", "b"));
ok("no address means no key", ipHash("") === "");
ok("the per-ip ceiling is 15 (7318)", IP_LIMIT === 15, IP_LIMIT);

console.log("the reference is short, quoted in a sentence, and not an id:");
const ref = referenceFor("fb_0123456789abcdef");
ok("looks like BZ-XXXX", /^BZ-[0-9A-Z]{4}$/.test(ref), ref);
ok("two ids do not collide", new Set([1, 2, 3, 4, 5].map((i) => referenceFor("fb_" + "0123456789abcdef".slice(0, 14) + i))).size > 1);
ok("a prefix alone does not decide the reference", referenceFor("fb_aaaaaaaa") !== referenceFor("fb_bbbbbbbb"));

console.log("audio is measured in decoded seconds, not bytes:");
function wav(seconds: number, rate: number, channels = 1, bits = 16): Uint8Array {
  const blockAlign = (channels * bits) / 8;
  const dataBytes = Math.floor(seconds * rate) * blockAlign;
  const buf = new Uint8Array(44 + dataBytes);
  const dv = new DataView(buf.buffer);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  ws(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  ws(36, "data");
  dv.setUint32(40, dataBytes, true);
  return buf;
}
const d10 = wavDurationSeconds(wav(10, 16000));
ok("10 s at 16 kHz mono reads as 10 s", d10 !== null && Math.abs(d10 - 10) < 0.05, d10);
const d59 = wavDurationSeconds(wav(59, 16000));
ok("59 s is under the ceiling", d59 !== null && d59 < FEEDBACK_AUDIO_MAX_SECONDS, d59);
const d61 = wavDurationSeconds(wav(61, 16000));
ok("61 s is over the ceiling", d61 !== null && d61 > FEEDBACK_AUDIO_MAX_SECONDS, d61);
// The case a byte cap alone would wave through: 10 s, but 192 kHz stereo 16-bit.
const hd = wav(10, 192000, 2, 16);
ok("10 s of 192 kHz stereo is 10 s, not a 61 s file", wavDurationSeconds(hd) !== null && Math.abs((wavDurationSeconds(hd) as number) - 10) < 0.05, wavDurationSeconds(hd));
ok("its byte size would have looked large", hd.byteLength > 7_000_000, hd.byteLength);
ok("not a wav at all reads as null", wavDurationSeconds(new Uint8Array(200)) === null);
ok("a truncated header reads as null", wavDurationSeconds(wav(1, 16000).slice(0, 30)) === null);

if (failed) {
  console.error(`\n${failed} feedback test(s) failed`);
  process.exit(1);
}
console.log("\nall feedback tests passed");
