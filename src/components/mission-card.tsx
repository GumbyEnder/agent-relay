import { useEffect, useState } from "react";
import { GripVertical, Radio, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/relative-time";
import type { Agent, Mission } from "@/lib/types";
import { COLUMN_STATUS_COLOR, PRIORITY_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

const priorityVariant = {
  p0: "p0",
  p1: "p1",
  p2: "p2",
  p3: "p3",
} as const;

export function MissionCard({
  mission,
  agent,
  selected,
  onOpen,
  onDragStart,
}: {
  mission: Mission;
  agent?: Agent;
  selected?: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const check = () => {
      setStale(
        mission.column === "running" &&
          !!mission.lastHeartbeat &&
          Date.now() - mission.lastHeartbeat > 5 * 60_000,
      );
    };
    check();
    const id = window.setInterval(check, 30_000);
    return () => window.clearInterval(id);
  }, [mission.column, mission.lastHeartbeat]);

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        "group cursor-grab rounded-[var(--radius-md)] bg-bg-elevated p-3 shadow-[var(--shadow-border)] transition-[box-shadow,background-color,transform] duration-150 active:cursor-grabbing hover:shadow-[var(--shadow-border-hover)] hover:bg-bg-subtle",
        selected && "ring-1 ring-accent/40",
        stale && "ring-1 ring-status-human/40",
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={priorityVariant[mission.priority]}>
              {mission.priority.toUpperCase()}
            </Badge>
            {mission.tags.slice(0, 2).map((t) => (
              <Badge key={t} variant="default">
                {t}
              </Badge>
            ))}
          </div>
          <h3 className="text-sm font-medium leading-snug text-fg">{mission.title}</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-fg-muted">
            {mission.objective}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-subtle">
          {agent ? (
            <>
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    agent.status === "busy"
                      ? "var(--color-status-running)"
                      : agent.status === "online" || agent.status === "idle"
                        ? "var(--color-status-ready)"
                        : "var(--color-fg-subtle)",
                }}
              />
              <span className="truncate font-mono">{agent.name}</span>
            </>
          ) : (
            <>
              <UserRound className="h-3 w-3" />
              <span>unclaimed</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-fg-subtle tabular">
          {(mission.column === "running" || mission.lastHeartbeat) && (
            <>
              <Radio
                className="h-3 w-3"
                style={{ color: COLUMN_STATUS_COLOR[mission.column] }}
              />
              <RelativeTime ts={mission.lastHeartbeat} />
            </>
          )}
          {!mission.lastHeartbeat && mission.column !== "running" && (
            <span title={PRIORITY_LABELS[mission.priority]}>
              <RelativeTime ts={mission.updatedAt} />
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
