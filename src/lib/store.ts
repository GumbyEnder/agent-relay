import { create } from "zustand";
import { agentApi } from "./api-client";
import type {
  Agent,
  Project,
  AgentStatus,
  HarnessKind,
  HumanCall,
  Mission,
  MissionColumn,
  MissionEvent,
  MissionHistoryEntry,
  Priority,
} from "./types";
import { toast } from "sonner";

interface BoardState {
  agents: Agent[];
  missions: Mission[];
  events: MissionEvent[];
  calls: HumanCall[];
  projects: Project[];
  selectedProjectId: string | null;
  historyByMission: Record<string, MissionHistoryEntry[]>;
  selectedMissionId: string | null;
  mainView: "board" | "live" | "calls" | "agents" | "protocol";
  panel:
    | "none"
    | "mission"
    | "agents"
    | "protocol"
    | "calls"
    | "new-mission"
    | "new-agent"
    | "help";
  search: string;
  filterAgentId: string | null;
  filterPriority: Priority | null;
  filterTag: string | null;
  compact: boolean;
  focusColumn: string | null;
  _hydrated: boolean;
  _syncing: boolean;
  _error: string | null;

  setMainView: (v: BoardState["mainView"]) => void;
  setSelectedProjectId: (id: string | null) => void;
  /** From Live feed: switch to Board view and open mission panel. */
  openMissionOnBoard: (missionId: string, projectId?: string | null) => void;
  setSearch: (q: string) => void;
  setFilterAgent: (id: string | null) => void;
  setFilterPriority: (p: Priority | null) => void;
  setFilterTag: (t: string | null) => void;
  setCompact: (v: boolean) => void;
  setFocusColumn: (c: string | null) => void;
  openPanel: (panel: BoardState["panel"], missionId?: string | null) => void;
  selectMission: (id: string | null) => void;
  closePanel: () => void;
  setHydrated: () => void;

