/**
 * CR-6 feedback — the rules that must not drift.
 *
 * Run: npx tsx scripts/test-buzzy-feedback.ts
 *
 * Covers: the diagnostic whitelist (unknown keys dropped, path-only URLs,
 * account id never taken from the client, list caps), the redaction list, the
 * WAV duration floor the 60 s cap depends on, and the ref shape.
 */
import {
  FEEDBACK_CONSOLE_MAX,
  anonIpHash,
  clientIp,
  ipHash,
  makeRef,
  pathOnly,
  redactText,
  sanitizeDiag,
  wavDurationSeconds,
} from "../src/lib/buzzy/feedback";

let failed = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`ok   ${label}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

// ── redaction ────────────────────────────────────────────────────────────
{
  const r = redactText("Authorization: Bearer abcdefghijklmnop and key sk-live-1234567890");
  ok("bearer redacted", !/abcdefghijklmnop/.test(r.text), r.text);
  ok("api key redacted", !/sk-live-1234567890/.test(r.text), r.text);
  ok("counts every hit", r.count >= 2, r.count);
  ok("kinds named", r.kinds.includes("bearer_token") && r.kinds.includes("api_key"), r.kinds);

  const q = redactText("GET /api/x?token=supersecret&ok=1");
  ok("query token value gone", !/supersecret/.test(q.text), q.text);
  ok("query param name kept", /token=\[redacted\]/.test(q.text), q.text);

  const aws = redactText("AKIAIOSFODNN7EXAMPLE");
  ok("aws key redacted", aws.text === "[redacted]", aws.text);
}

// ── path only ────────────────────────────────────────────────────────────
{
  ok("path strips query", pathOnly("https://beezilla.net/buzzy/talk?token=abc#x") === "/buzzy/talk");
  ok("relative path keeps slash", pathOnly("/buzzy/library?job=1") === "/buzzy/library");
  ok("bare host becomes path", pathOnly("beezilla.net/buzzy") === "/beezilla.net/buzzy", pathOnly("beezilla.net/buzzy"));
}

// ── diagnostic whitelist ─────────────────────────────────────────────────
{
  const raw = {
    captured_at: "2026-11-18T23:41:07.512Z",
    page: { url: "https://beezilla.net/buzzy/talk?token=leak#frag", route: "talk", extra: "drop me" },
    browser: { user_agent: "Mozilla/5.0", platform: "Linux", language: "en-US", cookies: "secret" },
    display: { screen: "1920x1080", viewport: "1280x720", device_pixel_ratio: 1 },
    account: { signed_in: true, user_id: "usr_forged", email: "leak@example.com" },
    console_errors: Array.from({ length: 80 }, (_, i) => ({
      at: "t",
      kind: "error",
      message: i === 0 ? "Authorization: Bearer abcdefghijklmnop" : `m${i}`,
      source: "s",
    })),
    failed_requests: Array.from({ length: 80 }, (_, i) => ({ at: "t", method: "POST", url: "/api/x?key=zzz", status: 500, ms: 1, body: "leak" })),
    cookie: "leak",
  };
  const { diag, redactions } = sanitizeDiag(raw);
  ok("diag produced", Boolean(diag));
  const d = diag as Record<string, any>;
  ok("page url is path only", d.page.url === "/buzzy/talk", d.page.url);
  ok("unknown page key dropped", !("extra" in d.page));
  ok("browser cookies dropped", !("cookies" in d.browser));
  ok("client user id ignored", d.account.user_id === null, d.account.user_id);
  ok("client email never stored", !("email" in d.account));
  ok("console capped", d.console_errors.length === FEEDBACK_CONSOLE_MAX, d.console_errors.length);
  ok("failed requests capped", d.failed_requests.length === FEEDBACK_CONSOLE_MAX);
  ok("request body dropped", !("body" in d.failed_requests[0]));
  ok("request url stripped", d.failed_requests.every((r: any) => !String(r.url).includes("?key=")));
  ok("top-level unknown dropped", !("cookie" in d));
  ok("redactions counted", redactions >= 1, redactions);
  ok("console message redacted", !/abcdefghijklmnop/.test(JSON.stringify(d.console_errors)), d.console_errors[0]);

  const none = sanitizeDiag(null);
  ok("null diag stays null", none.diag === null);
}

// ── WAV duration ─────────────────────────────────────────────────────────
function wav(seconds: number, rate = 16000): Uint8Array {
  const samples = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buf);
  const wr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  wr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wr(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Uint8Array(buf);
}
{
  const two = wavDurationSeconds(wav(2));
  ok("2 s wav measures 2 s", two !== null && Math.abs(two - 2) < 0.01, two);
  const sixtyOne = wavDurationSeconds(wav(61));
  ok("61 s wav measures over the cap", sixtyOne !== null && sixtyOne > 60, sixtyOne);
  ok("garbage is not a wav", wavDurationSeconds(new Uint8Array(200)) === null);
  // Byte length alone is ambiguous: 8 s at 16 kHz and 64 s at 2 kHz are the same
  // byte count. The header decides, which is the whole point of the arm.
  const slow = wav(64, 2000);
  ok("low-rate 64 s is over the cap despite ordinary bytes", (wavDurationSeconds(slow) ?? 0) > 60, wavDurationSeconds(slow));
}

// ── the counted address: the edge hop, not the client's claim (F2) ──────
{
  const mk = (pairs: Record<string, string>) => new Headers(pairs);
  ok(
    "x-real-ip wins over a client-supplied X-Forwarded-For",
    clientIp(mk({ "x-forwarded-for": "6.6.6.6, 10.0.0.2", "x-real-ip": "203.0.113.9" })) === "203.0.113.9",
    clientIp(mk({ "x-forwarded-for": "6.6.6.6, 10.0.0.2", "x-real-ip": "203.0.113.9" })),
  );
  ok(
    "rightmost XFF is the edge hop when there is no x-real-ip",
    clientIp(mk({ "x-forwarded-for": "1.2.3.4, 10.0.0.2" })) === "10.0.0.2",
    clientIp(mk({ "x-forwarded-for": "1.2.3.4, 10.0.0.2" })),
  );
  ok("no address headers reads as empty", clientIp(mk({})) === "");
  // The spoofed-XFF arm: six requests, six fresh leftmost values, one edge hop.
  const seen = new Set<string>();
  for (let i = 1; i <= 6; i += 1) {
    seen.add(anonIpHash(clientIp(mk({ "x-forwarded-for": `${i}.${i}.${i}.${i}, 10.0.0.2` })), "pepper"));
  }
  ok("six distinct client XFF values collapse to one bucket", seen.size === 1, seen.size);
}

// ── the anonymous bucket is never null, so it never fails open (F1) ─────
{
  const a = anonIpHash("", "pepper");
  const b = anonIpHash("", "pepper");
  const c = anonIpHash("198.51.100.7", "pepper");
  ok("unknown address still yields a key", typeof a === "string" && a.length === 64, a.length);
  ok("unknown address is stable, so it shares one bucket", a === b);
  ok("a known address does not share the unknown bucket", a !== c);
  ok("a different pepper changes the key", a !== anonIpHash("", "other-pepper"));
  ok("ipHash still returns null for empty, so callers must pick a bucket deliberately", ipHash("", "pepper") === null);
}

// ── app_sha is server-stamped only (F3) ─────────────────────────────────
{
  const s = sanitizeDiag({ page: { url: "https://beezilla.net/buzzy/talk", route: "talk", app_sha: "client-forged" } });
  ok("client page.app_sha is dropped by the whitelist", (s.diag as any)?.page?.app_sha === undefined, (s.diag as any)?.page);
}

// ── ref shape ────────────────────────────────────────────────────────────
{
  const refs = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const r = makeRef();
    ok(`ref shape ${r}`, /^BZ-FB-[A-HJ-NP-Z2-9]{6}$/.test(r), r);
    if (refs.has(r)) ok("ref unique in 500 draws", false, r);
    refs.add(r);
  }
}

if (failed) {
  console.error(`\nfeedback: FAILED — ${failed} case(s)`);
  process.exit(1);
}
console.log("\nfeedback: all checks passed");
