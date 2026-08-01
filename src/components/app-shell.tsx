import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  BookOpen,
  Bot,
  Download,
  LayoutDashboard,
  MessageSquareWarning,
  Palette,
  Plus,
  Radio,
  RotateCcw,
  Search,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { ActivityFeed } from "@/components/activity-feed";
import { AdminPortal } from "@/components/admin-portal";
import { AgentStrip } from "@/components/agent-strip";
import { AgentsPanel } from "@/components/agents-panel";
import { BoardColumn } from "@/components/board-column";
import { CallsPanel } from "@/components/calls-panel";
import { CommandPalette } from "@/components/command-palette";
import { MissionPanel } from "@/components/mission-panel";
import { NewMissionDialog } from "@/components/new-mission-dialog";
import { ProtocolPanel } from "@/components/protocol-panel";
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

type MainView = "board" | "live" | "calls" | "agents" | "protocol";

const VIEWS: { id: MainView; label: string; icon: typeof Activity }[] = [
  { id: "board", label: "Board", icon: LayoutDashboard },
  { id: "live", label: "Live", icon: Activity },
  { id: "calls", label: "Calls", icon: MessageSquareWarning },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "protocol", label: "Protocol", icon: BookOpen },
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
    panel,
    selectedMissionId,
    mainView,
    search,
    filterAgentId,
    filterPriority,
    setSearch,
    setFilterAgent,
    setFilterPriority,
    setMainView,
    setSelectedProjectId,
    openPanel,
    selectMission,
    closePanel,
    moveMission,
    simulateAgentTick,
    resetDemo,
    exportActive,
    setHydrated,
  } = state;

  const [mobileFeed, setMobileFeed] = useState(false);
  const [theme, setTheme] = useState<ThemeId>("dark");
  const [themeOpen, setThemeOpen] = useState(false);

  const missions = useMemo(
    () => filteredMissions({ ...state }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.missions, state.search, state.filterAgentId, state.filterPriority],
  );
  const openCalls = calls.filter((c) => !c.resolvedAt).length;
  const running = state.missions.filter((m) => m.column === "running").length;
  const ready = state.missions.filter((m) => m.column === "ready").length;

  const sideOpen =
    panel === "mission" ||
    panel === "agents" ||
    panel === "protocol" ||
    panel === "calls";

  useEffect(() => {
    setTheme(initTheme());
  }, []);

  useEffect(() => {
    if (initialView) setMainView(initialView);
  }, [initialView, setMainView]);

  useEffect(() => {
    if (!initialProjectSlug || !projects.length) return;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sideOpen) closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sideOpen, closePanel]);

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
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
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
        onOpenChange={(o) => (o ? openPanel("new-mission") : closePanel())}
      />

      <header className="shrink-0 border-b border-border bg-bg-elevated/80 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
          <div className="mr-auto flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-accent text-accent-fg">
              <Radio className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight text-fg sm:text-base">
                Agent Relay
              </h1>
              <p className="truncate text-[11px] text-fg-subtle sm:text-xs">
                {selectedProject
                  ? `${selectedProject.name} · agent-first kanban`
                  : "Mission kanban for any harness"}
              </p>
            </div>
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
              onClick={() => openPanel("new-mission")}
              className="h-9"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Mission</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-9"
              onClick={() => setThemeOpen((o) => !o)}
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
          </div>
        </div>

        {/* View tabs */}
        <div className="flex flex-wrap items-center gap-1 border-t border-border px-3 py-2 sm:px-4">
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const active = mainView === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => selectView(v.id)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-3 text-xs font-medium transition-colors",
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
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/* Project rail */}
        <aside className="hidden w-44 shrink-0 flex-col border-r border-border bg-bg-elevated/30 md:flex lg:w-52">
          <div className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
            Projects
          </div>
          <ul className="flex-1 space-y-0.5 overflow-y-auto p-2 scrollbar-thin">
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
                    {p.slug}
                  </span>
                </button>
              </li>
            ))}
            {projects.length === 0 && (
              <li className="px-2 py-4 text-[11px] text-fg-subtle">Loading…</li>
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
                      onOpen={(id) => selectMission(id)}
                      onDropMission={(id, column) => moveMission(id, column)}
                      onDragStart={() => {}}
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
              <AdminPortal projectId={selectedProjectId} embedded />
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
          {panel === "agents" && <AgentsPanel />}
          {panel === "protocol" && <ProtocolPanel />}
          {panel === "calls" && <CallsPanel />}
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
