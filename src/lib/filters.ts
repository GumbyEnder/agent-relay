/**
 * Client/server filter predicates for Live feed and Board tags.
 */
import type { Mission, MissionEvent, MissionHistoryEntry } from "./types";

export interface LiveFilter {
  agentId?: string | null;
  /** event kind or history actorKind / special "move" */
  kind?: string | null;
  query?: string | null;
  /** Board id when viewing All boards */
  projectId?: string | null;
}

export const LIVE_FILTERS_STORAGE_KEY = "devboards-live-filters";

export function readLiveFilters(): LiveFilter {
  try {
    const raw = localStorage.getItem(LIVE_FILTERS_STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as LiveFilter;
    return {
      agentId: p.agentId ?? null,
      kind: p.kind ?? null,
      query: p.query ?? null,
      projectId: p.projectId ?? null,
    };
  } catch {
    return {};
  }
}

export function writeLiveFilters(f: LiveFilter): void {
  try {
    localStorage.setItem(
      LIVE_FILTERS_STORAGE_KEY,
      JSON.stringify({
        agentId: f.agentId || null,
        kind: f.kind || null,
        query: f.query || null,
        projectId: f.projectId || null,
      }),
    );
  } catch {
    /* ignore */
  }
}

export function liveFiltersActive(f: LiveFilter): boolean {
  return Boolean(
    f.agentId?.trim() || f.kind?.trim() || f.query?.trim() || f.projectId?.trim(),
  );
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
  const project = f.projectId?.trim() || null;
  return events.filter((e) => {
    if (project && e.projectId && e.projectId !== project) return false;
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
  const project = f.projectId?.trim() || null;
  return history.filter((h) => {
    if (project && h.projectId && h.projectId !== project) return false;
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
