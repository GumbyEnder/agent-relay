/**
 * Client/server filter predicates for Live feed and Board tags.
 */
import type { Mission, MissionEvent, MissionHistoryEntry } from "./types";

export interface LiveFilter {
  agentId?: string | null;
  /** event kind or history actorKind / special "move" */
  kind?: string | null;
  query?: string | null;
}

export function filterMissionsByTag(missions: Mission[], tag: string | null | undefined): Mission[] {
  const t = tag?.trim().toLowerCase();
  if (!t) return missions;
  return missions.filter((m) => m.tags.some((x) => x.toLowerCase() === t || x.toLowerCase().includes(t)));
}

export function filterEvents(events: MissionEvent[], f: LiveFilter): MissionEvent[] {
  const agent = f.agentId?.trim() || null;
  const kind = f.kind?.trim().toLowerCase() || null;
  const q = f.query?.trim().toLowerCase() || null;
  return events.filter((e) => {
    if (agent && e.agentId !== agent) return false;
    if (kind && e.kind.toLowerCase() !== kind && !e.kind.toLowerCase().includes(kind)) return false;
    if (q && !e.message.toLowerCase().includes(q) && !(e.missionId ?? "").toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

export function filterHistory(history: MissionHistoryEntry[], f: LiveFilter): MissionHistoryEntry[] {
  const agent = f.agentId?.trim() || null;
  const kind = f.kind?.trim().toLowerCase() || null;
  const q = f.query?.trim().toLowerCase() || null;
  return history.filter((h) => {
    if (agent && h.actorId !== agent && h.actorName !== agent) return false;
    if (kind) {
      if (kind === "move" || kind === "mission_moved") {
        /* history rows are moves */
      } else if (h.actorKind.toLowerCase() !== kind && !(h.note ?? "").toLowerCase().includes(kind)) {
        return false;
      }
    }
    if (q) {
      const hay = `${h.missionId} ${h.actorName ?? ""} ${h.note ?? ""} ${h.fromColumn ?? ""} ${h.toColumn}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
