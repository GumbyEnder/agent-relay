/**
 * BeeZilla — Dev Boards Adapter Types
 * 
 * Types for the adapter that maps Dev Boards missions to BeeZilla civilian cards.
 */

// ---------------------------------------------------------------------------
// Audit types (gate enforcement)
// ---------------------------------------------------------------------------

/**
 * Audit record written at draft approval.
 * Defined in DRAFT-THEN-TICKETS-GATE.md (mission 9303).
 */
export interface DraftApprovalAudit {
  event: "draft_approved";
  draft_id: string;
  draft_version: string;
  draft_snapshot_id: string;
  user_action: string;
  timestamp: string;
  cost_envelope_at_approve: {
    min_usd: number;
    max_usd: number;
    currency: string;
  };
  work_items_approved: string[];
  missions_created_after: string[];
  gate: "first_ticket_cut";
}

/**
 * Audit record for later gates (paid service, publish, etc.).
 * Not used for mission creation — only `first_ticket_cut` gate applies.
 */
export interface LaterGateAudit {
  event: string;
  gate: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Mission types (Dev Boards API shapes)
// ---------------------------------------------------------------------------

/** Dev Boards mission column */
export type DevBoardColumn =
  | "inbox"
  | "ready"
  | "running"
  | "needs_human"
  | "review"
  | "done"
  | "blocked";

/** Dev Boards priority */
export type Priority = "p0" | "p1" | "p2" | "p3";

/** Self-reported usage on deliver */
export interface MissionUsage {
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  toolCalls?: number | Record<string, number>;
  estimatedUsd?: number;
  pricingSource?: string;
  raw?: Record<string, unknown>;
}

/** A Dev Boards mission — the source of truth */
export interface DevBoardMission {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  context: string;
  constraints: string;
  acceptance: string;
  column: DevBoardColumn;
  priority: Priority;
  tags: string[];
  assigneeId: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  lastHeartbeat: number | null;
  progressNote: string;
  artifacts: string[];
  createdAt: number;
  updatedAt: number;
  delivery?: string;
  externalId?: string | null;
  source?: string | null;
  usage?: MissionUsage | null;
}

/** Input for creating a mission via the adapter */
export interface MissionCreateRequest {
  title: string;
  objective: string;
  context?: string;
  constraints?: string;
  acceptance?: string;
  priority?: Priority;
  tags?: string[];
  column?: DevBoardColumn;
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Civilian types (BeeZilla user-facing)
// ---------------------------------------------------------------------------

/** Civilian-facing status labels */
export type CivilianStatus = "Waiting" | "Working" | "Needs you" | "Done";

/**
 * A civilian card — what the user sees on the BeeZilla board.
 * Stripped of all internal/dev jargon by toCivilianCard.
 */
export interface CivilianCard {
  /** Internal mission id — hidden from UI, used for actions */
  cardId: string;
  /** Plain-language title the user sees */
  title: string;
  /** Civilian status label */
  status: CivilianStatus;
  /** One-line progress note */
  progressNote: string;
  /** Display names for artifacts (not raw URLs) */
  artifacts: string[];
  /** Delivery summary when Done */
  delivery?: string;
  /** Hidden — draft version for Change-something routing */
  _draftVersion?: string;
  /** Hidden — work item id from approved draft */
  _workItemId?: string;
}

// ---------------------------------------------------------------------------
// Poll response types
// ---------------------------------------------------------------------------

/** Response from polling ready missions */
export interface PollResponse {
  ok: true;
  missions: DevBoardMission[];
}

/** Response from creating missions */
export interface CreateMissionsResponse {
  ok: true;
  missionIds: string[];
}

// ---------------------------------------------------------------------------
// Adapter client interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-like client the adapter uses to talk to Dev Boards.
 * Inject this in tests to avoid live API calls.
 */
export interface DevBoardClient {
  /** GET /missions?column=…&agent=…&project=… */
  getMissions(params: {
    column?: DevBoardColumn;
    agent?: string;
    project?: string;
  }): Promise<PollResponse>;

  /** POST /missions */
  createMission(input: MissionCreateRequest): Promise<{
    ok: true;
    mission: { id: string };
  }>;

  /** POST /missions/:id/claim */
  claim(missionId: string, agent: string): Promise<{ ok: true }>;

  /** POST /missions/:id/heartbeat */
  heartbeat(missionId: string, agent: string, note?: string): Promise<{ ok: true }>;

  /** POST /missions/:id/escalate */
  escalate(missionId: string, agent: string, question: string): Promise<{ ok: true }>;

  /** POST /missions/:id/deliver */
  deliver(
    missionId: string,
    agent: string,
    summary: string,
    usage?: MissionUsage | null,
  ): Promise<{ ok: true }>;

  /** POST /missions/:id/move */
  move(missionId: string, column: DevBoardColumn, actor?: string): Promise<{ ok: true }>;
}
