/**
 * P0–P2: keys, filters, github hmac/artifact, reply webhook, mcp tools, keyboard, audit.
 */
import { createServer } from "node:http";
import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { verifyApiKeyAgainstHashes, createApiKeyMaterial, hashApiKey } from "../src/lib/api-keys";
import { filterEvents, filterHistory, filterMissionsByTag } from "../src/lib/filters";
import { verifyGitHubSignature, signGitHubBody } from "../src/lib/github-webhook";
import { extractArtifactFromGitHubPayload } from "../src/lib/github-ingest";
import { buildReplyWebhookPayload, dispatchReplyWebhook } from "../src/lib/reply-webhook";
import { historyToCsv, historyToJson } from "../src/lib/audit-export";
import { matchKeyboardAction, adjacentColumn, KEYBOARD_BINDINGS } from "../src/lib/keyboard-ops";
import { handleMcpTool, memoryBoardOps, MCP_TOOL_NAMES } from "../src/mcp/tools";
import { SEED_AGENTS, SEED_MISSIONS, SEED_EVENTS, SEED_CALLS, DEFAULT_PROJECT_ID } from "../src/lib/seed";
import type { MissionEvent, MissionHistoryEntry, Mission } from "../src/lib/types";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function main() {
  // --- keys pure ---
  const mat = createApiKeyMaterial({ id: "key_t", projectId: "proj_default", name: "t" });
  assert(mat.secret.startsWith("ark_"), "prefix");
  const hit = verifyApiKeyAgainstHashes(mat.secret, [
    { id: mat.id, keyHash: mat.hash, revokedAt: null, projectId: mat.projectId, agentId: null },
  ]);
  assert(hit?.id === mat.id, "verify hit");
  assert(
    !verifyApiKeyAgainstHashes(mat.secret, [
      { id: mat.id, keyHash: mat.hash, revokedAt: Date.now(), projectId: mat.projectId, agentId: null },
    ]),
    "revoked rejected",
  );
  console.log("✓ api-keys pure");

  // --- filters pure ---
  const events: MissionEvent[] = [
    { id: "e1", missionId: "m1", agentId: "agent_lens", kind: "heartbeat", message: "tick", at: 1 },
    { id: "e2", missionId: "m2", agentId: "agent_forge", kind: "mission_claimed", message: "claimed", at: 2 },
  ];
  assert(filterEvents(events, { agentId: "agent_lens" }).length === 1, "filter agent");
  assert(filterEvents(events, { kind: "claim" }).length === 1, "filter kind");
  const hist: MissionHistoryEntry[] = [
    {
      id: "h1",
      missionId: "m1",
      actorId: "agent_lens",
      actorName: "lens",
      actorKind: "agent",
      fromColumn: "ready",
      toColumn: "running",
      at: 1,
    },
    {
      id: "h2",
      missionId: "m1",
      actorId: "op",
      actorName: "operator",
      actorKind: "operator",
      fromColumn: "running",
      toColumn: "review",
      at: 2,
    },
  ];
  assert(filterHistory(hist, { kind: "operator" }).length === 1, "hist kind");
  const missions = [
    { tags: ["github", "p1"] },
    { tags: ["docs"] },
  ] as Mission[];
  assert(filterMissionsByTag(missions, "github").length === 1, "tag filter");
  console.log("✓ filters");

  // --- github hmac ---
  const body = JSON.stringify({ ok: true });
  const secret = "whsec_test";
  const sig = signGitHubBody(body, secret);
  assert(verifyGitHubSignature(body, sig, secret), "sig ok");
  assert(!verifyGitHubSignature(body, "sha256=deadbeef", secret), "bad sig");
  assert(!verifyGitHubSignature(body, null, secret), "missing sig");
  const art = extractArtifactFromGitHubPayload({
    repository: { full_name: "o/r" },
    pull_request: {
      html_url: "https://github.com/o/r/pull/3",
      number: 3,
      title: "fix",
      body: "Fixes #99",
    },
  });
  assert(art?.url.includes("/pull/3"), "pr url");
  assert(art?.externalId === "github:o/r#99", "fixes link");
  console.log("✓ github hmac + artifact");

  // --- reply webhook payload + dispatch ---
  const payload = buildReplyWebhookPayload({
    callId: "call_1",
    missionId: "msn_1",
    projectId: "proj_default",
    reply: "yes",
    agentId: "agent_x",
  });
  assert(payload.type === "call.resolved" && payload.callId === "call_1", "payload");

  let received: unknown = null;
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received = JSON.parse(data);
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const disp = await dispatchReplyWebhook(`http://127.0.0.1:${port}/hook`, payload);
  assert(disp.ok, "dispatch ok");
  assert((received as { missionId: string }).missionId === "msn_1", "received mission");
  server.close();
  console.log("✓ reply webhook");

  // --- keyboard ---
  assert(KEYBOARD_BINDINGS.length >= 5, "bindings");
  assert(
    matchKeyboardAction({ key: "j", ctrlKey: false, metaKey: false, shiftKey: false }) ===
      "next_column",
    "j",
  );
  assert(
    matchKeyboardAction({ key: "c", ctrlKey: false, metaKey: false, shiftKey: false }) ===
      "claim_selected",
    "c",
  );
  assert(adjacentColumn("ready", 1) === "running", "adj");
  console.log("✓ keyboard");

  // --- audit ---
  const csv = historyToCsv(hist);
  assert(csv.includes("mission_id") && csv.includes("m1"), "csv");
  assert(csv.split("\n").filter(Boolean).length >= 3, "csv rows");
  const js = historyToJson(hist);
  assert(JSON.parse(js).length === 2, "json");
  console.log("✓ audit export");

  // --- MCP tools against memory board ---
  const seedM = structuredClone(SEED_MISSIONS).map((m) => ({
    ...m,
    projectId: m.projectId ?? DEFAULT_PROJECT_ID,
  }));
  const ops = memoryBoardOps({
    agents: structuredClone(SEED_AGENTS),
    missions: seedM,
    events: structuredClone(SEED_EVENTS),
    calls: structuredClone(SEED_CALLS),
  });
  assert(MCP_TOOL_NAMES.length === 5, "five tools");
  const poll = await handleMcpTool(ops, "poll", { column: "ready", limit: 5, agent: "lens" });
  assert(poll.ok, "mcp poll");
  const readyId = (poll.content as { missions: { id: string }[] }).missions[0]?.id;
  assert(readyId, "ready mission");
  const claim = await handleMcpTool(ops, "claim", { mission_id: readyId, agent: "lens" });
  assert(claim.ok, "mcp claim");
  const board = ops.getBoard();
  assert(board.missions.find((m) => m.id === readyId)?.column === "running", "claimed running");
  console.log("✓ mcp tools");

  // --- durable store keys + webhook reply + artifact ---
  await ensureBoardReady();
  await durableBoard.reset();
  const key = await durableBoard.createApiKey({
    projectId: DEFAULT_PROJECT_ID,
    name: "test-key",
    agentId: "agent_lens",
  });
  assert(key.secret.startsWith("ark_"), "issued secret");
  const verified = await durableBoard.verifyPresentedApiKey(key.secret);
  assert(verified?.id === key.id, "store verify");
  await durableBoard.revokeApiKey(key.id);
  assert(!(await durableBoard.verifyPresentedApiKey(key.secret)), "revoked");

  // re-create key for success path
  const key2 = await durableBoard.createApiKey({ projectId: DEFAULT_PROJECT_ID, name: "k2" });
  assert(await durableBoard.verifyPresentedApiKey(key2.secret), "key2");

  await durableBoard.updateProjectSettings(DEFAULT_PROJECT_ID, {
    githubWebhookSecret: "sec123",
    replyWebhookUrl: "http://127.0.0.1:9/hook",
    githubRepo: "o/r",
  });
  const settings = await durableBoard.getProjectSettings(DEFAULT_PROJECT_ID);
  assert(settings.hasGithubSecret && settings.githubRepo === "o/r", "settings");

  // attach artifact
  const snap = await durableBoard.snapshot(DEFAULT_PROJECT_ID);
  const mid = snap.missions[0]!.id;
  const attached = await durableBoard.attachMissionArtifact(mid, "https://example.com/pr/1", "pr");
  assert(attached?.artifacts.includes("https://example.com/pr/1"), "artifact");

  const exp = await durableBoard.exportHistory({ projectId: DEFAULT_PROJECT_ID, format: "csv" });
  assert(exp.count >= 1 && exp.body.includes("mission_id"), "export csv");

  console.log("✓ durable keys/settings/artifact/export");
  console.log("\nAll P0–P2 checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
