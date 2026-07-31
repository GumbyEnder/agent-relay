import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  Download,
  MessageSquareWarning,
  Plus,
  Radio,
  Search,
  RotateCcw,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { ActivityFeed } from "@/components/activity-feed";
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
import { COLUMNS, type MissionColumn } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AppShell() {
  const state = useBoard();
  const {
    agents,
    events,
    calls,
    panel,
    selectedMissionId,
    search,
    filterAgentId,
    filterPriority,
    setSearch,
    setFilterAgent,
    setFilterPriority,
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
  const missions = useMemo(
    () =>
      filteredMissions({
        ...state,
        // selectors used by filter
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.missions,
      state.search,
      state.filterAgentId,
      state.filterPriority,
    ],
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
    useBoard.persist.rehydrate().then(() => setHydrated());
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

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <Toaster
        theme="dark"
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
                Mission kanban for any harness — claims, heartbeats, human calls
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

          <div className="flex flex-wrap items-center gap-1.5">
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
              className="h-9 relative"
              onClick={() => openPanel("calls")}
            >
              <MessageSquareWarning className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Calls</span>
              {openCalls > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-human px-1 text-[10px] font-medium text-accent-fg tabular">
                  {openCalls}
                </span>
              )}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-9"
              onClick={() => openPanel("agents")}
            >
              <Bot className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Agents</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-9"
              onClick={() => openPanel("protocol")}
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Protocol</span>
            </Button>
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

        <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-fg-subtle sm:px-4">
          <span className="tabular">
            <span className="text-status-running">{running}</span> running
          </span>
          <span className="tabular">
            <span className="text-status-ready">{ready}</span> ready
          </span>
          <span className="tabular">
            <span className="text-status-human">{openCalls}</span> human calls
          </span>
          <span className="hidden sm:inline text-fg-subtle/80">
            Press{" "}
            <kbd className="rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-fg-muted shadow-[var(--shadow-border)]">
              ⌘K
            </kbd>{" "}
            for commands
          </span>
          <div className="ml-auto flex items-center gap-1">
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
      </header>

      <AgentStrip
        agents={agents}
        filterAgentId={filterAgentId}
        onFilter={setFilterAgent}
        onOpenRoster={() => openPanel("agents")}
      />

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
    </div>
  );
}
