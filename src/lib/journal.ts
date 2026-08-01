/**
 * Markdown journal projection from durable mission + history.
 * DB remains source of truth — this is read-only export.
 */
import type { Mission, MissionHistoryEntry } from "./types";

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

export function renderMissionJournalMarkdown(
  mission: Mission,
  history: MissionHistoryEntry[],
): string {
  const sorted = [...history].sort((a, b) => a.at - b.at);
  const lines: string[] = [
    `# ${mission.id} — ${mission.title}`,
    "",
    `- **Status:** ${mission.column}`,
    `- **Priority:** ${mission.priority}`,
    mission.claimedBy ? `- **Claimed by:** ${mission.claimedBy}` : "- **Claimed by:** —",
    mission.externalId ? `- **External:** ${mission.externalId}` : null,
    mission.source ? `- **Source:** ${mission.source}` : null,
    mission.projectId ? `- **Project:** ${mission.projectId}` : null,
    `- **Tags:** ${mission.tags.length ? mission.tags.join(", ") : "—"}`,
    "",
    "## Objective",
    "",
    mission.objective || "—",
    "",
    "## Context",
    "",
    mission.context || "—",
    "",
    "## Constraints",
    "",
    mission.constraints || "—",
    "",
    "## Acceptance",
    "",
    mission.acceptance || "—",
    "",
  ].filter((x): x is string => x != null);

  if (mission.delivery) {
    lines.push("## Delivery", "", mission.delivery, "");
  }
  if (mission.artifacts?.length) {
    lines.push("## Artifacts", "", ...mission.artifacts.map((a) => `- ${a}`), "");
  }

  lines.push(
    "## Timeline",
    "",
    "| When (UTC) | Actor | Kind | From | To | Note |",
    "|------------|-------|------|------|----|------|",
  );

  for (const h of sorted) {
    const actor = escCell(h.actorName || h.actorId || "system");
    const kind = escCell(h.actorKind);
    const from = escCell(h.fromColumn ?? "—");
    const to = escCell(h.toColumn);
    const note = escCell(h.note ?? "");
    lines.push(`| ${iso(h.at)} | ${actor} | ${kind} | ${from} | ${to} | ${note} |`);
  }

  if (sorted.length === 0) {
    lines.push("| — | — | — | — | — | No history yet |");
  }

  lines.push("");
  return lines.join("\n");
}

export function renderBoardJournalIndex(
  missions: Mission[],
  generatedAt = Date.now(),
): string {
  const lines = [
    "# Agent Relay journal index",
    "",
    `Generated: ${iso(generatedAt)}`,
    "",
    "| Mission | Title | Column | Priority | External |",
    "|---------|-------|--------|----------|----------|",
  ];
  for (const m of [...missions].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(
      `| ${m.id} | ${escCell(m.title)} | ${m.column} | ${m.priority} | ${escCell(m.externalId ?? "—")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
