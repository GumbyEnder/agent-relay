import { useEffect, useRef, useState } from "react";
import { GripVertical, Radio, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/relative-time";
import type { Agent, Mission, MissionColumn } from "@/lib/types";
import { COLUMN_STATUS_COLOR, PRIORITY_LABELS } from "@/lib/types";
import { adjacentColumn } from "@/lib/keyboard-ops";
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
  onSelect,
  onOpen,
  onDragStart,
  onAdvanceReady,
  onAdvanceNext,
  boardName,
}: {
  mission: Mission;
  agent?: Agent;
  selected?: boolean;
  /** Single click — select only (triage). */
  onSelect: () => void;
  /** Double-click / Enter — open detail. */
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onAdvanceReady?: () => void;
  onAdvanceNext?: () => void;
  /** When set (All boards view), show which board owns the card */
  boardName?: string | null;
}) {
  const [stale, setStale] = useState(false);
  const dragFromHandle = useRef(false);

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

  const nextCol = adjacentColumn(mission.column, 1);
  const showReadyChip = mission.column !== "ready" && mission.column !== "done";

  return (
    <article
      draggable={false}
      onClick={(e) => {
        // Ignore clicks on action chips
        if ((e.target as HTMLElement).closest("[data-card-action]")) return;
        onSelect();
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-card-action]")) return;
        onOpen();
      }}
      className={cn(
        "group relative rounded-[var(--radius-md)] bg-bg-elevated p-3 shadow-[var(--shadow-border)] transition-[box-shadow,background-color,transform] duration-150 hover:shadow-[var(--shadow-border-hover)] hover:bg-bg-subtle",
        selected && "ring-2 ring-[var(--color-status-ready)]",
        stale && "ring-1 ring-status-human/40",
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <button
          type="button"
          data-card-action
          draggable
          title="Drag to another column"
          aria-label="Drag mission"
          className="mt-0.5 shrink-0 cursor-grab rounded p-0.5 text-fg-subtle opacity-40 transition-opacity hover:bg-bg-subtle hover:text-fg group-hover:opacity-100 active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            dragFromHandle.current = true;
            e.stopPropagation();
            e.dataTransfer.setData("text/mission-id", mission.id);
            e.dataTransfer.effectAllowed = "move";
            // Minimal ghost
            try {
              const ghost = document.createElement("div");
              ghost.textContent = mission.title;
              ghost.style.cssText =
                "position:fixed;top:-1000px;padding:6px 10px;background:#1a1a1e;color:#f4f4f5;border-radius:8px;font:12px sans-serif;max-width:200px";
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 10, 10);
              window.setTimeout(() => ghost.remove(), 0);
            } catch {
              /* ignore */
            }
            onDragStart(e);
          }}
          onDragEnd={() => {
            dragFromHandle.current = false;
          }}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
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
          {boardName ? (
            <p className="mt-0.5 truncate text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
              {boardName}
            </p>
          ) : null}
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
          {showReadyChip && onAdvanceReady ? (
            <button
              type="button"
              data-card-action
              title="Move to Ready"
              className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
              style={{
                background: "color-mix(in oklab, var(--color-status-ready) 25%, transparent)",
                color: "var(--color-status-ready)",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onAdvanceReady();
              }}
            >
              → Ready
            </button>
          ) : null}
          {onAdvanceNext && nextCol !== mission.column ? (
            <button
              type="button"
              data-card-action
              title={`Advance to ${nextCol}`}
              className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-fg-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg"
              onClick={(e) => {
                e.stopPropagation();
                onAdvanceNext();
              }}
            >
              →
            </button>
          ) : null}
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

