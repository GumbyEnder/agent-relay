import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  BookMarked,
  BookOpen,
  Bot,
  CircleHelp,
  Download,
  LayoutDashboard,
  MessageSquareWarning,
  Palette,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Shield,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { ActivityFeed } from "@/components/activity-feed";
import { AdminPortal } from "@/components/admin-portal";
import { AgentStrip } from "@/components/agent-strip";
import { AgentProfilePanel } from "@/components/agent-profile-panel";
import { AgentsPanel } from "@/components/agents-panel";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { JournalPanel } from "@/components/journal-panel";
import { UserProfilePanel } from "@/components/user-profile-panel";
import { BoardColumn } from "@/components/board-column";
import { CallsPanel } from "@/components/calls-panel";
import { CommandPalette } from "@/components/command-palette";
import { MissionPanel } from "@/components/mission-panel";
import { NewMissionDialog } from "@/components/new-mission-dialog";
import { ProtocolPanel } from "@/components/protocol-panel";
import { HelpPanel } from "@/components/help-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filteredMissions, useBoard } from "@/lib/store";
import {
  applyTheme,
  initTheme,
  THEME_IDS,
  THEME_LABELS,
  type ThemeId,
} from "@/lib/theme";
import { COLUMNS, type MissionColumn } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  adjacentColumn,
  matchKeyboardAction,
} from "@/lib/keyboard-ops";
import { agentApi } from "@/lib/api-client";
import { UserButton } from "@/lib/auth/gates";
import { useOperatorMe } from "@/components/operator-gate";
import { ALL_BOARDS_ID, isAllBoardsScope } from "@/lib/board-scope";
import { adminPublicUrl } from "@/lib/surface";
import { listStaleMissions, DEFAULT_STALE_HEARTBEAT_MS } from "@/lib/stale-heartbeat";

type MainView =
  | "board"
  | "live"
  | "calls"
  | "agents"
  | "protocol"
  | "journal"
  | "analytics";

const VIEWS: { id: MainView; label: string; icon: typeof Activity }[] = [
  { id: "board", label: "Board", icon: LayoutDashboard },
  { id: "live", label: "Live", icon: Activity },
  { id: "calls", label: "Calls", icon: MessageSquareWarning },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "protocol", label: "Protocol", icon: BookOpen },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "journal", label: "Journal", icon: BookMarked },
];

