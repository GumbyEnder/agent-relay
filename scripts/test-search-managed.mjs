#!/usr/bin/env node
/**
 * E2E: our own Brave key, without shipping it.
 *
 * The product line is "search works out of the box with our key, and BYOK if you
 * want your own quota". The key itself must never reach a user's machine, so the app
 * calls OUR gateway with a short-lived token instead:
 *
 *   BYOK (BZ_BRAVE_KEY)                -> api.search.brave.com, user's key
 *   ours (BZ_SEARCH_GATEWAY_URL+TOKEN) -> our gateway, bearer token
 *   neither                            -> search unavailable, by name
 *
 * Both providers are faked here, so the test proves ROUTING and headers — the thing
 * that decides whose quota is spent and whose credential is exposed.
 *
 * Run: node scripts/test-search-managed.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hits = { brave: [], gateway: [] };
const body = JSON.stringify({
  web: { results: [{ title: "Managed result", url: "https://example.com/managed", description: "from the gateway" }] },
});

const brave = createServer((req, res) => {
  hits.brave.push({ token: String(req.headers["x-subscription-token"] ?? ""), auth: String(req.headers.authorization ?? ""), url: req.url });
  res.writeHead(200, { "content-type": "application/json" }).end(body);
});
const gateway = createServer((req, res) => {
  hits.gateway.push({ auth: String(req.headers.authorization ?? ""), token: String(req.headers["x-subscription-token"] ?? ""), url: req.url });
  res.writeHead(200, { "content-type": "application/json" }).end(body);
});
await new Promise((r) => brave.listen(0, "127.0.0.1", r));
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const braveUrl = `http://127.0.0.1:${brave.address().port}/res/v1/web/search`;
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}/v1/search`;

async function boot(extraEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), "bz-managed-search-"));
  const child = spawn(process.execPath, [join(ROOT, "scripts", "beezilla-local.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BZ_RUNTIME: "local",
      BZ_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      BZ_BRAVE_URL: braveUrl,
      BZ_BRAVE_KEY: "",
      BZ_SEARCH_GATEWAY_URL: "",
      BZ_SEARCH_TOKEN: "",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  let rt = null;
  for (let i = 0; i < 120 && !rt; i++) {
    try {
      const parsed = JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8"));
      if (parsed?.port) rt = parsed;
    } catch {}
    if (!rt) await sleep(500);
  }
  return { child, dataDir, rt };
}

const status = async (rt) => {
  const res = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/search-status`, {
    headers: { authorization: `Bearer ${rt.token}` },
  });
  return res.json();
};

// ── 1. our gateway, with a token ────────────────────────────────────────────
{
  const { child, dataDir, rt } = await boot({ BZ_SEARCH_GATEWAY_URL: gatewayUrl, BZ_SEARCH_TOKEN: "sess_test_search_token" });
  check("runtime boots with managed search", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");
  if (rt) {
    const s = await status(rt);
    check("search is available via our gateway", s.available === true, JSON.stringify(s));
    check("the provider is named beezilla", s.provider === "beezilla", String(s.provider));
    check("the status never exposes the token", !JSON.stringify(s).includes("sess_test_search_token"), "no token");

    if (process.env.BZ_TEST_KEY) {
      const before = { brave: hits.brave.length, gateway: hits.gateway.length };
      await fetch(`http://${rt.host}:${rt.port}/api/buzzy/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "Search the web for managed search routing and tell me one result.", fresh: true }),
      });
      check("our gateway served the search", hits.gateway.length > before.gateway, `${hits.gateway.length - before.gateway} call(s)`);
      check("Brave was not called directly", hits.brave.length === before.brave, `${hits.brave.length - before.brave} direct call(s)`);
      check(
        "the managed token was sent as a bearer",
        hits.gateway.at(-1)?.auth === "Bearer sess_test_search_token",
        String(hits.gateway.at(-1)?.auth ?? "none"),
      );
      check("no Brave subscription header left the machine", !hits.gateway.at(-1)?.token, "absent");
    } else {
      console.log("SKIP  live turn (no BZ_TEST_KEY)");
    }
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 2. BYOK wins over our gateway ───────────────────────────────────────────
{
  const { child, dataDir, rt } = await boot({
    BZ_SEARCH_GATEWAY_URL: gatewayUrl,
    BZ_SEARCH_TOKEN: "sess_test_search_token",
    BZ_BRAVE_KEY: "BSA-owner-own-key",
  });
  if (rt) {
    const s = await status(rt);
    check("a BYOK key takes precedence", s.provider === "brave", String(s.provider));

    if (process.env.BZ_TEST_KEY) {
      const before = { brave: hits.brave.length, gateway: hits.gateway.length };
      await fetch(`http://${rt.host}:${rt.port}/api/buzzy/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "Search the web for BYOK precedence and tell me one result.", fresh: true }),
      });
      check("the user's own key went to Brave", hits.brave.length > before.brave, `${hits.brave.length - before.brave} call(s)`);
      check("our gateway was left alone", hits.gateway.length === before.gateway, `${hits.gateway.length - before.gateway} call(s)`);
      check("the user's key travelled in the Brave header", hits.brave.at(-1)?.token === "BSA-owner-own-key", String(hits.brave.at(-1)?.token ?? "none"));
      check("no bearer token was sent to Brave", !hits.brave.at(-1)?.auth, "absent");
    }
  } else {
    check("runtime boots with BYOK search", false, "no runtime.json");
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 3. a gateway without a token is not "available" ─────────────────────────
{
  const { child, dataDir, rt } = await boot({ BZ_SEARCH_GATEWAY_URL: gatewayUrl });
  if (rt) {
    const s = await status(rt);
    check("a gateway with no token is reported unavailable", s.available === false && s.provider === null, JSON.stringify(s));
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

brave.close();
gateway.close();
console.log(`\nmanaged search E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
