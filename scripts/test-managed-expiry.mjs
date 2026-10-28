#!/usr/bin/env node
/**
 * E2E: an expired managed (BeeZilla) token must say "reconnect", not "bad key".
 *
 * The failure this prevents is a support ticket: with a real provider, an expired
 * token comes back 401 and the user is told their key is wrong — so they go looking
 * for a key they never had. A managed token is a SESSION, and expiry must be caught
 * before a request is spent.
 *
 *   1. expired token  -> reconnect copy, and the provider is NEVER called
 *   2. valid token    -> the token is actually used against the provider
 *
 * Run: node scripts/test-managed-expiry.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { saveInference } from "./lib/inference.mjs";
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

// ── a provider that records what reached it ─────────────────────────────────
let calls = 0;
let lastAuth = "";
const gateway = createServer((req, res) => {
  calls++;
  lastAuth = String(req.headers.authorization ?? "");
  // Answer like an OpenAI-compatible endpoint so a successful turn completes.
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: "1", choices: [{ delta: { content: "ok" }, index: 0 }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayPort = gateway.address().port;
const gatewayBase = `http://127.0.0.1:${gatewayPort}/v1`;

/** Boot the real launcher against a store we control. */
async function boot(store) {
  const dataDir = mkdtempSync(join(tmpdir(), "bz-managed-"));
  // Use the real writer, not hand-built JSON: the store's field is keyCipher, and a
  // test that invents the shape would test its own mistake.
  if (store) saveInference(dataDir, store);

  const child = spawn(process.execPath, [join(ROOT, "scripts", "beezilla-local.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BZ_RUNTIME: "local",
      BZ_DATA_DIR: dataDir,
      BZ_CHAT_KEY: "",
      HOST: "127.0.0.1",
    },
    stdio: "ignore",
  });

  let rt = null;
  for (let i = 0; i < 120; i++) {
    try {
      const parsed = JSON.parse(
        (await import("node:fs")).readFileSync(join(dataDir, "runtime.json"), "utf8"),
      );
      if (parsed?.port) {
        rt = parsed;
        break;
      }
    } catch {}
    await sleep(500);
  }
  return { child, dataDir, rt };
}

const ask = async (rt, message) => {
  const res = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message, fresh: true }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ── 1. expired managed token ────────────────────────────────────────────────
{
  const before = calls;
  const { child, dataDir, rt } = await boot({
    provider: "beezilla",
    key: "bz-managed-expired-token",
    baseUrl: gatewayBase,
    model: "test-model",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    savedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  check("runtime boots with an expired managed token", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");

  if (rt) {
    const res = await ask(rt, "what can you do?");
    const reply = String(res.body.reply ?? "");
    check("the turn is refused as a session problem", res.body.code === "managed_expired", String(res.body.code));
    check("the copy tells the user to reconnect", /reconnect/i.test(reply), reply.slice(0, 90));
    check("the copy never blames a key", !/api key|invalid key|unauthori[sz]ed/i.test(reply), reply.slice(0, 90));
    check("the copy promises nothing was sent", /nothing was sent/i.test(reply), reply.slice(0, 90));
    check("no request reached the provider", calls === before, `${calls - before} call(s)`);
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 2. a valid managed token is actually used ───────────────────────────────
{
  const before = calls;
  const { child, dataDir, rt } = await boot({
    provider: "beezilla",
    key: "bz-managed-live-token",
    baseUrl: gatewayBase,
    model: "test-model",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    savedAt: new Date().toISOString(),
  });

  if (rt) {
    await ask(rt, "hello");
    check("a valid managed token reaches the provider", calls > before, `${calls - before} call(s)`);
    check("the managed token is sent as the bearer", lastAuth === "Bearer bz-managed-live-token", lastAuth.replace(/[\w-]{12}$/, "…"));
  } else {
    check("runtime boots with a valid managed token", false, "no runtime.json");
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

gateway.close();
console.log(`\nmanaged expiry E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