  refresh: () => Promise<void>;
  loadHistory: (missionId: string) => Promise<void>;

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
  createBoard: (input: { name: string; slug?: string; description?: string }) => Promise<string | null>;

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

async function run(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[board] ${label}`, e);
    toast.error(`${label}: ${msg}`);
    useBoard.setState({ _error: msg });
  }
}

export const useBoard = create<BoardState>()((set, get) => ({
  agents: [],
  missions: [],
  events: [],
  calls: [],
  projects: [],
  selectedProjectId: null,
  historyByMission: {},
  selectedMissionId: null,
  mainView: "board",
  panel: "none",
  search: "",
  filterAgentId: null,
  filterPriority: null,
  filterTag: null,
  compact: false,
  focusColumn: null,
  _hydrated: false,
  _syncing: false,
  _error: null,

  setHydrated: () => set({ _hydrated: true }),
  setMainView: (v) => set({ mainView: v, panel: "none" }),
  setSelectedProjectId: (id) => {
    set({ selectedProjectId: id, selectedMissionId: null, historyByMission: {} });
    void get().refresh();
  },
  openMissionOnBoard: (missionId, projectId) => {
    const nextProject = projectId ?? get().selectedProjectId;
    const projectChanged =
      nextProject != null && nextProject !== get().selectedProjectId;
    set({
      mainView: "board",
      selectedProjectId: nextProject,
      selectedMissionId: missionId,
      panel: "mission",
      ...(projectChanged ? { historyByMission: {} } : {}),
    });
    void get()
      .refresh()
      .then(() => get().loadHistory(missionId))
      .catch(() => undefined);
  },
  setSearch: (q) => set({ search: q }),
  setFilterAgent: (id) => set({ filterAgentId: id }),
  setFilterPriority: (p) => set({ filterPriority: p }),
  setFilterTag: (t) => set({ filterTag: t }),
  setCompact: (v) => {
    set({ compact: v });
    try {
      if (typeof document !== "undefined") {
        document.documentElement.dataset.density = v ? "compact" : "comfortable";
      }
      localStorage.setItem("agent-relay-density", v ? "compact" : "comfortable");
    } catch {
      /* ignore */
    }
  },
  setFocusColumn: (c) => set({ focusColumn: c }),

  openPanel: (panel, missionId) => {
    set({
      panel,
      selectedMissionId:
        missionId !== undefined ? missionId : get().selectedMissionId,
    });
    if (missionId) void get().loadHistory(missionId);
  },

  selectMission: (id) => {
    set({ selectedMissionId: id, panel: id ? "mission" : get().panel });
    if (id) void get().loadHistory(id);
  },

  closePanel: () => set({ panel: "none" }),

  refresh: async () => {
    set({ _syncing: true });
    try {
      // Resolve project scope BEFORE loading the board so the first paint is never unscoped.
      type BoardRow = {
        id: string;
        name: string;
        slug: string;
        description?: string;
        ownerUserId?: string | null;
        createdAt?: number;
        updatedAt?: number;
      };
      let rawList: BoardRow[] = [];
      try {
        const projRes = await agentApi.listProjects();
        rawList = (projRes.boards ?? projRes.projects ?? []) as BoardRow[];
      } catch {
        rawList = get().projects.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          description: p.description,
          ownerUserId: p.ownerUserId ?? null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));
      }
      const projects: Project[] = rawList.map((pr) => ({
        id: pr.id,
        name: pr.name,
        slug: pr.slug,
        description: pr.description ?? "",
        ownerUserId: pr.ownerUserId ?? null,
        createdAt: pr.createdAt ? Number(pr.createdAt) : Date.now(),
        updatedAt: pr.updatedAt ? Number(pr.updatedAt) : Date.now(),
      }));
      let selectedProjectId = get().selectedProjectId;
      if (selectedProjectId && !projects.some((p) => p.id === selectedProjectId)) {
        selectedProjectId = null;
      }
      if (!selectedProjectId && projects.length) {
        // Prefer a board the user owns, then default/shared, then first.
        selectedProjectId =
          projects.find((p) => p.ownerUserId)?.id ??
          projects.find((p) => p.slug === "default" || p.id === "proj_default")?.id ??
          projects[0]!.id;
      }
      const snap = await agentApi.board(selectedProjectId);
      set({
        agents: snap.agents,
        missions: snap.missions,
        events: snap.events,
        calls: snap.calls,
        projects,
        selectedProjectId,
        _hydrated: true,
        _syncing: false,
        _error: null,
      });
    } catch (e) {
      set({
        _syncing: false,
        _error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  loadHistory: async (missionId) => {
    try {
      const res = await agentApi.history(missionId);
      set((s) => ({
        historyByMission: { ...s.historyByMission, [missionId]: res.history },
      }));
    } catch (e) {
      console.error("history load", e);
    }
  },

  moveMission: (id, column, actor = "operator") => {
    void run("Move", async () => {
      await agentApi.move(id, column, actor ?? "operator");
      await get().refresh();
      await get().loadHistory(id);
    });
  },

  claimMission: (missionId, agentId) => {
    void run("Claim", async () => {
      await agentApi.claim(missionId, agentId);
      await get().refresh();
      await get().loadHistory(missionId);
    });
  },

  releaseMission: (missionId) => {
    void run("Release", async () => {
      await agentApi.releaseViaMove(missionId);
      await get().refresh();
      await get().loadHistory(missionId);
    });
  },

  heartbeat: (missionId, note) => {
    void run("Heartbeat", async () => {
      const m = get().missions.find((x) => x.id === missionId);
      const agent = m?.claimedBy ?? get().agents[0]?.id;
      if (!agent) throw new Error("No agent for heartbeat");
      await agentApi.heartbeat(missionId, agent, note);
      await get().refresh();
    });
  },

  escalate: (missionId, question, agentId) => {
    void run("Escalate", async () => {
      const m = get().missions.find((x) => x.id === missionId);
      const agent = agentId ?? m?.claimedBy ?? "operator";
      await agentApi.escalate(missionId, agent, question);
      await get().refresh();
      await get().loadHistory(missionId);
      set({ panel: "calls" });
    });
  },

  replyToCall: (callId, reply) => {
    void run("Reply", async () => {
      await agentApi.reply(callId, reply);
      await get().refresh();
      const call = get().calls.find((c) => c.id === callId);
      if (call) await get().loadHistory(call.missionId);
    });
  },

  deliver: (missionId, delivery) => {
    void run("Deliver", async () => {
      const m = get().missions.find((x) => x.id === missionId);
      const agent = m?.claimedBy ?? "operator";
      await agentApi.deliver(missionId, agent, delivery);
      await get().refresh();
      await get().loadHistory(missionId);
    });
  },

  updateMission: (id, patch) => {
    // optimistic local only for title edits not yet on API — skip durable fields
    set((s) => ({
      missions: s.missions.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  },

  createMission: (input) => {
    const tempId = `pending_${Date.now()}`;
    void run("Create mission", async () => {
      const res = await agentApi.createMission({
        title: input.title,
        objective: input.objective,
        context: input.context,
        constraints: input.constraints,
        acceptance: input.acceptance,
        priority: input.priority,
        tags: input.tags,
        column: input.column,
        projectId: get().selectedProjectId ?? undefined,
      });
      await get().refresh();
      const id = res.mission.id;
      set({ selectedMissionId: id, panel: "mission" });
      await get().loadHistory(id);
    });
    return tempId;
  },

  deleteMission: (_id) => {
    toast.message("Delete not exposed on shared API yet");
  },

  createBoard: async (input) => {
    try {
      const res = await agentApi.createBoard({
        name: input.name,
        slug: input.slug,
        description: input.description,
      });
      const board = res.board ?? res.project;
      await get().refresh();
      if (board?.id) {
        set({ selectedProjectId: board.id, selectedMissionId: null });
        toast.success(`Board “${board.name ?? input.name}” created`);
        return board.id;
      }
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Create board: ${msg}`);
      return null;
    }
  },

  registerAgent: (input) => {
    void run("Register agent", async () => {
      await agentApi.registerAgent({
        ...input,
        projectId: get().selectedProjectId,
      });
      await get().refresh();
      set({ panel: "agents" });
    });
    return "pending";
  },

  setAgentStatus: (_id, _status) => {
    /* optional */
  },

  removeAgent: (_id) => {
    toast.message("Remove agent not exposed on shared API yet");
  },

  simulateAgentTick: () => {
    void run("Simulate tick", async () => {
      const s = get();
      const ready = s.missions.filter((m) => m.column === "ready" && !m.claimedBy);
      const idle = s.agents.filter((a) => !a.currentMissionId && a.status !== "offline");
      if (ready.length && idle.length) {
        await agentApi.claim(ready[0]!.id, idle[0]!.id);
      } else {
        const running = s.missions.find((m) => m.column === "running" && m.claimedBy);
        if (running?.claimedBy) {
          await agentApi.heartbeat(running.id, running.claimedBy, "simulate tick");
        }
      }
      await get().refresh();
    });
  },

  resetDemo: () => {
    void run("Reset demo", async () => {
      await agentApi.reset();
      await get().refresh();
      set({ selectedMissionId: null, panel: "none", historyByMission: {} });
      toast.success("Demo board reset");
    });
  },

  exportActive: () => {
    // sync export: return last known non-done missions
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

  importMissions: () => {
    toast.message("Import via API not yet supported");
    return 0;
  },
}));

type BoardStore = typeof useBoard & {
  persist: { rehydrate: () => Promise<void> };
};
(useBoard as BoardStore).persist = {
  rehydrate: () => useBoard.getState().refresh(),
};
export type { BoardStore };

export function filteredMissions(state: BoardState): Mission[] {
  const q = state.search.trim().toLowerCase();
  const tag = state.filterTag?.trim().toLowerCase() ?? "";
  return state.missions.filter((m) => {
    if (state.filterAgentId) {
      const match =
        m.claimedBy === state.filterAgentId || m.assigneeId === state.filterAgentId;
      if (!match) return false;
    }
    if (state.filterPriority && m.priority !== state.filterPriority) return false;
    if (tag && !m.tags.some((x) => x.toLowerCase() === tag || x.toLowerCase().includes(tag))) {
      return false;
    }
    if (!q) return true;
    const hay = [m.title, m.objective, m.context, m.tags.join(" "), m.progressNote]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
