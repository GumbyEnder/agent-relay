#!/usr/bin/env node
/**
 * The whole search chain, end to end, with no fakes in the middle that matter:
 *
 *   desktop/local runtime  →  our cloud gateway  →  "Brave"
 *
 * Only Brave is faked (there is no Brave key on this host). Everything else is the
 * real code: the local runtime asks OUR gateway with a minted search-scoped token,
 * the gateway verifies it and spends the server-side key.
 *
 * This is the composition that neither repo's own tests prove: the client test fakes
 * the gateway, and the gateway test fakes the client. A URL or token-format mismatch
 * between them would pass both and fail here.
 *
 * Env: BZ_LOCAL_ROOT (default ~/agents/agent-relay-local), BZ_TEST_KEY (model key).
 * Run: node scripts/test-desktop-to-gateway.mjs
 */
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = process.env.BZ_LOCAL_ROOT || join(homedir(), "agents", "agent-relay-local");
const SECRET = "test-signing-secret-that-is-long-enough-for-hs256";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(LOCAL, "scripts", "beezilla-local.mjs"))) {
  console.log(`SKIP  local worktree not found at ${LOCAL}`);
  process.exit(0);
}

// ── fake Brave ──────────────────────────────────────────────────────────────
const braveCalls = [];
const brave = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  braveCalls.push({ q: url.searchParams.get("q"), token: String(req.headers["x-subscription-token"] ?? "") });
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      web: {
        results: [
          { title: "Oviedo Pressure Pros", url: "https://example.com/oviedo-pros", description: "Driveways, roofs, patios. (407) 555-0101." },
        ],
      },
    }),
  );
});
await new Promise((r) => brave.listen(0, "127.0.0.1", r));
const braveUrl = `http://127.0.0.1:${brave.address().port}/res/v1/web/search`;

// ── the real gateway ────────────────────────────────────────────────────────
const gwPort = 8400 + Math.floor(Math.random() * 200);
const gwDir = mkdtempSync(join(tmpdir(), "bz-gwchain-"));
const gateway = spawn(process.execPath, [join(ROOT, ".output", "server", "index.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    BZ_DATA_DIR: gwDir,
    PORT: String(gwPort),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    BZ_INFERENCE_SIGNING_KEY: SECRET,
    BZ_BRAVE_KEY: "BSA-gateway-only-key",
    BZ_BRAVE_URL: braveUrl,
  },
  stdio: "ignore",
});
const gwBase = `http://127.0.0.1:${gwPort}`;
let gwUp = false;
for (let i = 0; i < 60 && !gwUp; i++) {
  try {
    const res = await fetch(`${gwBase}/`, { signal: AbortSignal.timeout(1200) });
    gwUp = res.status < 500;
  } catch {}
  if (!gwUp) await sleep(500);
}
check("the gateway boots", gwUp, gwBase);

// A search-scoped token, minted the way the gateway expects.
const now = Math.floor(Date.now() / 1000);
const head = Buffer.from(JSON.stringify({ sub: "user_chain", scope: "search", iat: now, exp: now + 600, jti: "chain" })).toString("base64url");
const token = `bz1.${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;

// ── the local runtime, pointed at it ────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "bz-chain-"));
const local = spawn(process.execPath, [join(LOCAL, "scripts", "beezilla-local.mjs")], {
  cwd: LOCAL,
  env: {
    ...process.env,
    BZ_RUNTIME: "local",
    BZ_DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    BZ_SEARCH_GATEWAY_URL: `${gwBase}/api/search`,
    BZ_SEARCH_TOKEN: token,
    BZ_BRAVE_KEY: "",
    ...(process.env.BZ_TEST_KEY ? { BZ_CHAT_KEY: process.env.BZ_TEST_KEY } : {}),
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
check("the local runtime boots", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");

if (rt) {
  const status = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/search-status`, {
    headers: { authorization: `Bearer ${rt.token}` },
  }).then((r) => r.json());
  check("the runtime reports our search as the provider", status.provider === "beezilla", JSON.stringify(status));

  if (process.env.BZ_TEST_KEY) {
    const reply = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Search the web for pressure washing in Oviedo FL and tell me one company you find.", fresh: true }),
      signal: AbortSignal.timeout(120_000),
    }).then((r) => r.json());
    const text = String(reply.reply ?? "");
    check("the turn answered", reply.ok !== false, String(reply.code ?? "ok"));
    check("the request travelled through OUR gateway to Brave", braveCalls.length > 0, `${braveCalls.length} Brave call(s)`);
    check("the gateway's key (not the client's) reached Brave", braveCalls.at(-1)?.token === "BSA-gateway-only-key", String(braveCalls.at(-1)?.token ?? "none"));
    check("the answer uses the result the gateway returned", /oviedo-pros|Oviedo Pressure Pros/i.test(text), text.slice(0, 110).replace(/\n/g, " "));
  } else {
    console.log("SKIP  live turn (no BZ_TEST_KEY)");
  }
}

local.kill("SIGTERM");
gateway.kill("SIGTERM");
await sleep(2000);
rmSync(dataDir, { recursive: true, force: true });
rmSync(gwDir, { recursive: true, force: true });
brave.close();
console.log(`\ndesktop→gateway search chain: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
