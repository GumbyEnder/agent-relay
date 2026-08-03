import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { MissionCard } from "@/components/mission-card";
import type { Agent, Mission, MissionColumn } from "@/lib/types";
import { COLUMN_STATUS_COLOR, COLUMNS } from "@/lib/types";
import { adjacentColumn } from "@/lib/keyboard-ops";
import { cn } from "@/lib/utils";

export function BoardColumn({
  columnId,
  missions,
  agents,
  selectedId,
  onSelect,
  onOpen,
  onDropMission,
  onDragStart,
  onAddMission,
  onMoveMission,
  showBoardName = false,
  boardNameById = {},
}: {
  columnId: MissionColumn;
  missions: Mission[];
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onDropMission: (missionId: string, column: MissionColumn) => void;
  onDragStart: (missionId: string) => void;
  /** Open new-mission flow targeting this column */
  onAddMission?: (column: MissionColumn) => void;
  onMoveMission?: (missionId: string, column: MissionColumn) => void;
  /** All-boards mode: label each card with its board name */
  showBoardName?: boolean;
  boardNameById?: Record<string, string>;
}) {
  const meta = COLUMNS.find((c) => c.id === columnId)!;
  const agentMap = Object.fromEntries(agents.map((a) => [a.id, a]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <section
      className={cn(
        "flex w-[min(86vw,280px)] shrink-0 flex-col rounded-[var(--radius-lg)] bg-bg/40 transition-shadow sm:w-[280px]",
        dragOver && "ring-2 ring-[var(--color-status-ready)] bg-[color-mix(in_oklab,var(--color-status-ready)_8%,transparent)]",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const id = e.dataTransfer.getData("text/mission-id");
        if (id) onDropMission(id, columnId);
      }}
      onContextMenu={(e) => {
        // Column chrome context menu (not inside a card action)
        if ((e.target as HTMLElement).closest("[data-card-action]")) return;
        if ((e.target as HTMLElement).closest("article")) return;
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <header className="sticky top-0 z-10 mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-md)] bg-bg/90 px-2 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: COLUMN_STATUS_COLOR[columnId] }}
          />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-fg">{meta.label}</h2>
            <p className="truncate text-[11px] text-fg-subtle">{meta.hint}</p>
          </div>
        </div>
        <div className="relative flex shrink-0 items-center gap-1" ref={menuRef}>
          {onAddMission && (
            <button
              type="button"
              title={`New mission in ${meta.label}`}
              aria-label={`New mission in ${meta.label}`}
              className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
              onClick={() => onAddMission(columnId)}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title="Column menu"
            aria-label="Column menu"
            aria-expanded={menuOpen}
            className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          <span className="tabular rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-fg-muted">
            {missions.length}
          </span>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-[var(--radius-sm)] border border-border bg-bg-elevated py-1 shadow-[var(--shadow-panel)]">
              {onAddMission && (
                <button
                  type="button"
                  className="flex w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-bg-subtle"
                  onClick={() => {
                    setMenuOpen(false);
                    onAddMission(columnId);
                  }}
                >
                  New mission here
                </button>
              )}
              <button
                type="button"
                className="flex w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-bg-subtle"
                onClick={() => {
                  setMenuOpen(false);
                  document
                    .querySelector<HTMLInputElement>("input[placeholder^='Search']")
                    ?.focus();
                }}
              >
                Focus search
              </button>
              <p className="border-t border-border px-3 py-1.5 text-[10px] text-fg-subtle">
                {meta.label} · {missions.length} tickets
              </p>
            </div>
          )}
        </div>
      </header>

      <div
        className={cn(
          "flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto px-1 pb-3 scrollbar-thin",
        )}
      >
        {missions.map((m) => (
          <MissionCard
            key={m.id}
            mission={m}
            agent={
              (m.claimedBy && agentMap[m.claimedBy]) ||
              (m.assigneeId && agentMap[m.assigneeId]) ||
              undefined
            }
            selected={selectedId === m.id}
            boardName={
              showBoardName
                ? boardNameById[m.projectId] ?? m.projectId
                : null
            }
            onSelect={() => onSelect(m.id)}
            onOpen={() => onOpen(m.id)}
            onDragStart={() => onDragStart(m.id)}
            onAdvanceReady={
              onMoveMission && m.column !== "ready"
                ? () => onMoveMission(m.id, "ready")
                : undefined
            }
            onAdvanceNext={
              onMoveMission
                ? () => onMoveMission(m.id, adjacentColumn(m.column, 1))
                : undefined
            }
          />
        ))}
        {missions.length === 0 && (
          <button
            type="button"
            disabled={!onAddMission}
            onClick={() => onAddMission?.(columnId)}
            className={cn(
              "flex flex-1 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-border px-3 py-8 text-center text-xs text-fg-subtle",
              onAddMission && "cursor-pointer transition-colors hover:border-fg-subtle hover:text-fg-muted",
              dragOver && "border-[var(--color-status-ready)] text-[var(--color-status-ready)]",
            )}
          >
            {onAddMission ? `Drop here or + add to ${meta.label}` : "Drop missions here"}
          </button>
        )}
      </div>
    </section>
  );
}
