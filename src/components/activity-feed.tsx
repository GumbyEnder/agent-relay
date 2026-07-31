import { RelativeTime } from "@/components/relative-time";
import type { MissionEvent } from "@/lib/types";

export function ActivityFeed({ events }: { events: MissionEvent[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-fg">Ops feed</h2>
        <p className="text-xs text-fg-subtle">Claims, heartbeats, escalations</p>
      </div>
      <ul className="flex-1 space-y-0 overflow-y-auto scrollbar-thin">
        {events.slice(0, 40).map((ev) => (
          <li
            key={ev.id}
            className="border-b border-border/60 px-4 py-2.5 last:border-0"
          >
            <p className="text-xs leading-relaxed text-fg">{ev.message}</p>
            <p className="mt-1 text-[11px] text-fg-subtle tabular">
              <RelativeTime ts={ev.at} /> · {ev.kind.replace(/_/g, " ")}
            </p>
          </li>
        ))}
        {events.length === 0 && (
          <li className="px-4 py-8 text-center text-xs text-fg-subtle">
            No events yet
          </li>
        )}
      </ul>
    </div>
  );
}
