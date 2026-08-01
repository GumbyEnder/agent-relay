/**
 * Production-ready multi-operator suite:
 * roles/gates, stale heartbeat, skill poll routing, github settings path helpers.
 * Drives shipped modules — no reimplementation.
 */
import assert from "node:assert/strict";
import {
  gateCapability,
  parseEmailList,
  resolveOperatorRole,
  roleCan,
  type OperatorRole,
} from "../src/lib/auth/roles";
import {
  checkOperatorCapability,
  humanAuthRequired,
  type OperatorContext,
} from "../src/lib/auth/verify.server";
import {
  classifyMissionHealth,
  isStaleMission,
  listStaleMissions,
  staleSummary,
  DEFAULT_STALE_HEARTBEAT_MS,
} from "../src/lib/stale-heartbeat";
import { pollMissions, type BoardData } from "../src/lib/board-engine";
import type { Agent, Mission } from "../src/lib/types";
import { verifyGitHubSignature, signGitHubBody } from "../src/lib/github-webhook";
import { mapGitHubIssueToMission, githubExternalId } from "../src/lib/github-ingest";
import { buildReplyWebhookPayload } from "../src/lib/reply-webhook";
import { historyToCsv, historyToJson } from "../src/lib/audit-export";
import { createApiKeyMaterial, verifyApiKeyAgainstHashes } from "../src/lib/api-keys";
import { GROK_PROVIDERS } from "../src/lib/auth/providers";

function mission(partial: Partial<Mission> & Pick<Mission, "id" | "title" | "column">): Mission {
  const now = Date.now();
  return {
    projectId: "proj_default",
    objective: "o",
    context: "",
    constraints: "",
    acceptance: "",
    priority: "p2",
    tags: [],
    assigneeId: null,
    claimedBy: null,
    claimedAt: null,
    lastHeartbeat: null,
    progressNote: "",
    artifacts: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

function agent(partial: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    harness: "custom",
    role: "worker",
    status: "online",
    skills: [],
    lastHeartbeat: Date.now(),
    currentMissionId: null,
    notes: "",
    ...partial,
  };
}

function emptyBoard(over: Partial<BoardData> = {}): BoardData {
  return {
    agents: [],
    missions: [],
    events: [],
    calls: [],
    ...over,
  };
}

// --- roles ---
{
  assert.equal(roleCan("viewer", "read"), true);
  assert.equal(roleCan("viewer", "write_board"), false);
  assert.equal(roleCan("viewer", "manage_keys"), false);
  assert.equal(roleCan("operator", "write_board"), true);
  assert.equal(roleCan("operator", "reply_call"), true);
  assert.equal(roleCan("operator", "manage_keys"), false);
  assert.equal(roleCan("admin", "manage_keys"), true);
  assert.equal(roleCan("admin", "manage_settings"), true);

  const gOut = gateCapability(null, "read", { authRequired: true });
  assert.equal(gOut.ok, false);
  assert.equal(gOut.reason, "signed_out");

  const gView = gateCapability("viewer", "manage_keys", { authRequired: true });
  assert.equal(gView.ok, false);
  assert.equal(gView.reason, "forbidden");

  const gOp = gateCapability("operator", "write_board", { authRequired: true });
  assert.equal(gOp.ok, true);

  const open = gateCapability(null, "manage_keys", { authRequired: false });
  assert.equal(open.ok, true);
  assert.equal(open.role, "admin");

  const emails = parseEmailList("A@x.com, b@y.com  c@z.com");
  assert.ok(emails.has("a@x.com") && emails.has("b@y.com") && emails.has("c@z.com"));

  const role = resolveOperatorRole({
    userId: "u1",
    email: "boss@corp.test",
    adminEmails: ["boss@corp.test"],
    defaultRole: "viewer",
  });
  assert.equal(role, "admin");

  const roleDb = resolveOperatorRole({
    userId: "u2",
    email: "x@y.test",
    dbRole: "viewer",
    adminEmails: ["x@y.test"],
  });
  assert.equal(roleDb, "viewer", "db role wins over email lists");

  // checkOperatorCapability shipped path
  const signedOut: OperatorContext = { user: null, role: null, authRequired: true };
  const denied = checkOperatorCapability(signedOut, "write_board");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 401);

  const viewerCtx: OperatorContext = {
    user: { id: "v", email: "v@t.test" },
    role: "viewer",
    authRequired: true,
  };
  const noKeys = checkOperatorCapability(viewerCtx, "manage_keys");
  assert.equal(noKeys.ok, false);
  if (!noKeys.ok) assert.equal(noKeys.status, 403);

  const adminCtx: OperatorContext = {
    user: { id: "a", email: "a@t.test" },
    role: "admin",
    authRequired: true,
  };
  assert.equal(checkOperatorCapability(adminCtx, "manage_keys").ok, true);

  const local: OperatorContext = {
    user: { id: "dev-user", email: "dev@example.com" },
    role: "admin",
    authRequired: false,
  };
  assert.equal(checkOperatorCapability(local, "manage_settings").ok, true);

  assert.ok(GROK_PROVIDERS.some((p) => p.idp === "github"), "GitHub provider offered");
  console.log("✓ auth roles + gates");
}

