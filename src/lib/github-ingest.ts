/**
 * Map GitHub issue payloads → mission upsert fields.
 * Pure: no DB. board-store calls this then persists.
 */
import type { MissionColumn, Priority } from "./types";

export interface GitHubIssueLike {
  id?: number | string;
  number: number;
  title: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  labels?: Array<string | { name?: string }>;
  repository?: { full_name?: string };
  repository_full_name?: string;
}

export interface GitHubIngestInput {
  action?: string;
  issue: GitHubIssueLike;
  repository?: { full_name?: string };
  projectId?: string;
}

export interface MissionUpsertFromIssue {
  externalId: string;
  source: "github";
  projectId: string;
  title: string;
  objective: string;
  context: string;
  constraints: string;
  acceptance: string;
  column: MissionColumn;
  priority: Priority;
  tags: string[];
  artifacts: string[];
  closed: boolean;
}

function labelNames(issue: GitHubIssueLike): string[] {
  const raw = issue.labels ?? [];
  return raw
    .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function pickPriority(labels: string[]): Priority {
  for (const p of ["p0", "p1", "p2", "p3"] as Priority[]) {
    if (labels.includes(p) || labels.includes(`priority:${p}`)) return p;
  }
  if (labels.includes("critical") || labels.includes("urgent")) return "p0";
  if (labels.includes("high")) return "p1";
  if (labels.includes("low")) return "p3";
  return "p2";
}

function pickColumn(labels: string[], state?: string): MissionColumn {
  if (state === "closed") return "done";
  if (labels.includes("blocked")) return "blocked";
  if (labels.includes("ready-for-agent") || labels.includes("ready") || labels.includes("agent")) {
    return "ready";
  }
  return "inbox";
}

/** Stable external id: github:org/repo#123 */
export function githubExternalId(repoFullName: string, number: number): string {
  const repo = repoFullName.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  return `github:${repo}#${number}`;
}

export function mapGitHubIssueToMission(input: GitHubIngestInput): MissionUpsertFromIssue {
  const issue = input.issue;
  if (!issue || typeof issue.number !== "number" || !issue.title?.trim()) {
    throw new Error("Invalid GitHub issue payload: number and title required");
  }
  const repo =
    input.repository?.full_name ||
    issue.repository?.full_name ||
    issue.repository_full_name ||
    "unknown/unknown";
  const labels = labelNames(issue);
  const body = (issue.body ?? "").trim();
  const externalId = githubExternalId(repo, issue.number);
  const projectId = input.projectId?.trim() || "proj_default";
  const closed = issue.state === "closed" || input.action === "closed";

  return {
    externalId,
    source: "github",
    projectId,
    title: issue.title.trim().slice(0, 240),
    objective: body
      ? body.split(/\n\n/)[0]!.slice(0, 500)
      : `Resolve GitHub issue ${repo}#${issue.number}`,
    context: [
      `GitHub issue ${repo}#${issue.number}`,
      issue.html_url ? `URL: ${issue.html_url}` : "",
      body ? `\n${body}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000),
    constraints: "Do not expand scope beyond the issue. Escalate if secrets or prod access needed.",
    acceptance: closed
      ? "Issue closed on GitHub."
      : "Issue acceptance criteria met; PR/CI green if code change; short delivery note.",
    column: pickColumn(labels, closed ? "closed" : issue.state),
    priority: pickPriority(labels),
    tags: Array.from(new Set(["github", ...labels])).slice(0, 20),
    artifacts: issue.html_url ? [issue.html_url] : [],
    closed,
  };
}


/** PR / check_run / workflow_run → artifact URL + optional issue external id */
export function extractArtifactFromGitHubPayload(body: Record<string, unknown>): {
  url: string;
  externalId?: string;
  note: string;
} | null {
  const repo =
    (body.repository as { full_name?: string } | undefined)?.full_name ?? "unknown/unknown";

  const pr = body.pull_request as
    | { html_url?: string; number?: number; title?: string; body?: string | null }
    | undefined;
  if (pr?.html_url) {
    // try link issue from body "Fixes #N"
    let externalId: string | undefined;
    const m = (pr.body ?? "").match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
    if (m) externalId = githubExternalId(repo, Number(m[1]));
    return {
      url: pr.html_url,
      externalId,
      note: `pull_request #${pr.number ?? "?"} ${pr.title ?? ""}`.trim(),
    };
  }

  const cr = body.check_run as { html_url?: string; details_url?: string; name?: string; conclusion?: string } | undefined;
  if (cr?.html_url || cr?.details_url) {
    return {
      url: (cr.html_url || cr.details_url) as string,
      note: `check_run ${cr.name ?? ""} ${cr.conclusion ?? ""}`.trim(),
    };
  }

  const wr = body.workflow_run as { html_url?: string; name?: string; conclusion?: string } | undefined;
  if (wr?.html_url) {
    return {
      url: wr.html_url,
      note: `workflow_run ${wr.name ?? ""} ${wr.conclusion ?? ""}`.trim(),
    };
  }
  return null;
}
