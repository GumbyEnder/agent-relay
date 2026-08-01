/**
 * MCP tool handlers — 1:1 with five agent verbs. DI board ops for tests.
 */
import type { BoardData } from "../lib/board-engine";
import * as engine from "../lib/board-engine";

export type BoardOpsLike = {
  poll: typeof import("../lib/board-server").boardOps.poll;
  claim: typeof import("../lib/board-server").boardOps.claim;
  heartbeat: typeof import("../lib/board-server").boardOps.heartbeat;
  escalate: typeof import("../lib/board-server").boardOps.escalate;
  deliver: typeof import("../lib/board-server").boardOps.deliver;
};

export const MCP_TOOL_NAMES = [
  "poll",
  "claim",
  "heartbeat",
  "escalate",
  "deliver",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export function mcpToolDefinitions() {
  return [
    {
      name: "poll",
      description: "List claimable missions from Ready (or column)",
      inputSchema: {
        type: "object",
        properties: {
          column: { type: "string" },
          limit: { type: "number" },
          agent: { type: "string" },
          projectId: { type: "string" },
        },
      },
    },
    {
      name: "claim",
      description: "Atomically claim a mission",
      inputSchema: {
        type: "object",
        properties: {
          mission_id: { type: "string" },
          agent: { type: "string" },
        },
        required: ["mission_id", "agent"],
      },
    },
    {
      name: "heartbeat",
      description: "Progress heartbeat on a claimed mission",
      inputSchema: {
        type: "object",
        properties: {
          mission_id: { type: "string" },
          agent: { type: "string" },
          note: { type: "string" },
        },
        required: ["mission_id", "agent"],
      },
    },
    {
      name: "escalate",
      description: "Escalate with one clear human question",
      inputSchema: {
        type: "object",
        properties: {
          mission_id: { type: "string" },
          agent: { type: "string" },
          question: { type: "string" },
        },
        required: ["mission_id", "agent", "question"],
      },
    },
    {
      name: "deliver",
      description: "Deliver mission to Review",
      inputSchema: {
        type: "object",
        properties: {
          mission_id: { type: "string" },
          agent: { type: "string" },
          summary: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
        },
        required: ["mission_id", "agent"],
      },
    },
  ];
}

export async function handleMcpTool(
  ops: BoardOpsLike,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: unknown; isError?: boolean }> {
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
  try {
    if (name === "poll") {
      const r = await ops.poll({
        column: (str(args.column) as any) ?? "ready",
        limit: typeof args.limit === "number" ? args.limit : 5,
        agent: str(args.agent),
        projectId: str(args.projectId) ?? str(args.project),
      });
      if (!r.ok) return { ok: false, isError: true, content: r };
      return { ok: true, content: r.data };
    }
    if (name === "claim") {
      const r = await ops.claim(str(args.mission_id) ?? str(args.missionId) ?? "", str(args.agent) ?? "");
      if (!r.ok) return { ok: false, isError: true, content: r };
      return { ok: true, content: r.data };
    }
    if (name === "heartbeat") {
      const r = await ops.heartbeat(
        str(args.mission_id) ?? str(args.missionId) ?? "",
        str(args.agent) ?? "",
        str(args.note),
      );
      if (!r.ok) return { ok: false, isError: true, content: r };
      return { ok: true, content: r.data };
    }
    if (name === "escalate") {
      const r = await ops.escalate(
        str(args.mission_id) ?? str(args.missionId) ?? "",
        str(args.agent) ?? "",
        str(args.question) ?? "",
      );
      if (!r.ok) return { ok: false, isError: true, content: r };
      return { ok: true, content: r.data };
    }
    if (name === "deliver") {
      const arts = Array.isArray(args.artifacts)
        ? args.artifacts.filter((x): x is string => typeof x === "string")
        : [];
      const r = await ops.deliver(
        str(args.mission_id) ?? str(args.missionId) ?? "",
        str(args.agent) ?? "",
        str(args.summary) ?? "",
        arts,
      );
      if (!r.ok) return { ok: false, isError: true, content: r };
      return { ok: true, content: r.data };
    }
    return { ok: false, isError: true, content: { error: `unknown tool ${name}` } };
  } catch (e) {
    return {
      ok: false,
      isError: true,
      content: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

/** In-memory board ops adapter for unit tests (pure engine). */
export function memoryBoardOps(initial: BoardData) {
  let board = initial;
  return {
    poll: async (opts: Parameters<typeof engine.pollMissions>[1]) => {
      const r = engine.pollMissions(board, opts);
      return r;
    },
    claim: async (missionId: string, agent: string) => {
      const r = engine.claimMission(board, missionId, agent);
      if (r.ok) board = r.board;
      return r;
    },
    heartbeat: async (missionId: string, agent: string, note?: string) => {
      const r = engine.heartbeatMission(board, missionId, agent, note);
      if (r.ok) board = r.board;
      return r;
    },
    escalate: async (missionId: string, agent: string, question: string) => {
      const r = engine.escalateMission(board, missionId, agent, question);
      if (r.ok) board = r.board;
      return r;
    },
    deliver: async (missionId: string, agent: string, summary: string, artifacts?: string[]) => {
      const r = engine.deliverMission(board, missionId, agent, summary, artifacts);
      if (r.ok) board = r.board;
      return r;
    },
    getBoard: () => board,
  };
}
