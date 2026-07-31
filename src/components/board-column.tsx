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
}: {
  columnId: MissionColumn;
  missions: Mission[];
  agents: Agent[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDropMission: (missionId: string, column: MissionColumn) => void;
  onDragStart: (missionId: string) => void;
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
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: COLUMN_STATUS_COLOR[columnId] }}
          />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-fg">{meta.label}</h2>
            <p className="truncate text-[11px] text-fg-subtle">{meta.hint}</p>
          </div>
        </div>
        <span className="tabular rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-fg-muted">
          {missions.length}
        </span>
      </header>

      <div
        className={cn(
          "flex flex-1 flex-col gap-2 overflow-y-auto px-1 pb-3 scrollbar-thin",
          "min-h-[120px]",
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
          <div className="flex flex-1 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-border px-3 py-8 text-center text-xs text-fg-subtle">
            Drop missions here
          </div>
        )}
      </div>
    </section>
  );
}
