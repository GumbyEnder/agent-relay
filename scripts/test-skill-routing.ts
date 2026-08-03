/**
 * Skill-based Ready poll: prefer matches; hard filter when matchAgentSkills.
 */
import { pollMissions } from "../src/lib/board-engine";
import type { BoardData, Mission, Agent } from "../src/lib/types";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

function mkMission(partial: Partial<Mission> & Pick<Mission, "id" | "title" | "tags">): Mission {
  return {
    projectId: "proj_default",
    objective: "o",
    context: "",
    constraints: "",
    acceptance: "",
    column: "ready",
    priority: "p2",
    claimedBy: null,
    claimedAt: null,
    lastHeartbeat: null,
    progressNote: "",
    artifacts: [],
    externalId: null,
    source: null,
    usage: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function main() {
  const agent: Agent = {
    id: "agent_x",
    name: "forge",
    harness: "hermes",
    role: "client",
    status: "online",
    skills: ["code", "docs"],
    lastHeartbeat: Date.now(),
    currentMissionId: null,
    isDemo: false,
  };
  const board: BoardData = {
    agents: [agent],
    missions: [
      mkMission({ id: "m1", title: "docs task", tags: ["docs"], priority: "p2", createdAt: 10 }),
      mkMission({ id: "m2", title: "ops task", tags: ["ops"], priority: "p0", createdAt: 5 }),
      mkMission({ id: "m3", title: "code task", tags: ["code"], priority: "p1", createdAt: 8 }),
    ],
    events: [],
    calls: [],
  };

  // Soft prefer: skill matches first, then priority among rest
  const soft = pollMissions(board, { column: "ready", limit: 10, agent: "forge" });
  assert(soft.ok, "soft ok");
  if (soft.ok) {
    const ids = soft.data.missions.map((m) => m.id);
    assert(ids[0] === "m3" || ids[0] === "m1", "skill match first");
    assert(ids.includes("m2"), "non-match still present");
    assert((soft.data as { skill_routing?: string }).skill_routing === "prefer", "prefer mode");
  }

  // Hard require
  const hard = pollMissions(board, {
    column: "ready",
    limit: 10,
    agent: "forge",
    matchAgentSkills: true,
  });
  assert(hard.ok, "hard ok");
  if (hard.ok) {
    const ids = hard.data.missions.map((m) => m.id);
    assert(!ids.includes("m2"), "ops filtered out");
    assert(ids.includes("m1") && ids.includes("m3"), "skill matches kept");
    assert((hard.data as { skill_routing?: string }).skill_routing === "require", "require mode");
  }

  console.log("✓ skill-based claim routing");
}

main();