export function AppShell({
  initialView = "board",
  initialProjectSlug,
}: {
  initialView?: MainView;
  initialProjectSlug?: string;
} = {}) {
  const navigate = useNavigate();
  const state = useBoard();
  const {
    agents,
    events,
    calls,
    projects,
    selectedProjectId,
    lastSingleProjectId,
    panel,
    selectedMissionId,
    selectedAgentId,
    mainView,
    search,
    filterAgentId,
    filterPriority,
    filterTag,
    compact,
    focusColumn,
    setSearch,
    setFilterAgent,
    setFilterPriority,
    setFilterTag,
    setCompact,
    setFocusColumn,
    setMainView,
    setSelectedProjectId,
    openPanel,
    selectMission,
    closePanel,
    moveMission,
    acceptAllReview,
    claimMission,
    simulateAgentTick,
    resetDemo,
    exportActive,
    setHydrated,
    createBoard,
    openMissionOnBoard,
    openUserProfile,
  } = state;

  const [mobileFeed, setMobileFeed] = useState(false);
  const [theme, setTheme] = useState<ThemeId>("dark");
  const [themeOpen, setThemeOpen] = useState(false);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardBusy, setNewBoardBusy] = useState(false);
  const [newMissionColumn, setNewMissionColumn] = useState<MissionColumn>("inbox");
  const { role, can } = useOperatorMe();

  const openNewMission = (column: MissionColumn = "inbox") => {
    setNewMissionColumn(column);
    openPanel("new-mission");
  };

  const submitNewBoard = async () => {
    if (!newBoardName.trim() || newBoardBusy) return;
    setNewBoardBusy(true);
    const id = await createBoard({ name: newBoardName.trim() });
    setNewBoardBusy(false);
    if (id) {
      setNewBoardOpen(false);
      setNewBoardName("");
      const p = useBoard.getState().projects.find((x) => x.id === id);
      void navigate({
        to: "/",
        search: (prev) => ({
          ...prev,
          project: p?.slug && p.slug !== "default" ? p.slug : undefined,
        }),
      });
    }
  };

  const missions = useMemo(
    () => filteredMissions({ ...state }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.missions, state.search, state.filterAgentId, state.filterPriority, state.filterTag],
  );
  const openCalls = calls.filter((c) => !c.resolvedAt).length;
  const running = state.missions.filter((m) => m.column === "running").length;
  const ready = state.missions.filter((m) => m.column === "ready").length;

  const sideOpen =
    panel === "mission" ||
    panel === "agents" ||
    panel === "agent" ||
    panel === "user" ||
    panel === "protocol" ||
    panel === "calls" ||
    panel === "help";

  useEffect(() => {
    setTheme(initTheme());
  }, []);

  useEffect(() => {
    if (initialView) setMainView(initialView);
  }, [initialView, setMainView]);

  useEffect(() => {
    if (!initialProjectSlug) return;
    if (initialProjectSlug === "all" || initialProjectSlug === "*") {
      if (selectedProjectId !== ALL_BOARDS_ID) {
        setSelectedProjectId(ALL_BOARDS_ID);
      }
      return;
    }
    if (!projects.length) return;
    const match = projects.find(
      (p) => p.slug === initialProjectSlug || p.id === initialProjectSlug,
    );
    if (match && match.id !== selectedProjectId) {
      setSelectedProjectId(match.id);
    }
  }, [initialProjectSlug, projects, selectedProjectId, setSelectedProjectId]);

  useEffect(() => {
    void useBoard
      .getState()
      .refresh()
      .then(() => setHydrated())
      .catch(() => setHydrated());
    const id = window.setInterval(() => {
      void useBoard.getState().refresh().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(id);
  }, [setHydrated]);

  useEffect(() => {
    try {
      const d = localStorage.getItem("agent-relay-density");
      if (d === "compact") setCompact(true);
    } catch { /* ignore */ }
  }, [setCompact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchKeyboardAction(e);
      if (!action) return;
      if (action === "escape") {
        closePanel();
        return;
      }
      e.preventDefault();
      if (action === "focus_search") {
        const el = document.querySelector<HTMLInputElement>("input[placeholder^='Search']");
        el?.focus();
        return;
      }
      if (action === "open_board") selectView("board");
      if (action === "open_live") selectView("live");
      if (action === "open_calls") selectView("calls");
      if (action === "compact_toggle") setCompact(!useBoard.getState().compact);
      if (action === "next_column" || action === "prev_column") {
        const cur = (useBoard.getState().focusColumn ?? "ready") as MissionColumn;
        const next = adjacentColumn(cur, action === "next_column" ? 1 : -1);
        setFocusColumn(next);
        toast.message(`Column · ${next.replace(/_/g, " ")}`);
      }
      if (action === "claim_selected") {
        const id = useBoard.getState().selectedMissionId;
        const agent = useBoard.getState().agents.find((a) => !a.currentMissionId && a.status !== "offline");
        if (id && agent) {
          claimMission(id, agent.id);
          toast.message(`Claim · ${agent.name}`);
        } else {
          toast.message("Select a mission and ensure an idle agent");
        }
      }
      if (action === "move_ready" || action === "move_running") {
        const id = useBoard.getState().selectedMissionId;
        if (id) {
          moveMission(id, action === "move_ready" ? "ready" : "running");
          toast.message(`Moved to ${action === "move_ready" ? "ready" : "running"}`);
        }
      }
      if (action === "advance_column" || action === "retreat_column") {
        const id = useBoard.getState().selectedMissionId;
        const m = useBoard.getState().missions.find((x) => x.id === id);
        if (id && m) {
          const next = adjacentColumn(
            m.column,
            action === "advance_column" ? 1 : -1,
          );
          if (next !== m.column) {
            moveMission(id, next);
            toast.message(`Moved · ${next.replace(/_/g, " ")}`);
          }
        } else {
          toast.message("Select a mission first (click a card)");
        }
      }
      if (action === "open_selected") {
        const id = useBoard.getState().selectedMissionId;
        if (id) openPanel("mission", id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePanel, claimMission, moveMission, openPanel, setCompact, setFocusColumn]);

  const byColumn = (col: MissionColumn) =>
    missions.filter((m) => m.column === col);

  const selectView = (v: MainView) => {
    setMainView(v);
    void navigate({
      to: "/",
      search: (prev) => ({ ...prev, view: v === "board" ? undefined : v }),
    });
  };

  const onTheme = (id: ThemeId) => {
    setTheme(applyTheme(id));
    setThemeOpen(false);
    toast.message(`Theme · ${THEME_LABELS[id]}`);
    void agentApi.setPrefs({ theme: id }).catch(() => {
      /* unsigned / offline — local only */
    });
  };

  // Account theme wins over localStorage when signed in
  useEffect(() => {
    void agentApi
      .getPrefs()
      .then((res) => {
        if (res.theme && THEME_IDS.includes(res.theme as ThemeId)) {
          setTheme(applyTheme(res.theme as ThemeId));
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const staleRunning = useMemo(
    () => listStaleMissions(missions, Date.now()),
    // recompute when missions or tick changes via refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [missions, events.length],
  );

  return (
    <div
      className={cn(
        "flex h-dvh flex-col overflow-hidden bg-bg text-fg",
        compact && "density-compact",
      )}
      data-density={compact ? "compact" : "comfortable"}
    >
      <Toaster
        theme={theme === "light" ? "light" : "dark"}
        position="bottom-right"
        toastOptions={{
          className:
            "!bg-bg-elevated !text-fg !border-border !shadow-[var(--shadow-panel)]",
        }}
      />
      <CommandPalette />
      <NewMissionDialog
        open={panel === "new-mission"}
        defaultColumn={newMissionColumn}
        onOpenChange={(o) => {
          if (o) openNewMission(newMissionColumn);
          else closePanel();
        }}
      />

      <header className="shrink-0 border-b border-border bg-bg-elevated/80 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
          <div className="mr-auto flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-accent text-accent-fg">
              <Radio className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight text-fg sm:text-base">
                Dev Boards
              </h1>
              <p className="truncate text-[11px] text-fg-subtle sm:text-xs">
                {isAllBoardsScope(selectedProjectId)
                  ? "All boards"
                  : selectedProject
                    ? `${selectedProject.name} · board`
                    : "Mission boards for AI agents"}
                {role ? ` · ${role}` : ""}
              </p>
            </div>
          </div>

          <div className="hidden sm:block">
            {role === "admin" && adminPublicUrl() ? (
              <a
                href={adminPublicUrl()!}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] bg-bg-subtle px-2.5 text-xs font-medium text-fg-muted shadow-[var(--shadow-border)] hover:bg-bg-hover hover:text-fg"
                title="Open platform Admin (separate host)"
              >
                <Shield className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Admin</span>
              </a>
            ) : null}
            <UserButton onOpenProfile={openUserProfile} />
          </div>

          <div className="flex w-full items-center gap-2 sm:w-auto sm:max-w-xs">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search missions…"
                className="h-9 pl-9"
              />
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-9 w-9 px-0"
              title="Help — humans & client agents"
              aria-label="Help"
              onClick={() => (panel === "help" ? closePanel() : openPanel("help"))}
            >
              <CircleHelp className="h-4 w-4" />
            </Button>
            {can("write_board") && (
            <Button
              size="sm"
              onClick={() => openNewMission("inbox")}
              className="h-9"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Mission</span>
            </Button>
            )}
            {can("write_board") && (
              <div className="relative">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-9"
                  title="New board (uncommon — creates a separate workspace)"
                  onClick={() => {
                    setNewBoardName("");
                    setNewBoardOpen((o) => !o);
                    setThemeOpen(false);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Board</span>
                </Button>
                {newBoardOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 space-y-2 rounded-[var(--radius-md)] border border-border bg-bg-elevated p-3 shadow-[var(--shadow-panel)]">
                    <p className="text-[11px] text-fg-muted">
                      Create a separate board. Most work stays on one board — only add another when you need isolation.
                    </p>
                    <Input
                      autoFocus
                      placeholder="Board name"
                      value={newBoardName}
                      onChange={(e) => setNewBoardName(e.target.value)}
                      className="h-8 text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setNewBoardOpen(false);
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitNewBoard();
                        }
                      }}
                    />
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        className="h-7 flex-1 text-[11px]"
                        disabled={newBoardBusy || !newBoardName.trim()}
                        onClick={() => void submitNewBoard()}
                      >
                        {newBoardBusy ? "…" : "Create board"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px]"
                        onClick={() => setNewBoardOpen(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="h-9"
              onClick={() => {
                setThemeOpen((o) => !o);
                setNewBoardOpen(false);
              }}
              title="Theme"
            >
              <Palette className="h-3.5 w-3.5" />
              <span className="hidden md:inline">{THEME_LABELS[theme]}</span>
            </Button>
            {themeOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[11rem] max-h-72 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-bg-elevated p-1 shadow-[var(--shadow-panel)] scrollbar-thin">
                {THEME_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={cn(
                      "flex w-full items-center rounded-[var(--radius-sm)] px-3 py-2 text-left text-xs",
                      theme === id
                        ? "bg-accent text-accent-fg"
                        : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                    )}
                    onClick={() => onTheme(id)}
                  >
                    {THEME_LABELS[id]}
                  </button>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-9"
              onClick={() => {
                simulateAgentTick();
                toast.message("Agent tick simulated");
              }}
              title="Simulate one agent claim or heartbeat"
            >
              <Radio className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-9"
              onClick={async () => {
                const json = exportActive();
                const blob = new Blob([json], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `agent-relay-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("Exported active missions");
              }}
              title="Export active board"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            {can("reset_demo") && (
            <Button
              size="sm"
              variant="ghost"
              className="h-9"
              onClick={() => {
                resetDemo();
                toast.message("Demo data restored");
              }}
              title="Reset demo"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            )}
          </div>
        </div>

        {/* View tabs */}
        <div className="flex flex-wrap items-center gap-1 border-t border-border px-3 py-2 sm:px-4">
          {staleRunning.length > 0 && (
            <button
              type="button"
              onClick={() => {
                selectView("board");
                const first = staleRunning[0];
                if (first) {
                  setFilterPriority(null);
                  openPanel("mission", first.id);
                  toast.message(
                    `${staleRunning.length} stale Running (>${Math.round(DEFAULT_STALE_HEARTBEAT_MS / 60_000)}m without heartbeat)`,
                  );
                }
              }}
              className="mr-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
              style={{
                background: "color-mix(in oklab, var(--color-status-human) 28%, transparent)",
                color: "var(--color-status-human)",
              }}
              title="Running missions past heartbeat SLA"
            >
              <Radio className="h-3 w-3" />
              {staleRunning.length} stale
            </button>
          )}
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const active = mainView === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => selectView(v.id)}
                className={cn(
                  "inline-flex h-10 min-h-[40px] items-center gap-1.5 rounded-[var(--radius-sm)] px-3 text-xs font-medium transition-colors sm:h-8 sm:min-h-0",
                  active
                    ? "bg-accent text-accent-fg"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {v.label}
                {v.id === "calls" && openCalls > 0 && (
                  <span className="ml-0.5 rounded-full bg-status-human px-1.5 text-[10px] text-accent-fg tabular">
                    {openCalls}
                  </span>
                )}
              </button>
            );
          })}
          <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-fg-subtle">
            <span className="tabular">
              <span className="text-status-running">{running}</span> running
            </span>
            <span className="tabular">
              <span className="text-status-ready">{ready}</span> ready
            </span>
            <span className="tabular">
              <span className="text-status-human">{openCalls}</span> calls
            </span>
            <input
              className="hidden h-7 w-24 rounded-full bg-bg-subtle px-2 text-[11px] text-fg shadow-[var(--shadow-border)] sm:block"
              placeholder="tag filter"
              value={filterTag ?? ""}
              onChange={(e) => setFilterTag(e.target.value || null)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => setCompact(!compact)}
              title="Compact density (d)"
            >
              {compact ? "Comfort" : "Compact"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={async () => {
                try {
                  const body = await agentApi.exportHistory({
                    projectId: isAllBoardsScope(selectedProjectId)
                      ? undefined
                      : (selectedProjectId ?? undefined),
                    format: "csv",
                  });
                  const text = typeof body === "string" ? body : JSON.stringify(body);
                  const blob = new Blob([text], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `history-${Date.now()}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast.success("History CSV exported");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "export failed");
                }
              }}
            >
              Audit CSV
            </Button>
            <div className="hidden items-center gap-1 sm:flex">
              {(["p0", "p1", "p2", "p3"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    setFilterPriority(filterPriority === p ? null : p)
                  }
                  className={cn(
                    "rounded-full px-2 py-1 font-mono uppercase transition-colors",
                    filterPriority === p
                      ? "bg-accent text-accent-fg"
                      : "bg-bg-subtle text-fg-muted hover:text-fg",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {mainView === "board" && (
        <AgentStrip
          agents={agents}
          filterAgentId={filterAgentId}
          onFilter={setFilterAgent}
          onOpenRoster={() => selectView("agents")}
          selectedProjectId={selectedProjectId}
          boardName={
            isAllBoardsScope(selectedProjectId)
              ? null
              : (selectedProject?.name ?? null)
          }
        />
      )}

      {/* Mobile board picker — rail is md+ only */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
        <label className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
          Board
        </label>
        <select
          className="h-11 min-h-[44px] flex-1 rounded-[var(--radius-sm)] bg-bg-subtle px-3 text-sm text-fg shadow-[var(--shadow-border)]"
          value={isAllBoardsScope(selectedProjectId) ? ALL_BOARDS_ID : (selectedProjectId ?? "")}
          onChange={(e) => {
            const v = e.target.value;
            if (v === ALL_BOARDS_ID) {
              setSelectedProjectId(ALL_BOARDS_ID);
              void navigate({
                to: "/",
                search: (prev) => ({ ...prev, project: "all" }),
              });
              return;
            }
            setSelectedProjectId(v);
            const p = projects.find((x) => x.id === v);
            void navigate({
              to: "/",
              search: (prev) => ({
                ...prev,
                project: p?.slug && p.slug !== "default" ? p.slug : undefined,
              }),
            });
          }}
          aria-label="Select board"
        >
          <option value={ALL_BOARDS_ID}>All boards</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Board rail — switch only; create lives next to Mission in the header */}
        <aside className="hidden w-44 shrink-0 flex-col border-r border-border bg-bg-elevated/30 md:flex lg:w-52">
          <div className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
            Boards
          </div>
          <ul className="flex-1 space-y-0.5 overflow-y-auto p-2 scrollbar-thin">
            <li>
              <button
                type="button"
                onClick={() => {
                  setSelectedProjectId(ALL_BOARDS_ID);
                  void navigate({
                    to: "/",
                    search: (prev) => ({
                      ...prev,
                      project: "all",
                    }),
                  });
                }}
                className={cn(
                  "flex w-full flex-col rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-xs transition-colors",
                  isAllBoardsScope(selectedProjectId)
                    ? "bg-accent text-accent-fg"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <span className="font-medium">All boards</span>
                <span
                  className={cn(
                    "text-[10px]",
                    isAllBoardsScope(selectedProjectId)
                      ? "text-accent-fg/70"
                      : "text-fg-subtle",
                  )}
                >
                  every board you can access
                </span>
              </button>
            </li>
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProjectId(p.id);
                    void navigate({
                      to: "/",
                      search: (prev) => ({
                        ...prev,
                        project: p.slug === "default" ? undefined : p.slug,
                      }),
                    });
                  }}
                  className={cn(
                    "flex w-full flex-col rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-xs transition-colors",
                    selectedProjectId === p.id
                      ? "bg-accent text-accent-fg"
                      : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                  )}
                >
                  <span className="font-medium">{p.name}</span>
                  <span
                    className={cn(
                      "font-mono text-[10px]",
                      selectedProjectId === p.id
                        ? "text-accent-fg/70"
                        : "text-fg-subtle",
                    )}
                  >
                    {p.ownerUserId ? "yours" : "shared"} · {p.slug}
                  </span>
                </button>
              </li>
            ))}
            {projects.length === 0 && (
              <li className="px-2 py-4 text-[11px] text-fg-subtle">
                No boards yet. Use <span className="text-fg-muted">+ Board</span> in the header.
              </li>
            )}
          </ul>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {mainView === "board" && (
            <div className="flex min-h-0 flex-1">
              <main className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-thin">
                <div className="flex h-full gap-2 p-3 sm:gap-3 sm:p-4">
                  {COLUMNS.map((col) => (
                    <BoardColumn
                      key={col.id}
                      columnId={col.id}
                      missions={byColumn(col.id)}
                      agents={agents}
                      selectedId={selectedMissionId}
                      showBoardName={isAllBoardsScope(selectedProjectId)}
                      boardNameById={Object.fromEntries(
                        projects.map((pr) => [pr.id, pr.name]),
                      )}
                      onSelect={(id) => selectMission(id)}
                      onOpen={(id) => openPanel("mission", id)}
                      onDropMission={(id, column) => moveMission(id, column)}
                      onDragStart={() => {}}
                      onMoveMission={
                        can("write_board")
                          ? (id, column) => moveMission(id, column)
                          : undefined
                      }
                      onAcceptAllReview={
                        can("write_board") ? () => acceptAllReview() : undefined
                      }
                      onAddMission={
                        can("write_board")
                          ? (column) => {
                              if (isAllBoardsScope(selectedProjectId) && !lastSingleProjectId) {
                                toast.error("Select a board first (or pick one in the rail)");
                                return;
                              }
                              openNewMission(column);
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              </main>
              <aside className="hidden w-64 shrink-0 border-l border-border bg-bg-elevated/40 xl:block">
                <ActivityFeed events={events} />
              </aside>
            </div>
          )}

          {mainView === "live" && (
            <div className="min-h-0 flex-1">
              <AdminPortal
                projectId={
                  isAllBoardsScope(selectedProjectId) ? null : selectedProjectId
                }
                scope={isAllBoardsScope(selectedProjectId) ? "all" : "board"}
                onScopeChange={(s) => {
                  if (s === "all") {
                    setSelectedProjectId(ALL_BOARDS_ID);
                    void navigate({
                      to: "/",
                      search: (prev) => ({ ...prev, project: "all", view: "live" }),
                    });
                    return;
                  }
                  const id =
                    lastSingleProjectId ??
                    projects.find((p) => p.ownerUserId)?.id ??
                    projects[0]?.id ??
                    null;
                  if (!id) {
                    toast.error("No board available");
                    return;
                  }
                  setSelectedProjectId(id);
                  const p = projects.find((x) => x.id === id);
                  void navigate({
                    to: "/",
                    search: (prev) => ({
                      ...prev,
                      view: "live",
                      project:
                        p?.slug && p.slug !== "default" ? p.slug : undefined,
                    }),
                  });
                }}
                boards={projects.map((p) => ({
                  id: p.id,
                  name: p.name,
                  slug: p.slug,
                }))}
                embedded
                onOpenMission={(missionId, boardId) => {
                  openMissionOnBoard(missionId, boardId);
                  void navigate({
                    to: "/",
                    search: (prev) => {
                      const p = projects.find((x) => x.id === (boardId ?? selectedProjectId));
                      return {
                        ...prev,
                        view: "board",
                        project:
                          p?.slug && p.slug !== "default" ? p.slug : undefined,
                      };
                    },
                  });
                }}
              />
            </div>
          )}

          {mainView === "calls" && (
            <div className="min-h-0 flex-1 overflow-hidden">
              <CallsPanel />
            </div>
          )}
          {mainView === "agents" && (
            <div className="min-h-0 flex-1 overflow-hidden">
              <AgentsPanel />
            </div>
          )}
          {mainView === "protocol" && (
            <div className="min-h-0 flex-1 overflow-hidden">
              <ProtocolPanel />
            </div>
          )}
          {mainView === "analytics" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <AnalyticsPanel />
            </div>
          )}
          {mainView === "journal" && (
            <div className="min-h-0 flex-1 overflow-hidden">
              <JournalPanel />
            </div>
          )}
        </div>

        <aside
          className={cn(
            "fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-border bg-bg-elevated shadow-[var(--shadow-panel)] transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] sm:max-w-md",
            sideOpen ? "translate-x-0" : "translate-x-full",
          )}
        >
          {panel === "mission" && selectedMissionId && (
            <MissionPanel missionId={selectedMissionId} />
          )}
          {panel === "agent" && selectedAgentId && (
            <AgentProfilePanel agentId={selectedAgentId} />
          )}
          {panel === "user" && <UserProfilePanel />}
          {panel === "agents" && <AgentsPanel />}
          {panel === "protocol" && <ProtocolPanel />}
          {panel === "calls" && <CallsPanel />}
          {panel === "help" && <HelpPanel onClose={closePanel} />}
        </aside>

        {sideOpen && (
          <button
            type="button"
            className="fixed inset-0 z-30 bg-black/40 xl:bg-black/20"
            aria-label="Close panel"
            onClick={closePanel}
          />
        )}
      </div>

      {mainView === "board" && (
        <div className="border-t border-border xl:hidden">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs text-fg-muted"
            onClick={() => setMobileFeed((v) => !v)}
          >
            <span>Ops feed</span>
            <span className="text-fg-subtle">{mobileFeed ? "Hide" : "Show"}</span>
          </button>
          {mobileFeed && (
            <div className="max-h-48 overflow-y-auto border-t border-border scrollbar-thin">
              <ActivityFeed events={events} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
