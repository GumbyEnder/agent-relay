/**
 * Export mission history as CSV or JSON.
 */
import type { MissionHistoryEntry } from "./types";

export function historyToJson(rows: MissionHistoryEntry[]): string {
  return JSON.stringify(
    rows.map((h) => ({
      id: h.id,
      missionId: h.missionId,
      projectId: h.projectId ?? null,
      actorId: h.actorId,
      actorName: h.actorName,
      actorKind: h.actorKind,
      fromColumn: h.fromColumn,
      toColumn: h.toColumn,
      at: h.at,
      atIso: new Date(h.at).toISOString(),
      note: h.note ?? null,
    })),
    null,
    2,
  );
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function historyToCsv(rows: MissionHistoryEntry[]): string {
  const header = [
    "id",
    "mission_id",
    "project_id",
    "actor_id",
    "actor_name",
    "actor_kind",
    "from_column",
    "to_column",
    "at",
    "at_iso",
    "note",
  ];
  const lines = [header.join(",")];
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  for (const h of sorted) {
    lines.push(
      [
        h.id,
        h.missionId,
        h.projectId ?? "",
        h.actorId ?? "",
        h.actorName ?? "",
        h.actorKind,
        h.fromColumn ?? "",
        h.toColumn,
        String(h.at),
        new Date(h.at).toISOString(),
        h.note ?? "",
      ]
        .map((c) => csvEscape(String(c)))
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