// humanAuthRequired respects env override + deploy URL default
{
  assert.equal(humanAuthRequired({ AGENT_RELAY_HUMAN_AUTH: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(humanAuthRequired({ AGENT_RELAY_HUMAN_AUTH: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(
    humanAuthRequired({ VITE_AUTH_ENABLED: "false", BETTER_AUTH_URL: "https://x.test" } as NodeJS.ProcessEnv),
    false,
  );
  // Without BETTER_AUTH_URL, preview client alone must not force gates
  assert.equal(humanAuthRequired({} as NodeJS.ProcessEnv), false);
  console.log("✓ humanAuthRequired env");
}

// --- stale heartbeat ---
{
  const now = 1_000_000;
  const fresh = mission({
    id: "m1",
    title: "fresh",
    column: "running",
    claimedBy: "a1",
    claimedAt: now - 60_000,
    lastHeartbeat: now - 30_000,
  });
  const stale = mission({
    id: "m2",
    title: "stale",
    column: "running",
    claimedBy: "a1",
    claimedAt: now - DEFAULT_STALE_HEARTBEAT_MS - 10_000,
    lastHeartbeat: now - DEFAULT_STALE_HEARTBEAT_MS - 5_000,
  });
  const ready = mission({ id: "m3", title: "ready", column: "ready" });
  assert.equal(classifyMissionHealth(fresh, now), "ok");
  assert.equal(classifyMissionHealth(stale, now), "stale");
  assert.equal(isStaleMission(stale, now), true);
  assert.equal(classifyMissionHealth(ready, now), "n/a");
  const list = listStaleMissions([fresh, stale, ready], now);
  assert.deepEqual(
    list.map((m) => m.id),
    ["m2"],
  );
  const sum = staleSummary([fresh, stale, ready], now);
  assert.equal(sum.staleCount, 1);
  assert.ok(sum.staleIds.includes("m2"));
  console.log("✓ stale heartbeat");
}

// --- skill / tag poll routing ---
{
  const board = emptyBoard({
    agents: [
      agent({ id: "agent_code", name: "Coder", skills: ["code", "tests"] }),
      agent({ id: "agent_docs", name: "Docs", skills: ["docs"] }),
    ],
    missions: [
      mission({ id: "m_code", title: "code work", column: "ready", tags: ["code", "backend"] }),
      mission({ id: "m_docs", title: "docs", column: "ready", tags: ["docs"] }),
      mission({ id: "m_ops", title: "ops", column: "ready", tags: ["ops"] }),
    ],
  });

  const byTag = pollMissions(board, { tags: ["docs"] });
  assert.ok(byTag.ok);
  if (byTag.ok) {
    assert.equal(byTag.data.missions.length, 1);
    assert.equal(byTag.data.missions[0]!.id, "m_docs");
  }

  const bySkill = pollMissions(board, { skills: ["code"] });
  assert.ok(bySkill.ok);
  if (bySkill.ok) {
    assert.equal(bySkill.data.missions.length, 1);
    assert.equal(bySkill.data.missions[0]!.id, "m_code");
  }

  const byAgent = pollMissions(board, { agent: "agent_docs", matchAgentSkills: true });
  assert.ok(byAgent.ok);
  if (byAgent.ok) {
    assert.equal(byAgent.data.missions.length, 1);
    assert.equal(byAgent.data.missions[0]!.id, "m_docs");
  }

  const noFilter = pollMissions(board, { limit: 10 });
  assert.ok(noFilter.ok);
  if (noFilter.ok) assert.equal(noFilter.data.missions.length, 3);
  console.log("✓ skill/tag poll routing");
}

// --- github + keys + webhook + export pure regression ---
{
  const body = JSON.stringify({ ok: true });
  const secret = "whsec_test";
  const sig = signGitHubBody(body, secret);
  assert.equal(verifyGitHubSignature(body, sig, secret), true);
  assert.equal(verifyGitHubSignature(body, "sha256=dead", secret), false);

  const mapped = mapGitHubIssueToMission({
    projectId: "proj_default",
    repository: { full_name: "Acme/App" },
    issue: {
      number: 42,
      title: "Fix",
      body: "body",
      html_url: "https://github.com/Acme/App/issues/42",
      labels: [{ name: "ready-for-agent" }],
    },
  });
  assert.equal(mapped.externalId, githubExternalId("Acme/App", 42));
  assert.equal(mapped.externalId, "github:acme/app#42");

  const mat = createApiKeyMaterial({ id: "key_t", projectId: "proj_default", name: "t" });
  assert.ok(mat.secret.startsWith("ark_"));
  const hit = verifyApiKeyAgainstHashes(mat.secret, [
    {
      id: mat.id,
      projectId: mat.projectId,
      agentId: mat.agentId,
      keyHash: mat.hash,
      revokedAt: null,
    },
  ]);
  assert.ok(hit);

  const payload = buildReplyWebhookPayload({
    callId: "call_1",
    missionId: "msn_1",
    projectId: "proj_default",
    reply: "lgtm",
    agentId: "agent_x",
  });
  assert.equal(payload.type, "call.resolved");
  assert.equal(payload.callId, "call_1");

  const rows = [
    {
      id: "h1",
      missionId: "msn_1",
      projectId: "proj_default",
      actorId: "a",
      actorName: "A",
      actorKind: "agent" as const,
      fromColumn: "ready" as const,
      toColumn: "running" as const,
      at: 1000,
      note: "claim",
    },
    {
      id: "h2",
      missionId: "msn_1",
      projectId: "proj_default",
      actorId: "a",
      actorName: "A",
      actorKind: "agent" as const,
      fromColumn: "running" as const,
      toColumn: "done" as const,
      at: 2000,
      note: "done",
    },
  ];
  const csv = historyToCsv(rows);
  assert.ok(csv.includes("mission_id"));
  assert.ok(csv.split("\n").length >= 3);
  const json = JSON.parse(historyToJson(rows)) as unknown[];
  assert.equal(json.length, 2);
  console.log("✓ github/keys/webhook/export regression");
}

console.log("\nAll prod-ready unit checks passed.");
