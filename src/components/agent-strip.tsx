import { Bot, Circle } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import type { Agent } from "@/lib/types";
import { HARNESS_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

const statusColor: Record<Agent["status"], string> = {
  online: "var(--color-status-ready)",
  busy: "var(--color-status-running)",
  idle: "var(--color-fg-muted)",
  offline: "var(--color-fg-subtle)",
  error: "var(--color-status-blocked)",
};

export function AgentStrip({
  agents,
  filterAgentId,
  onFilter,
  onOpenRoster,
  selectedProjectId = null,
}: {
  agents: Agent[];
  filterAgentId: string | null;
  onFilter: (id: string | null) => void;
  onOpenRoster: () => void;
  /** When a concrete board is selected, agents with membership are highlighted. */
  selectedProjectId?: string | null;
}) {
  const roster = agents.filter((a) => !a.isDemo);
  const live = roster.filter((a) => a.status !== "offline").length;
  const boardScoped =
    Boolean(selectedProjectId) &&
    selectedProjectId !== "__all__" &&
    selectedProjectId !== "all" &&
    selectedProjectId !== "*";
  const connectedCount = boardScoped
    ? roster.filter((a) => (a.boardIds ?? []).includes(selectedProjectId!)).length
    : 0;

  return (
    <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin border-b border-border bg-bg-elevated/60 px-3 py-2 sm:px-4">
      <button
        type="button"
        onClick={onOpenRoster}
        className="flex shrink-0 items-center gap-2 rounded-[var(--radius-sm)] bg-bg-subtle px-2.5 py-1.5 text-xs font-medium text-fg shadow-[var(--shadow-border)] hover:bg-bg-hover"
      >
        <Bot className="h-3.5 w-3.5" />
        <span className="tabular">{live}</span>
        <span className="text-fg-muted">live</span>
        {boardScoped ? (
          <span className="tabular text-accent" title="Agents connected to selected board">
            · {connectedCount} on board
          </span>
        ) : null}
      </button>

      <div className="flex items-center gap-1.5">
        {roster.length === 0 && (
          <span className="px-2 text-[11px] text-fg-subtle">No agents yet — open roster to register</span>
        )}
        {roster.map((a) => {
          const onBoard =
            boardScoped && (a.boardIds ?? []).includes(selectedProjectId!);
          const filtered = filterAgentId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onFilter(filterAgentId === a.id ? null : a.id)}
              aria-current={onBoard ? "true" : undefined}
              data-board-connected={onBoard ? "true" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-xs transition-colors",
                filtered
                  ? "bg-accent text-accent-fg"
                  : onBoard
                    ? "bg-accent/20 text-fg shadow-[0_0_0_1px_var(--color-accent)] ring-1 ring-accent/40"
                    : "bg-bg/80 text-fg-muted shadow-[var(--shadow-border)] hover:text-fg hover:bg-bg-subtle",
              )}
              title={
                onBoard
                  ? `${a.name} · connected to this board · ${HARNESS_LABELS[a.harness]} · ${a.role}`
                  : `${a.name} · ${HARNESS_LABELS[a.harness]} · ${a.role}`
              }
            >
              <Circle
                className="h-2 w-2 fill-current"
                style={{
                  color:
                    filtered || onBoard
                      ? "currentColor"
                      : statusColor[a.status],
                }}
              />
              <span className={cn("font-mono", onBoard && !filtered && "font-semibold")}>
                {a.name}
              </span>
              {onBoard && !filtered ? (
                <span className="hidden text-[10px] font-medium uppercase tracking-wide text-accent sm:inline">
                  board
                </span>
              ) : (
                <span
                  className={cn(
                    "hidden sm:inline",
                    filtered ? "opacity-70" : "text-fg-subtle",
                  )}
                >
                  {HARNESS_LABELS[a.harness]}
                </span>
              )}
              <RelativeTime
                ts={a.lastHeartbeat}
                className={cn(
                  "tabular hidden md:inline",
                  filtered ? "opacity-70" : "text-fg-subtle",
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
