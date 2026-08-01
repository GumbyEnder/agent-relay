#!/usr/bin/env node
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

let r = await req("POST", "/api/agent/reset", {});
assert(r.status === 200 && r.json.ok, `reset failed: ${JSON.stringify(r)}`);
console.log("✓ reset");

r = await req("GET", "/api/agent/health");
assert(r.json.ok && r.json.service === "agent-relay", "health");
console.log("✓ health", r.json.version, r.json.store ?? "");

r = await req("GET", "/api/agent/board");
assert(r.json.ok && Array.isArray(r.json.missions), "board snapshot");
console.log("✓ board snapshot", r.json.missions.length, "missions");

r = await req("GET", "/api/agent/missions?column=ready&limit=5&agent=lens");
assert(r.json.ok && Array.isArray(r.json.missions), "poll");
const mission =
  r.json.missions.find((m) => m.id === "msn_agent_protocol_doc") ?? r.json.missions[0];
assert(mission, "have claimable mission");
console.log("✓ poll", mission.id);

r = await req("POST", `/api/agent/missions/${mission.id}/claim`, { agent: "lens" });
assert(r.status === 200 && r.json.ok, `claim: ${JSON.stringify(r.json)}`);
console.log("✓ claim");

// single-source: board must show claim
r = await req("GET", "/api/agent/board");
const claimed = r.json.missions.find((m) => m.id === mission.id);
assert(claimed?.column === "running", "board shows running after claim");
assert(claimed?.claimedBy, "board shows claimer");
console.log("✓ single-source board after claim", claimed.claimedBy);

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

// history after two status moves (claim + escalate)
r = await req("GET", `/api/agent/missions/${mission.id}/history`);
assert(r.json.ok && Array.isArray(r.json.history), "history endpoint");
assert(r.json.history.length >= 2, `need ≥2 history got ${r.json.history.length}`);
for (const h of r.json.history) {
  assert(h.missionId === mission.id, "history mission id");
  assert(h.toColumn, "to column");
  assert(typeof h.at === "number" || h.at, "timestamp");
  assert(h.actorName || h.actorId || h.actorKind, "actor");
}
console.log("✓ history", r.json.history.length, "entries");
for (const h of r.json.history) {
  console.log(`  ${h.fromColumn ?? "—"} → ${h.toColumn} by ${h.actorName ?? h.actorKind}`);
}

r = await req("POST", `/api/agent/calls/${callId}/reply`, {
  reply: "Approved for smoke.",
});
assert(r.json.ok, "reply");
console.log("✓ human reply");

// operator move via API — UI path equivalent
r = await req("POST", `/api/agent/missions/${mission.id}/move`, {
  column: "running",
  actor: "operator",
});
assert(r.json.ok, "operator move");
r = await req("GET", "/api/agent/board");
const afterMove = r.json.missions.find((m) => m.id === mission.id);
assert(afterMove?.column === "running", "API board after operator move");
console.log("✓ single-source operator move → running");

r = await req("POST", `/api/agent/missions/${mission.id}/deliver`, {
  agent: "lens",
  summary: "smoke complete",
  artifacts: ["scripts/agent-api-smoke.mjs"],
});
assert(r.json.ok && r.json.mission.column === "review", "deliver");
console.log("✓ deliver");

r = await req("POST", "/api/agent/v1", {
  action: "poll",
  column: "ready",
  limit: 3,
  agent: "forge",
});
assert(r.json.ok, "v1 poll");
console.log("✓ POST /v1 action=poll");

console.log("\nAgent API smoke passed against", base);
