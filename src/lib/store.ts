import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SEED_AGENTS, SEED_CALLS, SEED_EVENTS, SEED_MISSIONS } from "./seed";
import type {
  Agent,
  AgentStatus,
  HarnessKind,
  HumanCall,
  Mission,
  MissionColumn,
  MissionEvent,
  Priority,
} from "./types";
import { uid } from "./utils";

interface BoardState {
  agents: Agent[];
  missions: Mission[];
  events: MissionEvent[];
  calls: HumanCall[];
  selectedMissionId: string | null;
  panel: "none" | "mission" | "agents" | "protocol" | "calls" | "new-mission" | "new-agent";
  search: string;
  filterAgentId: string | null;
  filterPriority: Priority | null;
  _hydrated: boolean;

  setSearch: (q: string) => void;
  setFilterAgent: (id: string | null) => void;
  setFilterPriority: (p: Priority | null) => void;
  openPanel: (panel: BoardState["panel"], missionId?: string | null) => void;
  selectMission: (id: string | null) => void;
  closePanel: () => void;
  setHydrated: () => void;

  moveMission: (id: string, column: MissionColumn, actor?: string | null) => void;
  claimMission: (missionId: string, agentId: string) => void;
  releaseMission: (missionId: string) => void;
  heartbeat: (missionId: string, note?: string) => void;
  escalate: (missionId: string, question: string, agentId?: string | null) => void;
  replyToCall: (callId: string, reply: string) => void;
  deliver: (missionId: string, delivery: string) => void;
  updateMission: (id: string, patch: Partial<Mission>) => void;
  createMission: (input: {
    title: string;
    objective: string;
    context?: string;
    constraints?: string;
    acceptance?: string;
    priority?: Priority;
    tags?: string[];
    assigneeId?: string | null;
    column?: MissionColumn;
  }) => string;
  deleteMission: (id: string) => void;

  registerAgent: (input: {
    name: string;
    harness: HarnessKind;
    role: string;
    skills?: string[];
  }) => string;
  setAgentStatus: (id: string, status: AgentStatus) => void;
  removeAgent: (id: string) => void;

  simulateAgentTick: () => void;
  resetDemo: () => void;
  exportActive: () => string;
  importMissions: (json: string) => number;
}

function pushEvent(
  events: MissionEvent[],
  partial: Omit<MissionEvent, "id" | "at"> & { at?: number },
): MissionEvent[] {
  return [
    {
      id: uid("ev"),
      at: partial.at ?? Date.now(),
      ...partial,
    },
    ...events,
  ].slice(0, 200);
}

function touchMission(m: Mission, patch: Partial<Mission>): Mission {
  return { ...m, ...patch, updatedAt: Date.now() };
}

