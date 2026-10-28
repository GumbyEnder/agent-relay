#!/usr/bin/env node
/**
 * E2E: web search, end to end — the path a user actually hits.
 *
 * There is no Brave key on this host, so a fake Brave endpoint stands in. That
 * still proves everything the product depends on, which unit tests do not:
 *
 *   1. `search-status` reports the provider without leaking the key.
 *   2. A real turn with a search key reaches the search provider with OUR key in
 *      the right header, and the answer cites what came back.
 *   3. With no key, search is reported unavailable and a turn still answers —
 *      the app must degrade, not fail, when search isn't configured.
 *   4. A provider error is named, never turned into "no such thing exists".
 *
 * Run: BZ_TEST_KEY=… node scripts/test-search-live.mjs   (skips the turn without a key)
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

// ── a fake Brave ────────────────────────────────────────────────────────────
const seen = [];
let braveMode = "ok";
const brave = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  seen.push({ q: url.searchParams.get("q"), token: String(req.headers["x-subscription-token"] ?? "") });
  if (braveMode === "error") {
    res.writeHead(429, { "content-type": "application/json" }).end('{"error":"rate limited"}');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      web: {
        results: [
          {
            title: "Ridgeline Pressure Washing — Oviedo, FL",
            url: "https://example.com/ridgeline",
            description: "Pressure washing and soft washing for driveways, roofs and patios. Call (407) 555-0142.",
          },
          {
            title: "Central Florida Soft Wash",
            url: "https://example.com/cflsoftwash",
            description: "Soft washing specialists serving Seminole County.",
          },
        ],
      },
    }),
  );
});
await new Promise((r) => brave.listen(0, "127.0.0.1", r));
const braveBase = `http://127.0.0.1:${brave.address().port}/res/v1/web/search`;

async function boot(extraEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), "bz-search-"));
  const child = spawn(process.execPath, [join(ROOT, "scripts", "beezilla-local.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BZ_RUNTIME: "local",
      BZ_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      BZ_BRAVE_URL: braveBase,
      // The runtime reads the inference credential from env; the lane provides it as
      // BZ_TEST_KEY, so hand it over under the name the server actually uses.
      ...(process.env.BZ_TEST_KEY ? { BZ_CHAT_KEY: process.env.BZ_TEST_KEY } : {}),
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

const call = async (rt, path, init) => {
  const res = await fetch(`http://${rt.host}:${rt.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ── 1 + 2: configured search, real turn ─────────────────────────────────────
{
  const key = `BSA${Math.random().toString(36).slice(2, 10)}realish`;
  const { child, dataDir, rt } = await boot({ BZ_BRAVE_KEY: key });
  check("runtime boots with search configured", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");

  if (rt) {
    const status = await call(rt, "/api/buzzy/search-status");
    check("search-status reports brave", status.body.available === true && status.body.provider === "brave", JSON.stringify(status.body));
    check("search-status never returns the key", !JSON.stringify(status.body).includes(key), "no key in payload");

    if (process.env.BZ_TEST_KEY) {
      const before = seen.length;
      const turn = await call(rt, "/api/buzzy/chat", {
        method: "POST",
        body: JSON.stringify({ message: "Search the web for pressure washing companies in Oviedo FL and list what you find with links.", fresh: true }),
      });
      const reply = String(turn.body.reply ?? "");
      check("the turn succeeded", turn.body.ok !== false, String(turn.body.code ?? "ok"));
      check("the search provider was called", seen.length > before, `${seen.length - before} search(es)`);
      check("our key was sent in the Brave header", seen.at(-1)?.token === key, `${String(seen.at(-1)?.token ?? "").slice(0, 6)}…`);
      check("the query reached the provider", /pressure washing/i.test(seen.at(-1)?.q ?? ""), seen.at(-1)?.q ?? "none");
      // The model must be able to use what came back: either it links the source or
      // names it. A reply that ignores the results means the tool output never made
      // it into the context.
      //
      // It can also stop after an intermediate "I'll read that first" message — a
      // real (if unlovely) model behaviour, not a search defect. A user would just
      // ask again, so the test does the same ONCE before calling it a failure.
      let replyText = reply;
      let usedResults = /example\.com|ridgeline|cflsoftwash/i.test(replyText);
      if (!usedResults && /^I'?ll (read|check)|let me (read|check|look)|one moment/i.test(replyText.trim())) {
        const again = await call(rt, "/api/buzzy/chat", {
          method: "POST",
          body: JSON.stringify({ message: "Give me the final answer now, with the links.", fresh: false }),
        });
        replyText = String(again.body.reply ?? "");
        usedResults = /example\.com|ridgeline|cflsoftwash/i.test(replyText);
      }
      check("the answer uses the search results", usedResults, replyText.slice(0, 120).replace(/\n/g, " "));
    } else {
      console.log("SKIP  live turn (no BZ_TEST_KEY)");
    }
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 3: no key at all ────────────────────────────────────────────────────────
{
  const { child, dataDir, rt } = await boot({ BZ_BRAVE_KEY: "" });
  if (rt) {
    const status = await call(rt, "/api/buzzy/search-status");
    check("without a key search is reported unavailable", status.body.available === false, JSON.stringify(status.body));

    if (process.env.BZ_TEST_KEY) {
      const turn = await call(rt, "/api/buzzy/chat", {
        method: "POST",
        body: JSON.stringify({ message: "What is 2 plus 2? Answer in one short sentence.", fresh: true }),
      });
      check("a turn still answers without search", turn.body.ok !== false && String(turn.body.reply ?? "").length > 3, String(turn.body.reply ?? "").slice(0, 60));
    }
  } else {
    check("runtime boots without search", false, "no runtime.json");
  }
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 4: the provider failing is named ────────────────────────────────────────
{
  braveMode = "error";
  const { child, dataDir, rt } = await boot({ BZ_BRAVE_KEY: "BSAerrorcase" });
  if (rt && process.env.BZ_TEST_KEY) {
    const turn = await call(rt, "/api/buzzy/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Search the web for today's Oviedo FL weather and give me the high temperature.", fresh: true }),
    });
    const reply = String(turn.body.reply ?? "");
    // A rate-limited provider must not be reported as "nothing found".
    check(
      "a search error is not silently reported as no results",
      !/no results|couldn't find anything|nothing found/i.test(reply) || /error|unavailable|try again|can't search/i.test(reply),
      reply.slice(0, 110).replace(/\n/g, " "),
    );
  }
  braveMode = "ok";
  child.kill("SIGTERM");
  await sleep(2500);
  rmSync(dataDir, { recursive: true, force: true });
}

brave.close();
console.log(`\nsearch live E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
