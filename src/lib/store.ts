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
import {
  ALL_BOARDS_ID,
  isAllBoardsScope,
  readStoredBoardScope,
  writeStoredBoardScope,
} from "./board-scope";

interface BoardState {
  agents: Agent[];
  missions: Mission[];
  events: MissionEvent[];
  calls: HumanCall[];
  projects: Project[];
  selectedProjectId: string | null;
  /** Last concrete board (for switching back from All boards). */
  lastSingleProjectId: string | null;
  historyByMission: Record<string, MissionHistoryEntry[]>;
  selectedMissionId: string | null;
  selectedAgentId: string | null;
  mainView:
    | "board"
    | "live"
    | "calls"
    | "agents"
    | "protocol"
    | "journal"
    | "analytics";
  panel:
    | "none"
    | "mission"
    | "agents"
    | "agent"
    | "user"
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
  /** True when viewing every board the user can access. */
  isAllBoards: () => boolean;
  /** Concrete board id for write actions, or null if only All is selected. */
  writeProjectId: () => string | null;
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
  /** Open agent profile side panel (stats, key tips, activity). */
  openAgentProfile: (agentId: string) => void;
  /** Open signed-in operator account panel. */
  openUserProfile: () => void;
  closePanel: () => void;
  setHydrated: () => void;

  refresh: () => Promise<void>;
  loadHistory: (missionId: string) => Promise<void>;

  moveMission: (id: string, column: MissionColumn, actor?: string | null) => void;
  /** Double-confirm bulk Review → Done. */
  acceptAllReview: () => void;
  claimMission: (missionId: string, agentId: string) => void;
  releaseMission: (missionId: string) => void;
  heartbeat: (missionId: string, note?: string) => void;
  escalate: (missionId: string, question: string, agentId?: string | null) => void;
  replyToCall: (callId: string, reply: string) => void;
  deliver: (missionId: string, delivery: string) => void;
  updateMission: (id: string, patch: Partial<Mission>) => void;
  transferMission: (id: string, projectId: string) => void;
  attachArtifact: (id: string, url: string, note?: string) => void;
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
  archiveBoard: (boardId: string) => Promise<boolean>;
  unarchiveBoard: (boardId: string) => Promise<boolean>;
  deleteBoard: (boardId: string) => Promise<boolean>;
  /** Active + archived boards for profile management. */
  listAllBoards: () => Promise<Project[]>;

