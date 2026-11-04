#!/usr/bin/env node
/**
 * E2E: "Connect BeeZilla account" — the desktop half of OUR inference.
 *
 * A fake BeeZilla cloud stands in for app.beezilla.ai, so this proves the real
 * contract without needing a deployed server, a database, or a signed-in cookie:
 *
 *   1. The window opens OUR /connect page, and the token is minted INSIDE that page
 *      (the session cookie must never be copied into our process).
 *   2. A signed-out first attempt (401) keeps the window open and picks the token up
 *      as soon as sign-in lands (a second mint succeeds).
 *   3. The token lands in the credential store as provider "beezilla", with the
 *      expiry the cloud published — so the app later says "reconnect", not "bad key".
 *   4. A 503 (no signing secret on the deployment) is reported as OUR problem, not
 *      as anything the user can fix; nothing is saved.
 *
 * Run: node scripts/test-desktop-connect.mjs   (SKIPs without xvfb-run)
 */
import { createServer } from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = join(ROOT, "desktop", "node_modules", ".bin", "electron");
const hasXvfb = (() => {
  try {
    execFileSync("which", ["xvfb-run"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const { CONNECT_PATH } = await import("../desktop/connect.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!hasXvfb) {
  console.log("SKIP  connect E2E needs xvfb-run (headless display)");
  process.exit(0);
}

// ── pure interpretation, first (no display needed) ──────────────────────────
{
  const { interpretMintResult } = await import("../desktop/connect.mjs");
  check("401 means 'sign in', not 'error'", interpretMintResult({ status: 401, body: { code: "unauthenticated" } }).needsSignIn === true);
  check("503 is reported as our configuration problem", /not configured|not available/.test(interpretMintResult({ status: 503, body: { code: "not_configured", error: "inference tokens are not configured" } }).error ?? ""));
  check("a token is accepted with its expiry", interpretMintResult({ status: 200, body: { ok: true, token: "bz1.x.y", expiresAt: "2030-01-01T00:00:00.000Z" } }).expiresAt === "2030-01-01T00:00:00.000Z");
  check("garbage is refused, not crashed", interpretMintResult("not json").ok === false);
}

// ── the cloud address a shipped app uses (pure) ────────────────────────────
{
  const { cloudBaseUrl, DEFAULT_CLOUD_URL } = await import("../desktop/connect.mjs");
  const saved = process.env.BZ_CLOUD_URL;
  delete process.env.BZ_CLOUD_URL;
  check("a normal install has a default BeeZilla address", cloudBaseUrl() === DEFAULT_CLOUD_URL, cloudBaseUrl());
  check("the default is a live https host, not a hopeful one", /^https:\/\/[a-z0-9.-]+$/.test(DEFAULT_CLOUD_URL) && !/app\.beezilla\.ai$/.test(DEFAULT_CLOUD_URL), DEFAULT_CLOUD_URL);
  process.env.BZ_CLOUD_URL = "https://staging.beezilla.ai/";
  check("an env override still wins, trailing slash trimmed", cloudBaseUrl() === "https://staging.beezilla.ai", cloudBaseUrl());
  delete process.env.BZ_CLOUD_URL;
  check("a non-http address is refused", (() => { try { cloudBaseUrl("ftp://nope"); return false; } catch { return true; } })());
  if (saved === undefined) delete process.env.BZ_CLOUD_URL;
  else process.env.BZ_CLOUD_URL = saved;
}

// ── an unreachable BeeZilla must fail fast, in words a user can act on ─────
{
  const { connectAccount, isUnreachable, DEFAULT_CLOUD_URL } = await import("../desktop/connect.mjs");
  const started = Date.now();
  const result = await connectAccount({
    baseUrl: "https://app.beezilla.ai",
    open: async (url) => {
      // Exactly what Electron throws when the host does not resolve.
      throw new Error(`ERR_NAME_NOT_RESOLVED (-105) loading '${url}'`);
    },
    evaluate: async () => null,
    isOpen: () => true,
    close: () => {},
    signInDeadlineMs: 180_000,
    pollMs: 2_000,
  });
  const elapsed = Date.now() - started;
  check("an unreachable host is recognised", isUnreachable(new Error("ERR_NAME_NOT_RESOLVED (-105)")), "classified");
  check("an unreachable host fails immediately", elapsed < 2000, `${elapsed}ms (not the 180s sign-in wait)`);
  check("it is reported as unreachable", result.unreachable === true, JSON.stringify(result));
  check("the message names BeeZilla, not an Electron code", /could not reach BeeZilla at app\.beezilla\.ai/.test(result.error) && !/ERR_/.test(result.error), result.error);
  // The default host itself must answer, or every install starts at a dead end.
  const live = await fetch(`${DEFAULT_CLOUD_URL}/api/inference-token`, { method: "POST", signal: AbortSignal.timeout(20000) })
    .then((r) => ({ status: r.status, body: r.text() }))
    .catch((err) => ({ status: 0, body: Promise.resolve(String(err)) }));
  const liveBody = await live.body;
  check("the default BeeZilla host is really answering (mint = 401, not a 404 page)", live.status === 401 && /unauthenticated/.test(liveBody), `status ${live.status}: ${String(liveBody).slice(0, 70)}`);
  check("the message offers BYOK as the way forward", /your own API key/i.test(result.error), "byok offered");
}

// ── the search half of the answer (pure) ───────────────────────────────────
{
  const { interpretSearchMintResult } = await import("../desktop/connect.mjs");
  check("a search token is accepted", interpretSearchMintResult({ status: 200, body: { ok: true, token: "bz1.s.p", endpoint: "https://search.beezilla.ai" } }).ok === true);
  check("a 503 for search means 'not deployed', not 'failed'", interpretSearchMintResult({ status: 503, body: { code: "not_configured" } }).notDeployed === true);
  check("a search token without an endpoint is not stored", interpretSearchMintResult({ status: 200, body: { ok: true, token: "bz1.s.p" } }).ok === true);
}

// ── a fake BeeZilla cloud ───────────────────────────────────────────────────
let mintCalls = 0;
let searchCalls = 0;
let mode = "signin"; // "signin" = 401 then 200 | "notconfigured" = 503
let searchMode = "ok"; // "ok" | "notconfigured"
const cloud = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === CONNECT_PATH) {
    // The real page needs nothing special: the mint script runs against it.
    res.writeHead(200, { "content-type": "text/html" }).end(
      "<!doctype html><title>Connect BeeZilla</title><h1>Sign in to BeeZilla</h1><p>test page</p>",
    );
    return;
  }
  if (url === "/api/inference-token" && req.method === "POST") {
    mintCalls++;
    if (mode === "notconfigured") {
      res.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: false, code: "not_configured", error: "inference tokens are not configured on this deployment (BZ_INFERENCE_SIGNING_KEY)" }),
      );
      return;
    }
    // First attempt is signed out; the second (after our fake "sign-in") works.
    if (mintCalls === 1) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: false, code: "unauthenticated", error: "sign in to use BeeZilla inference" }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        token: "bz1.fake.payload",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        expiresInSeconds: 900,
        baseUrl: "https://inference-api.nousresearch.com/v1",
        model: "z-ai/glm-5.3-flash",
      }),
    );
    return;
  }
  if (url === "/api/search-token" && req.method === "POST") {
    searchCalls++;
    if (searchMode === "notconfigured") {
      res.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: false, code: "not_configured", error: "BeeZilla search is not deployed yet (BZ_SEARCH_GATEWAY_URL)" }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        token: "bz1.search.payload",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        expiresInSeconds: 900,
        endpoint: "https://search.beezilla.ai/v1/search",
      }),
    );
    return;
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => cloud.listen(0, "127.0.0.1", r));
const cloudBase = `http://127.0.0.1:${cloud.address().port}`;

