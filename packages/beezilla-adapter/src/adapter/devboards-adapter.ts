/**
 * BeeZilla — Dev Boards Adapter
 * 
 * Maps Dev Boards missions to BeeZilla civilian cards.
 * Dev Boards owns all mission state; BeeZilla owns the user experience.
 * 
 * Gate policy (9303): createMissionsAfterApprove MUST refuse without
 * a durable first_ticket_cut audit record.
 */

import type {
  CivilianCard,
  CivilianStatus,
  DevBoardClient,
  DevBoardColumn,
  DevBoardMission,
  DraftApprovalAudit,
  MissionCreateRequest,
  MissionUsage,
  PollResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Column mapping: Dev Boards → Civilian
// ---------------------------------------------------------------------------

const COLUMN_MAP: Record<DevBoardColumn, CivilianStatus> = {
  inbox: "Waiting",
  ready: "Waiting",
  running: "Working",
  needs_human: "Needs you",
  review: "Done",
  done: "Done",
  blocked: "Needs you",
};

// ---------------------------------------------------------------------------
// toCivilianCard — strip internals, surface plain language
// ---------------------------------------------------------------------------

/**
 * Convert a Dev Boards mission to a civilian card.
 * Strips model ids, token counts, raw agent output, Dev Boards jargon.
 */
export function toCivilianCard(mission: DevBoardMission): CivilianCard {
  const status = COLUMN_MAP[mission.column] ?? "Waiting";

  // Extract draft version from tags if present
  const draftVersionTag = mission.tags.find((t) => t.startsWith("v") && /^\d+$/.test(t.slice(1)));
  const draftVersion = draftVersionTag ? draftVersionTag : undefined;

  // Extract work item id from tags if present
  const workItemTag = mission.tags.find((t) => t.startsWith("wi_"));
  const workItemId = workItemTag ? workItemTag.slice(3) : undefined;

  // Strip artifact URLs to display names
  const displayArtifacts = mission.artifacts.map((url) => {
    const parts = url.split("/");
    return parts[parts.length - 1] ?? url;
  });

  return {
    cardId: mission.id,
    title: mission.title,
    status,
    progressNote: mission.progressNote || "Waiting to start",
    artifacts: displayArtifacts,
    delivery: mission.delivery,
    _draftVersion: draftVersion,
    _workItemId: workItemId,
  };
}

// ---------------------------------------------------------------------------
// Gate enforcement
// ---------------------------------------------------------------------------

/**
 * Validate that an audit record is complete and has the correct gate.
 * Throws if the audit is missing, incomplete, or has the wrong gate.
 */
export function validateAudit(audit: unknown): asserts audit is DraftApprovalAudit {
  if (!audit || typeof audit !== "object") {
    throw new Error("Refused: no audit record provided");
  }

  const a = audit as Record<string, unknown>;

  // Check gate field
  if (a.gate !== "first_ticket_cut") {
    throw new Error(
      `Refused: audit gate is '${a.gate}', expected 'first_ticket_cut'`,
    );
  }

  // Check required fields
  if (!a.draft_version) {
    throw new Error("Refused: audit missing draft_version");
  }
  if (!a.timestamp) {
    throw new Error("Refused: audit missing timestamp");
  }
  if (!a.user_action) {
    throw new Error("Refused: audit missing user_action");
  }
  if (!a.work_items_approved || !Array.isArray(a.work_items_approved)) {
    throw new Error("Refused: audit missing work_items_approved");
  }
}

// ---------------------------------------------------------------------------
// Adapter verbs
// ---------------------------------------------------------------------------

/**
 * Create missions after draft approval.
 * 
 * Enforces the 9303 gate: refuses without a valid first_ticket_cut audit.
 * Creates one mission per approved work item.
 * 
 * @param audit — The draft approval audit record
 * @param client — Dev Boards client (inject for tests)
 * @param boardId — Board/project id to create missions on
 * @param agentName — Agent name to associate with missions
 * @returns List of created mission ids
 */
export async function createMissionsAfterApprove(
  audit: unknown,
  client: DevBoardClient,
  boardId: string,
  agentName: string,
): Promise<string[]> {
  // Gate enforcement — MUST throw without valid audit
  validateAudit(audit);

  const validAudit = audit as DraftApprovalAudit;
  const workItems = validAudit.work_items_approved;

  if (workItems.length === 0) {
    return [];
  }

  const missionIds: string[] = [];

  for (const workItem of workItems) {
    // Build mission title from work item id
    // Format: work item id → human-readable title
    const title = workItem
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    const tags = [
      validAudit.draft_version,
      `wi_${workItem}`,
      `beezilla:parent:${validAudit.draft_id}`,
      `beezilla:cut:${validAudit.draft_version}`,
    ];

    const request: MissionCreateRequest = {
      title,
      objective: `Complete the ${title.toLowerCase()} for the approved project draft`,
      context: `Draft version: ${validAudit.draft_version}`,
      constraints: `Cost envelope: $${validAudit.cost_envelope_at_approve.min_usd}–$${validAudit.cost_envelope_at_approve.max_usd} ${validAudit.cost_envelope_at_approve.currency}`,
      priority: "p1",
      tags,
      column: "inbox",
      projectId: boardId,
    };

    const response = await client.createMission(request);
    missionIds.push(response.mission.id);
  }

  return missionIds;
}

/**
 * Poll for ready missions.
 * 
 * @param client — Dev Boards client
 * @param agentName — Agent name to filter by
 * @param boardId — Board/project id
 * @param column — Column to poll (default: ready)
 * @returns Poll response with missions
 */
export async function poll(
  client: DevBoardClient,
  agentName: string,
  boardId: string,
  column: DevBoardColumn = "ready",
): Promise<PollResponse> {
  return client.getMissions({ column, agent: agentName, project: boardId });
}

/**
 * Claim a mission for an agent.
 * 
 * @param client — Dev Boards client
 * @param missionId — Mission id to claim
 * @param agentName — Agent name claiming the mission
 * @returns Success response
 */
export async function claim(
  client: DevBoardClient,
  missionId: string,
  agentName: string,
): Promise<{ ok: true }> {
  return client.claim(missionId, agentName);
}

/**
 * Record a heartbeat for a mission.
 * 
 * @param client — Dev Boards client
 * @param missionId — Mission id
 * @param agentName — Agent name
 * @param note — Progress note (optional)
 * @returns Success response
 */
export async function heartbeat(
  client: DevBoardClient,
  missionId: string,
  agentName: string,
  note?: string,
): Promise<{ ok: true }> {
  return client.heartbeat(missionId, agentName, note);
}

/**
 * Deliver a completed mission.
 * 
 * @param client — Dev Boards client
 * @param missionId — Mission id
 * @param agentName — Agent name
 * @param summary — Delivery summary
 * @param usage — Optional usage report
 * @returns Success response
 */
export async function deliver(
  client: DevBoardClient,
  missionId: string,
  agentName: string,
  summary: string,
  usage?: MissionUsage | null,
): Promise<{ ok: true }> {
  return client.deliver(missionId, agentName, summary, usage);
}

/**
 * Escalate a mission to human input.
 * 
 * @param client — Dev Boards client
 * @param missionId — Mission id
 * @param agentName — Agent name
 * @param question — Escalation question
 * @returns Success response
 */
export async function escalate(
  client: DevBoardClient,
  missionId: string,
  agentName: string,
  question: string,
): Promise<{ ok: true }> {
  return client.escalate(missionId, agentName, question);
}
