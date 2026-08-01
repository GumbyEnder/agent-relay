/**
 * Proves refresh resolves project id before board fetch (criterion 2).
 * Drives the real refresh() path with a stubbed agentApi via dynamic import order:
 * we intercept global fetch used by api-client.
 */
import { create } from "zustand";

const calls: string[] = [];
const projects = [
  {
    id: "proj_default",
    name: "Default",
    slug: "default",
    description: "",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "proj_platform",
    name: "Platform",
    slug: "platform",
    description: "",
    createdAt: 1,
    updatedAt: 1,
  },
];

const defaultMissions = [{ id: "msn_default_only", projectId: "proj_default", column: "ready" }];
const platformMissions = [{ id: "msn_platform_only", projectId: "proj_platform", column: "ready" }];

// Stub fetch before importing store's api-client dependency chain is hard because store already imports agentApi.
// Instead re-implement the FIXED refresh ordering as the store does, importing agentApi after mock — 
// We test by patching agentApi methods on the module.

async function main() {
  const api = await import("../src/lib/api-client");
  const originalBoard = api.agentApi.board;
  const originalList = api.agentApi.listProjects;

  api.agentApi.listProjects = async () => {
    calls.push("listProjects");
    return { ok: true as const, projects };
  };
  api.agentApi.board = async (projectId?: string | null) => {
    calls.push(`board:${projectId ?? "null"}`);
    const missions =
      projectId === "proj_platform" ? platformMissions : defaultMissions;
    return {
      ok: true as const,
      agents: [],
      missions: missions as any,
      events: [],
      calls: [],
    };
  };

  // Import store AFTER stubs (module may already be cached — re-apply stubs then call refresh)
  const { useBoard } = await import("../src/lib/store");
  // Reset state
  useBoard.setState({
    selectedProjectId: null,
    missions: [],
    projects: [],
    agents: [],
    events: [],
    calls: [],
    _hydrated: false,
  });

  // Re-stub in case store closed over original (agentApi is object — method replace works)
  api.agentApi.listProjects = async () => {
    calls.push("listProjects");
    return { ok: true as const, projects };
  };
  api.agentApi.board = async (projectId?: string | null) => {
    calls.push(`board:${projectId ?? "null"}`);
    const missions =
      projectId === "proj_platform" ? platformMissions : defaultMissions;
    return {
      ok: true as const,
      agents: [],
      missions: missions as any,
      events: [],
      calls: [],
    };
  };

  calls.length = 0;
  await useBoard.getState().refresh();
  const st = useBoard.getState();

  if (calls[0] !== "listProjects") {
    throw new Error(`expected listProjects first, got ${JSON.stringify(calls)}`);
  }
  if (calls[1] !== "board:proj_default") {
    throw new Error(`expected scoped board second, got ${JSON.stringify(calls)}`);
  }
  if (st.selectedProjectId !== "proj_default") {
    throw new Error(`selectedProjectId ${st.selectedProjectId}`);
  }
  if (st.missions.some((m) => m.id === "msn_platform_only")) {
    throw new Error("platform mission leaked onto default board after first refresh");
  }
  if (!st.missions.some((m) => m.id === "msn_default_only")) {
    throw new Error("default mission missing");
  }

  // restore
  api.agentApi.board = originalBoard;
  api.agentApi.listProjects = originalList;
  console.log("✓ refresh scopes board on first load", calls);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