export const useBoard = create<BoardState>()(
  persist(
    (set, get) => ({
      agents: SEED_AGENTS,
      missions: SEED_MISSIONS,
      events: SEED_EVENTS,
      calls: SEED_CALLS,
      selectedMissionId: null,
      panel: "none",
      search: "",
      filterAgentId: null,
      filterPriority: null,
      _hydrated: false,

      setHydrated: () => set({ _hydrated: true }),
      setSearch: (q) => set({ search: q }),
      setFilterAgent: (id) => set({ filterAgentId: id }),
      setFilterPriority: (p) => set({ filterPriority: p }),

      openPanel: (panel, missionId) =>
        set({
          panel,
          selectedMissionId:
            missionId !== undefined ? missionId : get().selectedMissionId,
        }),

      selectMission: (id) =>
        set({ selectedMissionId: id, panel: id ? "mission" : get().panel }),

      closePanel: () => set({ panel: "none" }),

      moveMission: (id, column, actor = null) =>
        set((s) => {
          const mission = s.missions.find((m) => m.id === id);
          if (!mission || mission.column === column) return s;
          const missions = s.missions.map((m) =>
            m.id === id
              ? touchMission(m, {
                  column,
                  ...(column === "ready"
                    ? { claimedBy: null, claimedAt: null, assigneeId: m.assigneeId }
                    : {}),
                  ...(column === "done"
                    ? { claimedBy: m.claimedBy, lastHeartbeat: Date.now() }
                    : {}),
                })
              : m,
          );
          return {
            missions,
            events: pushEvent(s.events, {
              missionId: id,
              agentId: actor,
              kind: "mission_moved",
              message: `Moved to ${column.replace("_", " ")}: ${mission.title}`,
              meta: { from: mission.column, to: column },
            }),
          };
        }),

      claimMission: (missionId, agentId) =>
        set((s) => {
          const mission = s.missions.find((m) => m.id === missionId);
          const agent = s.agents.find((a) => a.id === agentId);
          if (!mission || !agent) return s;
          if (mission.claimedBy && mission.claimedBy !== agentId) return s;

          const missions = s.missions.map((m) =>
            m.id === missionId
              ? touchMission(m, {
                  claimedBy: agentId,
                  claimedAt: Date.now(),
                  assigneeId: agentId,
                  column: m.column === "ready" || m.column === "inbox" ? "running" : m.column,
                  lastHeartbeat: Date.now(),
                })
              : m,
          );
          const agents = s.agents.map((a) =>
            a.id === agentId
              ? {
                  ...a,
                  status: "busy" as const,
                  currentMissionId: missionId,
                  lastHeartbeat: Date.now(),
                }
              : a.currentMissionId === missionId
                ? { ...a, currentMissionId: null, status: a.status === "busy" ? "idle" : a.status }
                : a,
          );
          return {
            missions,
            agents,
            events: pushEvent(s.events, {
              missionId,
              agentId,
              kind: "mission_claimed",
              message: `${agent.name} claimed · ${mission.title}`,
            }),
          };
        }),

      releaseMission: (missionId) =>
        set((s) => {
          const mission = s.missions.find((m) => m.id === missionId);
          if (!mission) return s;
          const agentId = mission.claimedBy;
          const missions = s.missions.map((m) =>
            m.id === missionId
              ? touchMission(m, {
                  claimedBy: null,
                  claimedAt: null,
                  column: m.column === "running" ? "ready" : m.column,
                })
              : m,
          );
          const agents = s.agents.map((a) =>
            a.id === agentId
              ? { ...a, currentMissionId: null, status: "idle" as const }
              : a,
          );
          return {
            missions,
            agents,
            events: pushEvent(s.events, {
              missionId,
              agentId,
              kind: "mission_released",
              message: `Released · ${mission.title}`,
            }),
          };
        }),

      heartbeat: (missionId, note) =>
        set((s) => {
          const mission = s.missions.find((m) => m.id === missionId);
          if (!mission) return s;
          const missions = s.missions.map((m) =>
            m.id === missionId
              ? touchMission(m, {
                  lastHeartbeat: Date.now(),
                  progressNote: note?.trim() ? note : m.progressNote,
                })
              : m,
          );
          const agents = s.agents.map((a) =>
            a.id === mission.claimedBy
              ? { ...a, lastHeartbeat: Date.now(), status: "busy" as const }
              : a,
          );
          return {
            missions,
            agents,
            events: pushEvent(s.events, {
              missionId,
              agentId: mission.claimedBy,
              kind: "heartbeat",
              message: note?.trim()
                ? `Heartbeat · ${note.trim()}`
                : `Heartbeat · ${mission.title}`,
            }),
          };
        }),

      escalate: (missionId, question, agentId) =>
        set((s) => {
          const mission = s.missions.find((m) => m.id === missionId);
          if (!mission || !question.trim()) return s;
          const call: HumanCall = {
            id: uid("call"),
            missionId,
            agentId: agentId ?? mission.claimedBy,
            question: question.trim(),
            urgency: mission.priority,
            createdAt: Date.now(),
            resolvedAt: null,
            reply: null,
          };
          const missions = s.missions.map((m) =>
            m.id === missionId
              ? touchMission(m, {
                  column: "needs_human",
                  progressNote: question.trim(),
                })
              : m,
          );
          return {
            missions,
            calls: [call, ...s.calls],
            events: pushEvent(s.events, {
              missionId,
              agentId: call.agentId,
              kind: "escalation",
              message: `Needs human · ${question.trim()}`,
            }),
            panel: "calls",
          };
        }),

      replyToCall: (callId, reply) =>
        set((s) => {
          const call = s.calls.find((c) => c.id === callId);
          if (!call || !reply.trim()) return s;
          const calls = s.calls.map((c) =>
            c.id === callId
              ? { ...c, reply: reply.trim(), resolvedAt: Date.now() }
              : c,
          );
          const missions = s.missions.map((m) =>
            m.id === call.missionId && m.column === "needs_human"
              ? touchMission(m, {
                  column: "running",
                  progressNote: `Human reply: ${reply.trim()}`,
                })
              : m,
          );
          return {
            calls,
            missions,
            events: pushEvent(s.events, {
              missionId: call.missionId,
              agentId: call.agentId,
              kind: "human_reply",
              message: `Human replied · ${reply.trim()}`,
            }),
          };
        }),

      deliver: (missionId, delivery) =>
        set((s) => {
          const mission = s.missions.find((m) => m.id === missionId);
          if (!mission) return s;
          const missions = s.missions.map((m) =>
            m.id === missionId
              ? touchMission(m, {
                  column: "review",
                  delivery: delivery.trim() || m.delivery,
                  lastHeartbeat: Date.now(),
                })
              : m,
          );
          const agents = s.agents.map((a) =>
            a.currentMissionId === missionId
              ? { ...a, currentMissionId: null, status: "idle" as const }
              : a,
          );
          return {
            missions,
            agents,
            events: pushEvent(s.events, {
              missionId,
              agentId: mission.claimedBy,
              kind: "delivery",
              message: `Delivered for review · ${mission.title}`,
            }),
          };
        }),

      updateMission: (id, patch) =>
        set((s) => ({
          missions: s.missions.map((m) =>
            m.id === id ? touchMission(m, patch) : m,
          ),
        })),

      createMission: (input) => {
        const id = uid("msn");
        const mission: Mission = {
          id,
          title: input.title.trim(),
          objective: input.objective.trim(),
          context: (input.context ?? "").trim(),
          constraints: (input.constraints ?? "").trim(),
          acceptance: (input.acceptance ?? "").trim(),
          column: input.column ?? "inbox",
          priority: input.priority ?? "p2",
          tags: input.tags ?? [],
          assigneeId: input.assigneeId ?? null,
          claimedBy: null,
          claimedAt: null,
          lastHeartbeat: null,
          progressNote: "",
          artifacts: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((s) => ({
          missions: [mission, ...s.missions],
          events: pushEvent(s.events, {
            missionId: id,
            agentId: null,
            kind: "mission_created",
            message: `Created · ${mission.title}`,
          }),
          selectedMissionId: id,
          panel: "mission",
        }));
        return id;
      },

      deleteMission: (id) =>
        set((s) => ({
          missions: s.missions.filter((m) => m.id !== id),
          calls: s.calls.filter((c) => c.missionId !== id),
          selectedMissionId:
            s.selectedMissionId === id ? null : s.selectedMissionId,
          panel: s.selectedMissionId === id ? "none" : s.panel,
        })),

      registerAgent: (input) => {
        const id = uid("agent");
        const agent: Agent = {
          id,
          name: input.name.trim().toLowerCase().replace(/\s+/g, "-"),
          harness: input.harness,
          role: input.role.trim(),
          status: "online",
          skills: input.skills ?? [],
          lastHeartbeat: Date.now(),
          currentMissionId: null,
        };
        set((s) => ({
          agents: [agent, ...s.agents],
          events: pushEvent(s.events, {
            missionId: null,
            agentId: id,
            kind: "agent_registered",
            message: `Agent registered · ${agent.name} (${input.harness})`,
          }),
          panel: "agents",
        }));
        return id;
      },

      setAgentStatus: (id, status) =>
        set((s) => ({
          agents: s.agents.map((a) =>
            a.id === id
              ? {
                  ...a,
                  status,
                  lastHeartbeat: status === "offline" ? a.lastHeartbeat : Date.now(),
                }
              : a,
          ),
          events: pushEvent(s.events, {
            missionId: null,
            agentId: id,
            kind: "agent_status",
            message: `Agent ${status} · ${s.agents.find((a) => a.id === id)?.name ?? id}`,
          }),
        })),

      removeAgent: (id) =>
        set((s) => ({
          agents: s.agents.filter((a) => a.id !== id),
          missions: s.missions.map((m) =>
            m.claimedBy === id || m.assigneeId === id
              ? touchMission(m, {
                  claimedBy: m.claimedBy === id ? null : m.claimedBy,
                  assigneeId: m.assigneeId === id ? null : m.assigneeId,
                  column:
                    m.claimedBy === id && m.column === "running" ? "ready" : m.column,
                })
              : m,
          ),
        })),

      simulateAgentTick: () => {
        const s = get();
        const online = s.agents.filter((a) => a.status !== "offline");
        if (online.length === 0) return;

        const ready = s.missions.filter(
          (m) => m.column === "ready" && !m.claimedBy,
        );
        const idle = online.filter((a) => !a.currentMissionId && a.status !== "error");
        if (ready.length && idle.length) {
          const mission = ready[0]!;
          const agent = idle[Math.floor(Math.random() * idle.length)]!;
          get().claimMission(mission.id, agent.id);
          return;
        }

        const running = s.missions.filter((m) => m.column === "running" && m.claimedBy);
        if (running.length) {
          const mission = running[Math.floor(Math.random() * running.length)]!;
          const notes = [
            "Scanning constraints",
            "Writing draft patch",
            "Running checks",
            "Updating progress note",
            "Preparing delivery",
          ];
          get().heartbeat(
            mission.id,
            notes[Math.floor(Math.random() * notes.length)],
          );
        }
      },

      resetDemo: () =>
        set({
          agents: SEED_AGENTS,
          missions: SEED_MISSIONS,
          events: SEED_EVENTS,
          calls: SEED_CALLS,
          selectedMissionId: null,
          panel: "none",
          search: "",
          filterAgentId: null,
          filterPriority: null,
        }),

      exportActive: () => {
        const active = get().missions.filter((m) => m.column !== "done");
        return JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            missions: active,
            agents: get().agents,
          },
          null,
          2,
        );
      },

      importMissions: (json) => {
        try {
          const data = JSON.parse(json) as { missions?: Mission[] };
          if (!Array.isArray(data.missions)) return 0;
          const existing = new Set(get().missions.map((m) => m.id));
          const incoming = data.missions.filter((m) => m?.id && !existing.has(m.id));
          if (!incoming.length) return 0;
          set((s) => ({
            missions: [...incoming, ...s.missions],
            events: pushEvent(s.events, {
              missionId: null,
              agentId: null,
              kind: "note",
              message: `Imported ${incoming.length} mission(s)`,
            }),
          }));
          return incoming.length;
        } catch {
          return 0;
        }
      },
    }),
    {
      name: "agent-relay-board-v1",
      skipHydration: true,
      partialize: (s) => ({
        agents: s.agents,
        missions: s.missions,
        events: s.events,
        calls: s.calls,
      }),
    },
  ),
);

export function filteredMissions(state: BoardState): Mission[] {
  const q = state.search.trim().toLowerCase();
  return state.missions.filter((m) => {
    if (state.filterAgentId) {
      const match =
        m.claimedBy === state.filterAgentId || m.assigneeId === state.filterAgentId;
      if (!match) return false;
    }
    if (state.filterPriority && m.priority !== state.filterPriority) return false;
    if (!q) return true;
    const hay = [
      m.title,
      m.objective,
      m.context,
      m.tags.join(" "),
      m.progressNote,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
