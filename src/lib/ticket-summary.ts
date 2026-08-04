/**
 * Lightweight AI-style ticket / sprint summary (no external LLM required).
 * Deterministic rollup for operators after a batch of Review/Done work.
 */
import type { Mission, MissionColumn } from "./types";

export interface TicketSummaryInput {
  missions: Mission[];
  /** Optional label e.g. "Last 7 days" or board name */
  scopeLabel?: string;
  now?: number;
}

export interface TicketSummary {
  scopeLabel: string;
  generatedAt: number;
  totals: Record<string, number>;
  byPriority: Record<string, number>;
  highlights: string[];
  markdown: string;
}

const COLS: MissionColumn[] = [
  "inbox",
  "ready",
  "running",
  "needs_human",
  "review",
  "done",
  "blocked",
];

export function summarizeTickets(input: TicketSummaryInput): TicketSummary {
  const now = input.now ?? Date.now();
  const scopeLabel = input.scopeLabel?.trim() || "Board";
  const totals: Record<string, number> = {};
  for (const c of COLS) totals[c] = 0;
  const byPriority: Record<string, number> = { p0: 0, p1: 0, p2: 0, p3: 0 };

  for (const m of input.missions) {
    totals[m.column] = (totals[m.column] ?? 0) + 1;
    byPriority[m.priority] = (byPriority[m.priority] ?? 0) + 1;
  }

  const highlights: string[] = [];
  const done = input.missions.filter((m) => m.column === "done").slice(0, 8);
  const review = input.missions.filter((m) => m.column === "review").slice(0, 8);
  const blocked = input.missions.filter((m) => m.column === "blocked" || m.column === "needs_human");

  if (done.length) {
    highlights.push(
      `Completed (${done.length} shown): ${done.map((m) => m.title).join("; ")}`,
    );
  }
  if (review.length) {
    highlights.push(
      `Awaiting accept (${review.length}): ${review.map((m) => m.title).join("; ")}`,
    );
  }
  if (blocked.length) {
    highlights.push(
      `Needs attention (${blocked.length}): ${blocked.map((m) => `[${m.column}] ${m.title}`).join("; ")}`,
    );
  }
  if ((totals.running ?? 0) > 0) {
    highlights.push(`${totals.running} still Running — check heartbeats.`);
  }
  if (!highlights.length) {
    highlights.push("No missions in scope.");
  }

  const lines = [
    `# ${scopeLabel} — ticket summary`,
    "",
    `_Generated ${new Date(now).toISOString()}_`,
    "",
    "## Columns",
    ...COLS.map((c) => `- **${c.replace(/_/g, " ")}**: ${totals[c] ?? 0}`),
    "",
    "## Priority mix",
    ...(["p0", "p1", "p2", "p3"] as const).map((p) => `- **${p}**: ${byPriority[p] ?? 0}`),
    "",
    "## Highlights",
    ...highlights.map((h) => `- ${h}`),
    "",
    "## Suggested next steps",
    totals.review
      ? `- Accept or bounce ${totals.review} Review ticket(s).`
      : "- Review queue is clear.",
    totals.needs_human || totals.blocked
      ? `- Unblock ${ (totals.needs_human ?? 0) + (totals.blocked ?? 0) } human/blocked item(s).`
      : "- No open human/blocked items.",
    totals.ready ? `- Agents can claim from Ready (${totals.ready}).` : "- Ready is empty — triage Inbox.",
    "",
  ];

  return {
    scopeLabel,
    generatedAt: now,
    totals,
    byPriority,
    highlights,
    markdown: lines.join("\n"),
  };
}
