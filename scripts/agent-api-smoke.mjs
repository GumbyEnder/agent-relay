#!/usr/bin/env node
/**
 * Smoke the five-verb HTTP API against a running server (default :8080).
 * Usage: node scripts/agent-api-smoke.mjs [baseUrl]
 */
const base = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// reset demo board
let r = await req("POST", "/api/agent/reset", {});
assert(r.status === 200 && r.json.ok, `reset failed: ${JSON.stringify(r)}`);
console.log("✓ reset");

r = await req("GET", "/api/agent/health");
assert(r.json.ok && r.json.service === "agent-relay", "health");
console.log("✓ health", r.json.version);

r = await req("GET", "/api/agent/missions?column=ready&limit=5&agent=lens");
assert(r.json.ok && Array.isArray(r.json.missions), "poll");
const mission = r.json.missions.find((m) => m.id === "msn_agent_protocol_doc") ?? r.json.missions[0];
assert(mission, "have claimable mission");
console.log("✓ poll", mission.id, mission.title);

r = await req("POST", `/api/agent/missions/${mission.id}/claim`, { agent: "lens" });
assert(r.status === 200 && r.json.ok, `claim: ${JSON.stringify(r.json)}`);
console.log("✓ claim");

// double claim
r = await req("POST", `/api/agent/missions/${mission.id}/claim`, { agent: "scout" });
assert(r.status === 409, `expected 409 got ${r.status}`);
console.log("✓ claim conflict 409");

r = await req("POST", `/api/agent/missions/${mission.id}/heartbeat`, {
  agent: "lens",
  note: "api smoke heartbeat",
});
assert(r.json.ok, "heartbeat");
console.log("✓ heartbeat");

r = await req("POST", `/api/agent/missions/${mission.id}/escalate`, {
  agent: "lens",
  question: "Smoke test: approve deliver?",
});
assert(r.json.ok && r.json.call?.id, "escalate");
const callId = r.json.call.id;
console.log("✓ escalate", callId);

r = await req("POST", `/api/agent/calls/${callId}/reply`, {
  reply: "Approved for smoke.",
});
assert(r.json.ok, "reply");
console.log("✓ human reply");

r = await req("POST", `/api/agent/missions/${mission.id}/deliver`, {
  agent: "lens",
  summary: "smoke complete",
  artifacts: ["scripts/agent-api-smoke.mjs"],
});
assert(r.json.ok && r.json.mission.column === "review", "deliver");
console.log("✓ deliver");

// action dispatcher
r = await req("POST", "/api/agent/v1", {
  action: "poll",
  column: "ready",
  limit: 3,
  agent: "forge",
});
assert(r.json.ok, "v1 poll");
console.log("✓ POST /v1 action=poll");

console.log("\nAgent API smoke passed against", base);
