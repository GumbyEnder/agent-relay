import { Plus } from "lucide-react";
import { MissionCard } from "@/components/mission-card";
import type { Agent, Mission, MissionColumn } from "@/lib/types";
import { COLUMN_STATUS_COLOR, COLUMNS } from "@/lib/types";
import { cn } from "@/lib/utils";

export function BoardColumn({
  columnId,
  missions,
  agents,
  selectedId,
  onOpen,
  onDropMission,
  onDragStart,
  onAddMission,
}: {
  columnId: MissionColumn;
  missions: Mission[];
  agents: Agent[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDropMission: (missionId: string, column: MissionColumn) => void;
  onDragStart: (missionId: string) => void;
  /** Open new-mission flow targeting this column */
  onAddMission?: (column: MissionColumn) => void;
}) {
  const meta = COLUMNS.find((c) => c.id === columnId)!;
  const agentMap = Object.fromEntries(agents.map((a) => [a.id, a]));

  return (
    <section
      className="flex w-[min(86vw,280px)] shrink-0 flex-col rounded-[var(--radius-lg)] bg-bg/40 sm:w-[280px]"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/mission-id");
        if (id) onDropMission(id, columnId);
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
        <div className="flex shrink-0 items-center gap-1">
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
          <span className="tabular rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-fg-muted">
            {missions.length}
          </span>
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
            onOpen={() => onOpen(m.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/mission-id", m.id);
              e.dataTransfer.effectAllowed = "move";
              onDragStart(m.id);
            }}
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
            )}
          >
            {onAddMission ? `Drop here or + add to ${meta.label}` : "Drop missions here"}
          </button>
        )}
      </div>
    </section>
  );
}
