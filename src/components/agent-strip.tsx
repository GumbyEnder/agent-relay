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

function agentOnBoard(agent: Agent, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  return (agent.boardIds ?? []).includes(projectId);
}

export function AgentStrip({
  agents,
  filterAgentId,
  onFilter,
  onOpenRoster,
  selectedProjectId = null,
  boardName = null,
}: {
  agents: Agent[];
  filterAgentId: string | null;
  onFilter: (id: string | null) => void;
  onOpenRoster: () => void;
  /** When a concrete board is selected, agents with membership are highlighted. */
  selectedProjectId?: string | null;
  /** Display name for the selected board (tooltip / badge). */
  boardName?: string | null;
}) {
  const roster = agents.filter((a) => !a.isDemo);
  const live = roster.filter((a) => a.status !== "offline").length;
  const boardScoped =
    Boolean(selectedProjectId) &&
    selectedProjectId !== "__all__" &&
    selectedProjectId !== "all" &&
    selectedProjectId !== "*";
  const scopeLabel = boardName?.trim() || "this board";

  // Connected agents first so the highlight is obvious in a long fleet.
  const ordered = boardScoped
    ? [...roster].sort((a, b) => {
        const ac = agentOnBoard(a, selectedProjectId) ? 0 : 1;
        const bc = agentOnBoard(b, selectedProjectId) ? 0 : 1;
        if (ac !== bc) return ac - bc;
        return a.name.localeCompare(b.name);
      })
    : roster;

  const connectedCount = boardScoped
    ? ordered.filter((a) => agentOnBoard(a, selectedProjectId)).length
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
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide tabular"
            style={{
              background: "color-mix(in oklab, var(--color-status-ready) 28%, transparent)",
              color: "var(--color-status-ready)",
            }}
            title={`Agents connected to ${scopeLabel}`}
          >
            {connectedCount}/{ordered.length} on board
          </span>
        ) : null}
      </button>

      <div className="flex items-center gap-1.5">
        {ordered.length === 0 && (
          <span className="px-2 text-[11px] text-fg-subtle">No agents yet — open roster to register</span>
        )}
        {ordered.map((a) => {
          const onBoard = boardScoped && agentOnBoard(a, selectedProjectId);
          const filtered = filterAgentId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onFilter(filterAgentId === a.id ? null : a.id)}
              aria-current={onBoard ? "true" : undefined}
              data-board-connected={onBoard ? "true" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-xs transition-all",
                filtered && "bg-accent text-accent-fg",
                !filtered &&
                  onBoard &&
                  "font-semibold text-fg ring-2 ring-[var(--color-status-ready)]",
                !filtered &&
                  boardScoped &&
                  !onBoard &&
                  "bg-bg/50 text-fg-subtle opacity-45 shadow-[var(--shadow-border)] hover:opacity-80 hover:text-fg",
                !filtered &&
                  !boardScoped &&
                  "bg-bg/80 text-fg-muted shadow-[var(--shadow-border)] hover:text-fg hover:bg-bg-subtle",
              )}
              style={
                !filtered && onBoard
                  ? {
                      background:
                        "color-mix(in oklab, var(--color-status-ready) 22%, var(--color-bg-elevated))",
                      boxShadow:
                        "0 0 0 1px color-mix(in oklab, var(--color-status-ready) 55%, transparent)",
                    }
                  : undefined
              }
              title={
                onBoard
                  ? `${a.name} · connected to ${scopeLabel} · ${HARNESS_LABELS[a.harness]} · ${a.role}`
                  : boardScoped
                    ? `${a.name} · not on ${scopeLabel} · ${HARNESS_LABELS[a.harness]}`
                    : `${a.name} · ${HARNESS_LABELS[a.harness]} · ${a.role}`
              }
            >
              <Circle
                className="h-2 w-2 fill-current"
                style={{
                  color: filtered
                    ? "currentColor"
                    : onBoard
                      ? "var(--color-status-ready)"
                      : statusColor[a.status],
                }}
              />
              <span className="font-mono">{a.name}</span>
              {onBoard && !filtered ? (
                <span
                  className="rounded px-1 py-px text-[10px] font-bold uppercase tracking-wide"
                  style={{
                    background: "var(--color-status-ready)",
                    color: "#0a0a0b",
                  }}
                >
                  on board
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
