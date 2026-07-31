/**
 * Process-local board store for the agent-facing API.
 * Mutations are serialized through a promise chain so claim is atomic under concurrency.
 */
import { SEED_AGENTS, SEED_CALLS, SEED_EVENTS, SEED_MISSIONS } from "./seed";
import type { BoardData } from "./board-engine";
import * as engine from "./board-engine";

const globalRef = globalThis as typeof globalThis & {
  __agentRelayBoard__?: BoardData;
  __agentRelayBoardChain__?: Promise<unknown>;
};

function seedBoard(): BoardData {
  return {
    agents: structuredClone(SEED_AGENTS),
    missions: structuredClone(SEED_MISSIONS),
    events: structuredClone(SEED_EVENTS),
    calls: structuredClone(SEED_CALLS),
  };
}

function getBoard(): BoardData {
  if (!globalRef.__agentRelayBoard__) {
    globalRef.__agentRelayBoard__ = seedBoard();
  }
  return globalRef.__agentRelayBoard__;
}

function setBoard(next: BoardData) {
  globalRef.__agentRelayBoard__ = next;
}

/** Run a mutation exclusively (atomic claim under concurrent HTTP). */
export async function withBoardMutate<T>(
  fn: (board: BoardData) => engine.EngineResult<T> | Promise<engine.EngineResult<T>>,
): Promise<engine.EngineResult<T>> {
  const prev = globalRef.__agentRelayBoardChain__ ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  globalRef.__agentRelayBoardChain__ = prev.then(() => gate);

  await prev.catch(() => undefined);
  try {
    const result = await fn(getBoard());
    if (result.ok) setBoard(result.board);
    return result;
  } finally {
    release();
  }
}

export async function withBoardRead<T>(fn: (board: BoardData) => T | Promise<T>): Promise<T> {
  // Reads do not need the full mutex for demo correctness of claim; they see latest committed.
  return fn(getBoard());
}

export function resetBoard() {
  setBoard(seedBoard());
  return getBoard();
}

export const boardOps = {
  poll: (opts: Parameters<typeof engine.pollMissions>[1]) =>
    withBoardRead((b) => engine.pollMissions(b, opts)),

  claim: (missionId: string, agent: string) =>
    withBoardMutate((b) => engine.claimMission(b, missionId, agent)),

  heartbeat: (missionId: string, agent: string, note?: string) =>
    withBoardMutate((b) => engine.heartbeatMission(b, missionId, agent, note)),

  escalate: (missionId: string, agent: string, question: string) =>
    withBoardMutate((b) => engine.escalateMission(b, missionId, agent, question)),

  deliver: (missionId: string, agent: string, summary: string, artifacts?: string[]) =>
    withBoardMutate((b) => engine.deliverMission(b, missionId, agent, summary, artifacts)),

  reply: (callId: string, reply: string) =>
    withBoardMutate((b) => engine.replyToCall(b, callId, reply)),

  registerAgent: (input: Parameters<typeof engine.registerAgent>[1]) =>
    withBoardMutate((b) => engine.registerAgent(b, input)),

  snapshot: () => withBoardRead((b) => b),
  exportActive: () => withBoardRead((b) => engine.exportActive(b)),
  reset: () => resetBoard(),
};
