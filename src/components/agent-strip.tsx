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
}: {
  agents: Agent[];
  filterAgentId: string | null;
  onFilter: (id: string | null) => void;
  onOpenRoster: () => void;
}) {
  const live = agents.filter((a) => a.status !== "offline").length;

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
      </button>

      <div className="flex items-center gap-1.5">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onFilter(filterAgentId === a.id ? null : a.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-xs transition-colors",
              filterAgentId === a.id
                ? "bg-accent text-accent-fg"
                : "bg-bg/80 text-fg-muted shadow-[var(--shadow-border)] hover:text-fg hover:bg-bg-subtle",
            )}
            title={`${a.name} · ${HARNESS_LABELS[a.harness]} · ${a.role}`}
          >
            <Circle
              className="h-2 w-2 fill-current"
              style={{
                color:
                  filterAgentId === a.id
                    ? "currentColor"
                    : statusColor[a.status],
              }}
            />
            <span className="font-mono">{a.name}</span>
            <span
              className={cn(
                "hidden sm:inline",
                filterAgentId === a.id ? "opacity-70" : "text-fg-subtle",
              )}
            >
              {HARNESS_LABELS[a.harness]}
            </span>
            <RelativeTime
              ts={a.lastHeartbeat}
              className={cn(
                "tabular hidden md:inline",
                filterAgentId === a.id ? "opacity-70" : "text-fg-subtle",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