const runConnect = (dataDir, testMode) =>
  new Promise((resolveRun) => {
    const child = execFile(
      "xvfb-run",
      ["-a", ELECTRON, "desktop", "--no-sandbox", "--disable-gpu"],
      {
        cwd: ROOT,
        timeout: 150_000,
        env: {
          ...process.env,
          BZ_DATA_DIR: dataDir,
          BZ_CONNECT_TEST: "1",
          BZ_CONNECT_MODE: testMode,
          BZ_CLOUD_URL: cloudBase,
          BZ_CONNECT_DEADLINE_MS: "30000",
          BZ_CHAT_KEY: "",
          ELECTRON_ENABLE_LOGGING: "0",
        },
      },
      (err, stdout, stderr) => resolveRun({ err, out: `${stdout}\n${stderr}` }),
    );
    void child;
  });

const readSearchStore = (dataDir) => {
  const file = join(dataDir, "search.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed?.managedTokenCipher ? parsed : null;
  } catch {
    return null;
  }
};

const readStore = (dataDir) => {
  const file = join(dataDir, "inference.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// ── 1. signed out, then signs in ────────────────────────────────────────────
let dataDir = mkdtempSync(join(tmpdir(), "bz-connect-"));
{
  const { out } = await runConnect(dataDir, "signin");
  const line = out.split("\n").find((l) => l.includes("CONNECT_RESULT:")) ?? "";
  let result = null;
  try {
    result = JSON.parse(line.slice(line.indexOf("CONNECT_RESULT:") + "CONNECT_RESULT:".length));
  } catch {}

  check("the fake cloud was asked for a token", mintCalls >= 2, `${mintCalls} mint call(s)`);
  check("a signed-out first attempt is retried after sign-in", result?.ok === true, result?.error ?? line.slice(0, 80));
  check("the token is not echoed in the log", !out.includes("bz1.fake.payload"), out.includes("bz1.fake.payload") ? "LEAKED" : "redacted");

  const store = readStore(dataDir);
  check("the token is stored as BeeZilla inference", store?.provider === "beezilla", store?.provider);
  check("the store keeps the cloud's expiry", Boolean(store?.expiresAt), store?.expiresAt);
  check("the store records our endpoint", String(store?.baseUrl ?? "").includes("inference-api"), store?.baseUrl);
  check("the token is never written in the clear", !JSON.stringify(store ?? {}).includes("bz1.fake.payload"), "encrypted at rest");

  // the search half travels with the same sign-in
  const searchStore = readSearchStore(dataDir);
  check("a search token is minted in the same sign-in", result?.search?.ok === true, result?.search?.error ?? "ok");
  check("the search token is stored for later turns", Boolean(searchStore?.managedTokenCipher), searchStore ? "stored" : "missing");
  check("the search gateway is recorded", String(searchStore?.gateway ?? "").includes("beezilla.ai"), searchStore?.gateway);
  check("the search token is never written in the clear", !JSON.stringify(searchStore ?? {}).includes("bz1.search.payload"), "encrypted at rest");
}

// ── 2. a deployment with no signing secret ──────────────────────────────────
{
  mintCalls = 0;
  mode = "notconfigured";
  dataDir = mkdtempSync(join(tmpdir(), "bz-connect-nc-"));
  const { out } = await runConnect(dataDir, "notconfigured");
  const line = out.split("\n").find((l) => l.includes("CONNECT_RESULT:")) ?? "";
  let result = null;
  try {
    result = JSON.parse(line.slice(line.indexOf("CONNECT_RESULT:") + "CONNECT_RESULT:".length));
  } catch {}
  check("a 503 is refused", result?.ok !== true, result?.error);
  check("the 503 message names the deployment, not the user", /not configured|not available/i.test(String(result?.error ?? "")), String(result?.error ?? "").slice(0, 80));
  check("nothing is saved when minting fails", readStore(dataDir) === null, readStore(dataDir) ? "store written" : "no store");
}

// ── 3. inference works, search is not deployed ─────────────────────────────
{
  mintCalls = 0;
  searchCalls = 0;
  mode = "signin";
  searchMode = "notconfigured";
  dataDir = mkdtempSync(join(tmpdir(), "bz-connect-nosearch-"));
  const { out } = await runConnect(dataDir, "signin");
  const line = out.split("\n").find((l) => l.includes("CONNECT_RESULT:")) ?? "";
  let result = null;
  try {
    result = JSON.parse(line.slice(line.indexOf("CONNECT_RESULT:") + "CONNECT_RESULT:".length));
  } catch {}

  check("sign-in still succeeds when search is missing", result?.ok === true, result?.error ?? line.slice(0, 60));
  check("the search failure is reported as 'not deployed'", result?.search?.notDeployed === true, JSON.stringify(result?.search ?? {}).slice(0, 80));
  check("inference is still stored", readStore(dataDir)?.provider === "beezilla", readStore(dataDir)?.provider ?? "none");
  check("no search credential is invented", readSearchStore(dataDir) === null, readSearchStore(dataDir) ? "store written" : "no search store");
  check("the app says so in its log", /search is not enabled/.test(out), "logged");
}
searchMode = "ok";

cloud.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\ndesktop connect E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