  registerAgent: (input: {
    name: string;
    harness: HarnessKind;
    role: string;
    skills?: string[];
    /** Default true — mint board-bound ark_ with the agent. */
    issueKey?: boolean;
    keyName?: string;
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
  lastSingleProjectId: null,
  historyByMission: {},
  selectedMissionId: null,
  selectedAgentId: null,
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
    const next = id === "all" || id === "*" ? ALL_BOARDS_ID : id;
    const patch: Partial<BoardState> = {
      selectedProjectId: next,
      selectedMissionId: null,
      historyByMission: {},
    };
    if (next && next !== ALL_BOARDS_ID) {
      patch.lastSingleProjectId = next;
    }
    set(patch);
    writeStoredBoardScope(next);
    void get().refresh();
  },
  isAllBoards: () => isAllBoardsScope(get().selectedProjectId),
  writeProjectId: () => {
    const id = get().selectedProjectId;
    if (!id || id === ALL_BOARDS_ID) return get().lastSingleProjectId;
    return id;
  },
  openMissionOnBoard: (missionId, projectId) => {
    const cur = get().selectedProjectId;
    let nextProject = projectId ?? cur;
    // Prefer the mission's board so the kanban shows the right column set.
    if (!nextProject || nextProject === ALL_BOARDS_ID) {
      nextProject = projectId ?? get().lastSingleProjectId ?? cur;
    }
    if (nextProject === ALL_BOARDS_ID) nextProject = get().lastSingleProjectId;
    const projectChanged =
      nextProject != null && nextProject !== cur;
    const patch: Partial<BoardState> = {
      mainView: "board",
      selectedProjectId: nextProject,
      selectedMissionId: missionId,
      panel: "mission",
      ...(projectChanged ? { historyByMission: {} } : {}),
    };
    if (nextProject && nextProject !== ALL_BOARDS_ID) {
      patch.lastSingleProjectId = nextProject;
      writeStoredBoardScope(nextProject);
    }
    set(patch);
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
      ...(panel !== "agent" ? { selectedAgentId: null } : {}),
    });
    if (missionId) void get().loadHistory(missionId);
  },

  selectMission: (id) => {
    // Select only — do not open the detail panel (triage macros).
    set({
      selectedMissionId: id,
      selectedAgentId: null,
    });
  },

  openAgentProfile: (agentId) => {
    set({
      selectedAgentId: agentId,
      selectedMissionId: null,
      panel: "agent",
    });
  },

  openUserProfile: () => {
    set({
      selectedAgentId: null,
      selectedMissionId: null,
      panel: "user",
    });
  },

  closePanel: () => set({ panel: "none", selectedAgentId: null }),

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
      let lastSingleProjectId = get().lastSingleProjectId;

      // First hydrate: restore All boards or last board from localStorage / URL.
      if (!get()._hydrated && (selectedProjectId == null || selectedProjectId === "")) {
        const stored = readStoredBoardScope();
        if (stored === ALL_BOARDS_ID) {
          selectedProjectId = ALL_BOARDS_ID;
        } else if (stored && projects.some((p) => p.id === stored)) {
          selectedProjectId = stored;
          lastSingleProjectId = stored;
        }
      }

      if (selectedProjectId === ALL_BOARDS_ID) {
        // keep all-boards scope
      } else if (selectedProjectId && !projects.some((p) => p.id === selectedProjectId)) {
        selectedProjectId = null;
      }

      if (
        lastSingleProjectId &&
        !projects.some((p) => p.id === lastSingleProjectId)
      ) {
        lastSingleProjectId = null;
      }

      if (!selectedProjectId && projects.length) {
        // Prefer a board the user owns, then default/shared, then first.
        selectedProjectId =
          projects.find((p) => p.ownerUserId)?.id ??
          projects.find((p) => p.slug === "default" || p.id === "proj_default")?.id ??
          projects[0]!.id;
      }

      if (
        selectedProjectId &&
        selectedProjectId !== ALL_BOARDS_ID &&
        !lastSingleProjectId
      ) {
        lastSingleProjectId = selectedProjectId;
      }

      const apiProject =
        selectedProjectId === ALL_BOARDS_ID ? null : selectedProjectId;
      const snap = await agentApi.board(apiProject);
      set({
        agents: snap.agents,
        missions: snap.missions,
        events: snap.events,
        calls: snap.calls,
        projects,
        selectedProjectId,
        lastSingleProjectId,
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
    const prev = get().missions.find((m) => m.id === id);
    if (!prev) return;
    if (prev.column === column) return;
    // Optimistic UI — card jumps immediately; rollback on failure.
    set({
      missions: get().missions.map((m) =>
        m.id === id ? { ...m, column, updatedAt: Date.now() } : m,
      ),
    });
    void (async () => {
      try {
        await agentApi.move(id, column, actor ?? "operator");
        // Soft refresh in background; don't block UI.
        void get().refresh().catch(() => undefined);
        if (get().panel === "mission" && get().selectedMissionId === id) {
          void get().loadHistory(id).catch(() => undefined);
        }
      } catch (e) {
        set({
          missions: get().missions.map((m) => (m.id === id ? prev : m)),
        });
        toast.error(e instanceof Error ? e.message : "Move failed");
      }
    })();
  },

  acceptAllReview: () => {
    const ids = get()
      .missions.filter((m) => m.column === "review")
      .map((m) => m.id);
    if (!ids.length) {
      toast.message("No tickets in Review");
      return;
    }
    const ok = window.confirm(
      `Are you sure you wish to accept them all — this impacts ${ids.length} ticket${ids.length === 1 ? "" : "s"}?\n\nThey will move Review → Done.`,
    );
    if (!ok) return;
    const second = window.confirm(
      `Final confirm: accept ${ids.length} Review ticket${ids.length === 1 ? "" : "s"} to Done?`,
    );
    if (!second) return;
    const prev = get().missions;
    set({
      missions: get().missions.map((m) =>
        m.column === "review" ? { ...m, column: "done" as MissionColumn, updatedAt: Date.now() } : m,
      ),
    });
    void (async () => {
      try {
        const res = await agentApi.bulkMoveMissions(ids, "done");
        toast.success(`Accepted ${res.moved} ticket${res.moved === 1 ? "" : "s"} → Done`);
        void get().refresh().catch(() => undefined);
      } catch (e) {
        set({ missions: prev });
        toast.error(e instanceof Error ? e.message : "Accept all failed");
      }
    })();
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
    set((s) => ({
      missions: s.missions.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
    void run("Update mission", async () => {
      await agentApi.updateMission(id, {
        title: patch.title,
        objective: patch.objective,
        context: patch.context,
        constraints: patch.constraints,
        acceptance: patch.acceptance,
        priority: patch.priority,
        tags: patch.tags,
      });
      await get().refresh();
      await get().loadHistory(id);
    });
  },

  transferMission: (id, projectId) => {
    void run("Transfer mission", async () => {
      await agentApi.transferMission(id, projectId);
      await get().refresh();
      await get().loadHistory(id);
      toast.success("Mission moved to board");
    });
  },

  attachArtifact: (id, url, note) => {
    void run("Attach artifact", async () => {
      await agentApi.attachArtifact(id, url, note);
      await get().refresh();
      toast.success("Link attached");
    });
  },

  createMission: (input) => {
    const tempId = `pending_${Date.now()}`;
    void run("Create mission", async () => {
      const projectId = get().writeProjectId();
      if (!projectId) {
        toast.error("Select a board before creating a mission");
        return;
      }
      const res = await agentApi.createMission({
        title: input.title,
        objective: input.objective,
        context: input.context,
        constraints: input.constraints,
        acceptance: input.acceptance,
        priority: input.priority,
        tags: input.tags,
        column: input.column,
        projectId,
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

  listAllBoards: async () => {
    try {
      const res = await agentApi.listBoards({ includeArchived: true });
      const rows = res.boards ?? res.projects ?? [];
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description ?? "",
        ownerUserId: p.ownerUserId ?? null,
        archivedAt: p.archivedAt ?? null,
        createdAt: p.createdAt ?? Date.now(),
        updatedAt: p.updatedAt ?? Date.now(),
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`List boards: ${msg}`);
      return [];
    }
  },

  archiveBoard: async (boardId) => {
    try {
      await agentApi.archiveBoard(boardId);
      const sel = get().selectedProjectId;
      if (sel === boardId) {
        set({ selectedProjectId: get().lastSingleProjectId === boardId ? null : get().lastSingleProjectId });
      }
      await get().refresh();
      toast.success("Board archived");
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Archive failed");
      return false;
    }
  },

  unarchiveBoard: async (boardId) => {
    try {
      await agentApi.unarchiveBoard(boardId);
      await get().refresh();
      toast.success("Board restored");
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
      return false;
    }
  },

  deleteBoard: async (boardId) => {
    try {
      await agentApi.deleteBoard(boardId);
      const sel = get().selectedProjectId;
      if (sel === boardId) {
        set({
          selectedProjectId: null,
          selectedMissionId: null,
          lastSingleProjectId:
            get().lastSingleProjectId === boardId
              ? null
              : get().lastSingleProjectId,
        });
      }
      await get().refresh();
      toast.success("Board deleted");
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
      return false;
    }
  },

  registerAgent: (input) => {
    void run("Register agent", async () => {
      const projectId = get().writeProjectId();
      if (!projectId) {
        toast.error("Select a board before registering an agent");
        return;
      }
      const issueKey = input.issueKey !== false;
      const res = await agentApi.registerAgent({
        ...input,
        projectId,
        issueKey,
      });
      await get().refresh();
      set({ panel: "agents" });
      const secret =
        res.key && typeof res.key.secret === "string" ? res.key.secret : null;
      if (secret) {
        // Surface one-time secret for Create tab / callers via custom event
        window.dispatchEvent(
          new CustomEvent("devboards:agent-key-issued", {
            detail: {
              agentId: res.agent?.id,
              agentName: res.agent?.name,
              secret,
            },
          }),
        );
        toast.success(
          `Registered ${res.agent?.name ?? "agent"} + API key — copy secret now`,
        );
      } else if (issueKey && res.keyError) {
        toast.message(
          `Registered ${res.agent?.name ?? "agent"}; key not issued: ${res.keyError}`,
        );
      } else {
        toast.success(`Registered ${res.agent?.name ?? "agent"}`);
      }
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
