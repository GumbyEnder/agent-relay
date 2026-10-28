/**
 * Tests for short-lived inference tokens — the gate between an account and OUR
 * inference. The interesting cases are all failures: a token that can be forged,
 * replayed past its expiry, or reused outside its scope is worse than no token.
 *
 * Run: npx tsx scripts/test-inference-token.ts
 */
import { createHmac } from "node:crypto";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  inferenceEndpoint,
  mintInferenceToken,
  signingSecret,
  verifyInferenceToken,
} from "../src/lib/buzzy/inferenceToken";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const SECRET = "test-signing-secret-that-is-long-enough";
const NOW = 1_800_000_000;

// ── fail closed without a secret ────────────────────────────────────────────
{
  check("a short secret is treated as no secret", signingSecret("tooshort") === "");
  const refused = mintInferenceToken({ userId: "user_1", secret: "" });
  check("minting refuses to run without a signing secret", !refused.ok && /not configured/.test(refused.error ?? ""), refused.error);

  const minted = mintInferenceToken({ userId: "user_1", secret: SECRET, now: NOW });
  const nothing = verifyInferenceToken(minted.token ?? "", { secret: "" });
  check("verifying refuses to run without a signing secret", !nothing.ok && nothing.reason === "no_secret", nothing.reason);
}

// ── the happy path ──────────────────────────────────────────────────────────
const minted = mintInferenceToken({ userId: "user_42", secret: SECRET, now: NOW });
{
  check("a token is minted for the account", minted.ok && Boolean(minted.token), minted.error ?? "token issued");
  check("the token carries the inference scope", minted.claims?.scope === "inference");
  check("the token is short-lived by default", minted.claims?.exp === NOW + DEFAULT_TTL_SECONDS, `${(minted.claims?.exp ?? 0) - (minted.claims?.iat ?? 0)}s`);
  check("the token names the user it was minted for", minted.claims?.sub === "user_42");
  check("the token has a unique id", /^[0-9a-f]{24}$/.test(minted.claims?.jti ?? ""));
  check("the token is url-safe one-liner", /^bz1\.[\w-]+\.[\w-]+$/.test(minted.token ?? ""));

  const verified = verifyInferenceToken(minted.token!, { secret: SECRET, now: NOW + 60 });
  check("a fresh token verifies", verified.ok && verified.claims?.sub === "user_42", verified.reason);
}

// ── the failures ────────────────────────────────────────────────────────────
{
  const expired = verifyInferenceToken(minted.token!, { secret: SECRET, now: NOW + DEFAULT_TTL_SECONDS + 1 });
  check("an expired token is refused", !expired.ok && expired.reason === "expired", expired.reason);

  const wrongKey = verifyInferenceToken(minted.token!, { secret: "another-secret-that-is-long-enough!!", now: NOW });
  check("a token signed with another secret is refused", !wrongKey.ok && wrongKey.reason === "bad_signature", wrongKey.reason);

  const tampered = minted.token!.replace(/\.([\w-]{4})/, ".AAAA");
  const tamperResult = verifyInferenceToken(tampered, { secret: SECRET, now: NOW });
  check("a tampered signature is refused", !tamperResult.ok && tamperResult.reason === "bad_signature", tamperResult.reason);

  // Correctly SIGNED, but claiming another scope: this is what someone holding a
  // valid secret-but-wrong-usage would produce, and it must still be refused. The
  // earlier version of this test reused the old signature, so it passed on
  // bad_signature and never exercised the scope check at all.
  const b64 = (v: string) => Buffer.from(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const forgedPayload = b64(JSON.stringify({ sub: "user_42", scope: "admin", iat: NOW, exp: NOW + 600, jti: "x" }));
  const forgedSig = createHmac("sha256", SECRET).update(forgedPayload).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const forged = verifyInferenceToken(`bz1.${forgedPayload}.${forgedSig}`, { secret: SECRET, now: NOW });
  check(
    "a correctly-signed token claiming another scope is refused on the claim",
    !forged.ok && forged.reason === "scope",
    forged.reason,
  );

  const junk = verifyInferenceToken("not-a-token", { secret: SECRET, now: NOW });
  check("junk is refused as malformed", !junk.ok && junk.reason === "malformed", junk.reason);

  const wrongPrefix = minted.token!.replace(/^bz1\./, "bz2.");
  const wrongPrefixResult = verifyInferenceToken(wrongPrefix, { secret: SECRET, now: NOW });
  check("another token version is refused", !wrongPrefixResult.ok && wrongPrefixResult.reason === "malformed", wrongPrefixResult.reason);
}

// ── ttl bounds ──────────────────────────────────────────────────────────────
{
  const longLived = mintInferenceToken({ userId: "user_42", secret: SECRET, now: NOW, ttlSeconds: 999_999 });
  check("a long ttl is capped", longLived.claims?.exp === NOW + MAX_TTL_SECONDS, `${(longLived.claims?.exp ?? 0) - NOW}s`);

  const tiny = mintInferenceToken({ userId: "user_42", secret: SECRET, now: NOW, ttlSeconds: 1 });
  check("a tiny ttl is floored at a minute", tiny.claims?.exp === NOW + 60, `${(tiny.claims?.exp ?? 0) - NOW}s`);

  const anonymous = mintInferenceToken({ userId: "  ", secret: SECRET });
  check("a token cannot be minted for nobody", !anonymous.ok && /user is required/.test(anonymous.error ?? ""), anonymous.error);
}

// ── the client never guesses the endpoint ───────────────────────────────────
{
  const endpoint = inferenceEndpoint();
  check("the endpoint is our inference API", /^https:\/\//.test(endpoint.baseUrl) && !endpoint.baseUrl.endsWith("/"), endpoint.baseUrl);
  check("the endpoint names a model", Boolean(endpoint.model), endpoint.model);

  process.env.BZ_INFERENCE_BASE_URL = "https://proxy.internal/v1///";
  const trimmed = inferenceEndpoint();
  check("a configured endpoint is normalised", trimmed.baseUrl === "https://proxy.internal/v1", trimmed.baseUrl);
  delete process.env.BZ_INFERENCE_BASE_URL;
}

// ── scopes: one token, one capability ───────────────────────────────────────
{
  const inference = mintInferenceToken({ userId: "user_42", secret: SECRET, now: NOW, scope: "inference" });
  const search = mintInferenceToken({ userId: "user_42", secret: SECRET, now: NOW, scope: "search" });

  check("a search-scoped token can be minted", search.ok && search.claims?.scope === "search", search.error);
  check(
    "an inference token verifies for inference",
    verifyInferenceToken(inference.token!, { secret: SECRET, now: NOW, scope: "inference" }).ok === true,
  );
  check(
    "an inference token is REFUSED for search (no quota crossover)",
    verifyInferenceToken(inference.token!, { secret: SECRET, now: NOW, scope: "search" }).reason === "scope",
  );
  check(
    "a search token is REFUSED for inference",
    verifyInferenceToken(search.token!, { secret: SECRET, now: NOW, scope: "inference" }).reason === "scope",
  );
  check(
    "a search token verifies for search",
    verifyInferenceToken(search.token!, { secret: SECRET, now: NOW, scope: "search" }).ok === true,
  );

  const bogus = mintInferenceToken({ userId: "user_42", secret: SECRET, scope: "admin" as never });
  check("an unknown scope cannot be minted", !bogus.ok, bogus.error);
}

console.log(`\ninference token E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
