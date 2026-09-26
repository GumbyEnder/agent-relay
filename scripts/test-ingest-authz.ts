/**
 * ISSUE 1 class: ingest/github must use the same board gate as POST /missions.
 * Unknown project ids must not persist orphan missions.
 */
import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { handleAgentApiRequest } from "../src/lib/agent-api.server";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function main() {
  await ensureBoardReady();

  const stamp = Date.now().toString(36);
  const allowed = await durableBoard.createProject({
    name: `Ingest allow ${stamp}`,
    slug: `ingest-allow-${stamp}`,
    ownerUserId: `owner_${stamp}`,
  });
  const forbidden = await durableBoard.createProject({
    name: `Ingest deny ${stamp}`,
    slug: `ingest-deny-${stamp}`,
    ownerUserId: `peer_${stamp}`,
  });

  const registered = await durableBoard.registerAgent({
    name: `ingest-bot-${stamp}`,
    harness: "custom",
    role: "client",
    projectId: allowed.id,
  });
  assert(registered.ok, "register agent");
  const agent = registered.data.agent;

  const key = await durableBoard.createApiKey({
    projectId: allowed.id,
    agentId: agent.id,
    name: "ingest-authz",
  });

  const headers = {
    authorization: `Bearer ${key.secret}`,
    "content-type": "application/json",
  };

  const issue = (n: number, title: string) => ({
    number: n,
    title,
    body: "authz probe",
    html_url: `https://github.com/acme/app/issues/${n}`,
    repository: { full_name: "acme/app" },
  });

  const orphan = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/ingest/github", {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: "not_a_real_project",
          ...issue(91001, "orphan probe"),
          repository: { full_name: "acme/app" },
        }),
      }),
    ),
  );
  assert(orphan.status === 400 && orphan.body.code === "unknown_project", "unknown project rejected");
  assert(orphan.body.ok === false, "unknown project not ok");

  const stolen = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/ingest/github", {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: forbidden.id,
          ...issue(91002, "cross-board probe"),
          repository: { full_name: "acme/app" },
        }),
      }),
    ),
  );
  assert(stolen.status === 403 && stolen.body.code === "board_forbidden", "foreign board rejected");

  const createStolen = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/missions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "direct create steal",
          objective: "should 403",
          project: forbidden.id,
        }),
      }),
    ),
  );
  assert(
    createStolen.status === 403 && createStolen.body.code === "board_forbidden",
    "direct create still board-gated",
  );

  const ok = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/ingest/github", {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: allowed.id,
          ...issue(91003, "allowed ingest"),
          repository: { full_name: "acme/app" },
        }),
      }),
    ),
  );
  assert(ok.status === 200 && ok.body.ok === true && ok.body.created === true, "allowed ingest creates");
  const created = ok.body.mission as { projectId?: string };
  assert(created?.projectId === allowed.id, "created on granted board");

  const storeOrphan = await durableBoard
    .ingestGitHubIssue({
      issue: issue(91004, "store orphan"),
      repository: { full_name: "acme/app" },
      projectId: "not_a_real_project",
    })
    .then(() => null)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  assert(storeOrphan && /Unknown project/.test(storeOrphan), "store refuses unknown project");

  const ready = await durableBoard.createMission({
    title: `unowned ${stamp}`,
    objective: "deliver without claim must fail",
    projectId: allowed.id,
    column: "ready",
  });
  assert(ready.ok, "ready mission");
  const delivered = await jsonOf(
    await handleAgentApiRequest(
      new Request(`http://local/api/agent/missions/${ready.data.mission.id}/deliver`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: agent.name, summary: "should fail" }),
      }),
    ),
  );
  assert(delivered.status === 409 && delivered.body.code === "not_claimer", "deliver requires claim");

  const emptyCol = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/missions?column=bogus", { headers }),
    ),
  );
  assert(emptyCol.status === 400 && emptyCol.body.code === "bad_column", "invalid column 400");

  const boards = await jsonOf(
    await handleAgentApiRequest(new Request("http://local/api/agent/boards", { headers })),
  );
  assert(boards.status === 200 && Array.isArray(boards.body.boards), "boards list");
  const listed = boards.body.boards as Array<{ id: string }>;
  assert(
    listed.every((b) => b.id === allowed.id) || listed.some((b) => b.id === allowed.id),
    "agent boards include granted board",
  );
  assert(
    !listed.some((b) => b.id === forbidden.id),
    "agent boards exclude ungranted board",
  );

  const foreignAgent = await durableBoard.registerAgent({
    name: `foreign-bot-${stamp}`,
    harness: "custom",
    role: "client",
    projectId: forbidden.id,
  });
  assert(foreignAgent.ok, "foreign agent");
  const foreignMission = await durableBoard.createMission({
    title: `foreign hist ${stamp}`,
    objective: "other tenant",
    projectId: forbidden.id,
    column: "ready",
  });
  assert(foreignMission.ok, "foreign mission");

  const adminAll = await jsonOf(
    await handleAgentApiRequest(new Request("http://local/api/agent/admin", { headers })),
  );
  assert(adminAll.status === 200 && adminAll.body.ok === true, "ark GET /admin 200");
  const adminMissions = (adminAll.body.missions as Array<{ projectId?: string }>) ?? [];
  assert(
    adminMissions.every((m) => m.projectId === allowed.id),
    "ark GET /admin scoped to key boards, not the fleet",
  );
  assert(
    !adminMissions.some((m) => m.projectId === forbidden.id),
    "ark GET /admin excludes foreign board",
  );
  const adminAgents = (adminAll.body.agents as Array<{ id?: string; boardIds?: string[] }>) ?? [];
  assert(
    adminAgents.every(
      (a) => a.id === agent.id || (a.boardIds ?? []).includes(allowed.id),
    ),
    "ark GET /admin agents scoped to key boards",
  );
  assert(
    !adminAgents.some((a) => a.id === foreignAgent.data.agent.id),
    "ark GET /admin excludes foreign agent",
  );

  const adminDenied = await jsonOf(
    await handleAgentApiRequest(
      new Request(
        `http://local/api/agent/admin?project=${encodeURIComponent(forbidden.id)}`,
        { headers },
      ),
    ),
  );
  assert(adminDenied.status === 404, "ark GET /admin?project=foreign → 404 not 401");
  assert(adminDenied.body.code === "not_found", "foreign admin project 404");

  const adminOk = await jsonOf(
    await handleAgentApiRequest(
      new Request(
        `http://local/api/agent/admin?project=${encodeURIComponent(allowed.id)}`,
        { headers },
      ),
    ),
  );
  assert(adminOk.status === 200 && adminOk.body.ok === true, "ark GET /admin?project=allowed");
  const only = (adminOk.body.missions as Array<{ projectId?: string }>) ?? [];
  assert(
    only.every((m) => m.projectId === allowed.id),
    "allowed admin project is that board only",
  );

  const exportAll = await jsonOf(
    await handleAgentApiRequest(new Request("http://local/api/agent/export", { headers })),
  );
  assert(exportAll.status === 200 && exportAll.body.ok === true, "ark GET /export 200");
  const exportMissions = (exportAll.body.missions as Array<{ projectId?: string }>) ?? [];
  assert(
    exportMissions.every((m) => m.projectId === allowed.id),
    "ark GET /export missions scoped",
  );
  const exportAgents = (exportAll.body.agents as Array<{ id?: string; boardIds?: string[] }>) ?? [];
  assert(
    !exportAgents.some((a) => a.id === foreignAgent.data.agent.id),
    "ark GET /export excludes foreign agent",
  );
  assert(
    exportAgents.every(
      (a) => a.id === agent.id || (a.boardIds ?? []).includes(allowed.id),
    ),
    "ark GET /export agents scoped to key boards",
  );

  const exportDenied = await jsonOf(
    await handleAgentApiRequest(
      new Request(
        `http://local/api/agent/export?project=${encodeURIComponent(forbidden.id)}`,
        { headers },
      ),
    ),
  );
  assert(exportDenied.status === 404, "ark GET /export?project=foreign → 404");

  const csvRes = await handleAgentApiRequest(
    new Request("http://local/api/agent/export?history=1&format=csv", { headers }),
  );
  assert(csvRes.status === 200, "ark history csv 200");
  const csvBody = await csvRes.text();
  assert(!csvBody.includes(forbidden.id), "ark history csv excludes foreign board");
  assert(
    csvBody.includes("mission_id") || csvBody.includes("project_id"),
    "csv has header",
  );

  const histSteal = await jsonOf(
    await handleAgentApiRequest(
      new Request(
        `http://local/api/agent/export?history=1&project=${encodeURIComponent(allowed.id)}&mission=${encodeURIComponent(foreignMission.data.mission.id)}`,
        { headers },
      ),
    ),
  );
  assert(histSteal.status === 404, "history ?mission=foreign 404");

  const boardAll = await jsonOf(
    await handleAgentApiRequest(new Request("http://local/api/agent/board", { headers })),
  );
  assert(boardAll.status === 200 && boardAll.body.ok === true, "ark GET /board 200");
  const boardMissions = (boardAll.body.missions as Array<{ projectId?: string }>) ?? [];
  assert(
    boardMissions.every((m) => m.projectId === allowed.id),
    "ark GET /board missions scoped",
  );
  const boardAgents = (boardAll.body.agents as Array<{ id?: string }>) ?? [];
  assert(
    !boardAgents.some((a) => a.id === foreignAgent.data.agent.id),
    "ark GET /board excludes foreign agent",
  );

  const boardDenied = await jsonOf(
    await handleAgentApiRequest(
      new Request(
        `http://local/api/agent/board?project=${encodeURIComponent(forbidden.id)}`,
        { headers },
      ),
    ),
  );
  assert(boardDenied.status === 404, "ark GET /board?project=foreign → 404");

  const poll = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/missions?limit=2", { headers }),
    ),
  );
  assert(poll.status === 200 && poll.body.ok === true, "GET /missions poll");
  assert(typeof poll.body.total === "number", "poll total");
  assert(poll.body.limit === 2, "poll limit");
  assert(typeof poll.body.truncated === "boolean", "poll truncated");
  const pollHigh = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/missions?limit=5000", { headers }),
    ),
  );
  assert(pollHigh.status === 200, "poll high limit");
  assert(pollHigh.body.limit === 500, "poll cap 500");

  const v1poll = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/v1", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "poll", limit: 2 }),
      }),
    ),
  );
  assert(v1poll.status === 200 && typeof v1poll.body.truncated === "boolean", "POST /v1 poll truncated");
  const v1missions = (v1poll.body.missions as Array<{ projectId?: string }>) ?? [];
  assert(
    v1missions.every((m) => !m.projectId || m.projectId === allowed.id),
    "POST /v1 poll scoped",
  );

  const me = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/me", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    ),
  );
  assert(me.status === 200, "GET /me");
  assert(typeof me.body.githubOAuth === "boolean", "githubOAuth boolean");
  const meRaw = JSON.stringify(me.body);
  assert(!meRaw.includes("GITHUB_CLIENT_ID"), "/me must not leak GITHUB_CLIENT_ID");
  assert(!meRaw.includes("GITHUB_CLIENT_SECRET"), "/me must not leak GITHUB_CLIENT_SECRET");

  const extraBoard = await durableBoard.createProject({
    name: `Ingest extra ${stamp}`,
    slug: `ingest-extra-${stamp}`,
    ownerUserId: `owner_${stamp}`,
  });
  await durableBoard.grantBoardAccess(agent.id, extraBoard.id);
  const noProject = await jsonOf(
    await handleAgentApiRequest(
      new Request("http://local/api/agent/missions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "multi-board create",
          objective: "must name a board",
        }),
      }),
    ),
  );
  assert(noProject.status === 400 && noProject.body.code === "project_required", "multi-board create needs project");

  console.log("✓ ingest/github board gate + no orphans + deliver ownership + column/boards scope");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
