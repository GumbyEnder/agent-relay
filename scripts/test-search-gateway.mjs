#!/usr/bin/env node
/**
 * E2E: the search GATEWAY — the piece that lets a desktop install search with OUR
 * Brave key without ever holding it.
 *
 * A fake Brave stands in for the provider, so this proves the gateway's contract
 * rather than Brave's uptime:
 *
 *   - a valid search-scoped token gets results, and OUR key (not the caller's) reaches
 *     the provider;
 *   - an inference token is refused (no quota crossover);
 *   - a tampered/expired/absent token is refused with ONE message, so callers cannot
 *     probe which part was wrong;
 *   - no Brave key on the deployment → 503, and Brave is never called;
 *   - the provider payload is passed through unchanged.
 *
 * Run: node scripts/test-search-gateway.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake Brave ──────────────────────────────────────────────────────────────
const calls = [];
let braveStatus = 200;
const PAYLOAD = {
  web: {
    results: [
      { title: "Gateway result", url: "https://example.com/gw", description: "served through our gateway" },
    ],
  },
};
const brave = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  calls.push({ q: url.searchParams.get("q"), count: url.searchParams.get("count"), token: String(req.headers["x-subscription-token"] ?? "") });
  if (braveStatus !== 200) {
    res.writeHead(braveStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "nope" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(PAYLOAD));
});
await new Promise((r) => brave.listen(0, "127.0.0.1", r));
const braveUrl = `http://127.0.0.1:${brave.address().port}/res/v1/web/search`;

const SECRET = "test-signing-secret-that-is-long-enough-for-hs256";

async function boot(extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bz-gw-"));
  const port = 8300 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [join(ROOT, ".output", "server", "index.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BZ_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      BZ_INFERENCE_SIGNING_KEY: SECRET,
      BZ_BRAVE_KEY: "BSA-server-side-key",
      BZ_BRAVE_URL: braveUrl,
      ...extraEnv,
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return { child, base, dataDir };
    } catch {}
    await sleep(500);
  }
  return { child, base, dataDir };
}

const hit = async (base, qs, headers = {}) => {
  const res = await fetch(`${base}/api/search?${qs}`, { headers });
  return { status: res.status, body: await res.text() };
};

// Token minting mirrors the server's own format, so the test fails if the format drifts.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const mint = (claims) => {
  const { createHmac } = require("node:crypto");
  const head = b64(claims);
  // The signature covers the encoded claims only (the prefix is not signed) — match
  // the server exactly, or every token in this test is "invalid".
  const sig = createHmac("sha256", SECRET).update(head).digest("base64url");
  return `bz1.${head}.${sig}`;
};
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

const now = Math.floor(Date.now() / 1000);
const searchToken = mint({ sub: "user_1", scope: "search", iat: now, exp: now + 600, jti: "t1" });
const inferenceToken = mint({ sub: "user_1", scope: "inference", iat: now, exp: now + 600, jti: "t2" });
const expiredSearch = mint({ sub: "user_1", scope: "search", iat: now - 1200, exp: now - 600, jti: "t3" });

// ── 1. the happy path ───────────────────────────────────────────────────────
{
  const { child, base, dataDir } = await boot();
  const before = calls.length;
  const res = await hit(base, "q=pressure+washing+oviedo&count=3", { authorization: `Bearer ${searchToken}` });
  check("a valid search token gets 200", res.status === 200, `status ${res.status}`);
  check("the provider payload is passed through unchanged", res.body.includes("served through our gateway"), res.body.slice(0, 60));
  check("the provider was called once", calls.length === before + 1, `${calls.length - before} call(s)`);
  check("OUR Brave key went upstream", calls.at(-1)?.token === "BSA-server-side-key", String(calls.at(-1)?.token ?? "none"));
  check("the caller's query reached the provider", /pressure washing oviedo/i.test(calls.at(-1)?.q ?? ""), calls.at(-1)?.q ?? "none");
  check("the count is honoured", calls.at(-1)?.count === "3", calls.at(-1)?.count ?? "none");

  // ── 2. scopes and bad credentials ─────────────────────────────────────────
  const crossed = await hit(base, "q=x", { authorization: `Bearer ${inferenceToken}` });
  check("an inference token is refused (no quota crossover)", crossed.status === 401, `status ${crossed.status}`);
  check("the refusal does not say which part was wrong", /not valid/.test(crossed.body) && !/scope|signature|expired/i.test(crossed.body), crossed.body.slice(0, 70));

  const expired = await hit(base, "q=x", { authorization: `Bearer ${expiredSearch}` });
  check("an expired search token is refused", expired.status === 401, `status ${expired.status}`);

  const tampered = await hit(base, "q=x", { authorization: `Bearer ${searchToken.slice(0, -4)}AAAA` });
  check("a tampered token is refused", tampered.status === 401, `status ${tampered.status}`);

  const none = await hit(base, "q=x");
  check("no token is refused", none.status === 401, `status ${none.status}`);

  const empty = await hit(base, "q=", { authorization: `Bearer ${searchToken}` });
  check("an empty query is a 400, not a provider call", empty.status === 400, `status ${empty.status}`);

  // ── 3. provider failure is named, not swallowed ───────────────────────────
  braveStatus = 429;
  const limited = await hit(base, "q=x", { authorization: `Bearer ${searchToken}` });
  check("a rate limit is reported as rate limited", limited.status === 429 && /rate limited/.test(limited.body), `status ${limited.status}`);
  braveStatus = 200;

  child.kill("SIGTERM");
  await sleep(1500);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 4. no Brave key on the deployment ───────────────────────────────────────
{
  const { child, base, dataDir } = await boot({ BZ_BRAVE_KEY: "" });
  const before = calls.length;
  const res = await hit(base, "q=anything", { authorization: `Bearer ${searchToken}` });
  check("no provider key fails closed with 503", res.status === 503, `status ${res.status}`);
  check("...and Brave is never called", calls.length === before, `${calls.length - before} call(s)`);
  check("the 503 blames the deployment, not the token", /deployment/.test(res.body), res.body.slice(0, 70));
  child.kill("SIGTERM");
  await sleep(1500);
  rmSync(dataDir, { recursive: true, force: true });
}

brave.close();
console.log(`\nsearch gateway E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
