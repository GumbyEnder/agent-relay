/**
 * BeeZilla — Draft types
 *
 * Types for the draft-holder mission workflow.
 * Drafts live on a single DRAFT-HOLDER mission in ar_missions;
 * each version / approval / void is a kind=note event in ar_events.
 */

// ---------------------------------------------------------------------------
// Draft document
// ---------------------------------------------------------------------------

/** A work item inside a draft */
export interface DraftWorkItem {
  id: string;
  title: string;
  status: "pending" | "approved";
}

/**
 * DraftDocument — the full draft payload stored in the holder mission's
 * context field as JSON.
 *
 * Fields come from DRAFT-THEN-TICKETS-GATE (mission 9303).
 */
export interface DraftDocument {
  /** Unique draft id (opaque) */
  id: string;
  /** Human-readable title */
  title: string;
  /** Version string (v1, v2, …) — incremented on each save */
  version: string;
  /** JSON-serialisable payload the agent builds (scope, cost, etc.) */
  context: Record<string, unknown>;
  /** Work items extracted from context — written back into context on save */
  work_items: DraftWorkItem[];
  /** Current lifecycle status */
  status: "draft" | "approved" | "voided";
  /** ISO timestamp when approved (null until approved) */
  approved_at: string | null;
  /** Who approved (null until approved) */
  approved_by: string | null;
}

// ---------------------------------------------------------------------------
// Draft event (kind=note stored in ar_events)
// ---------------------------------------------------------------------------

/** Event meta for draft-version notes */
export interface DraftVersionMeta {
  type: "draft_version";
  version: string;
  work_item_count: number;
}

/** Event meta for approval notes */
export interface ApprovalMeta {
  type: "approval";
  approved_by: string;
  gate: "first_ticket_cut";
}

/** Event meta for void notes */
export interface VoidMeta {
  type: "approval_voided";
  reason: string;
}

/** Union of all draft event meta shapes */
export type DraftEventMeta = DraftVersionMeta | ApprovalMeta | VoidMeta;

/**
 * A draft event — stored as a kind=note event in ar_events,
 * linked to the holder mission via mission_id.
 */
export interface DraftEvent {
  /** Unique event id */
  id: string;
  /** The draft id this event belongs to */
  draft_id: string;
  /** Always "note" — stored in ar_events.kind */
  kind: "note";
  /** Event subtype */
  meta: DraftEventMeta;
  /** ISO timestamp */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Mission store interface (injected, not imported from board-store)
// ---------------------------------------------------------------------------

/**
 * Minimal interface the draft store uses to persist to Dev Boards.
 * The real board-store.server.ts implements this; tests inject a fake.
 */
export interface DraftMissionStore {
  /** Get a mission by id (returns null if not found) */
  getMission(missionId: string): Promise<StoredMission | null>;
  /** Upsert (create or update) a mission */
  upsertMission(mission: StoredMission): Promise<void>;
  /** Append an event to a mission's event log */
  appendEvent(missionId: string, event: StoredEvent): Promise<void>;
  /** List missions matching a tag filter */
  listMissionsByTag(tag: string): Promise<StoredMission[]>;
}

/** A mission as stored in ar_missions */
export interface StoredMission {
  id: string;
  title: string;
  objective: string;
  context: string;
  constraints: string;
  acceptance: string;
  column: string;
  priority: string;
  tags: string[];
  assigneeId: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  lastHeartbeat: number | null;
  progressNote: string;
  artifacts: string[];
  createdAt: number;
  updatedAt: number;
  delivery?: string | null;
  externalId?: string | null;
  source?: string | null;
}

/** An event as stored in ar_events */
export interface StoredEvent {
  id: string;
  mission_id: string;
  kind: string;
  meta: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Civilian view helpers
// ---------------------------------------------------------------------------

/**
 * Strip internal/dev jargon from a civilian-facing string.
 * Removes mission, column, tag, ticket, work-item language.
 */
export function stripCivilianJargon(text: string): string {
  const jargonWords = [
    "mission", "column", "tag", "ticket", "work-item",
    "work item", "Dev Boards", "board", "project",
  ];
  let result = text;
  for (const word of jargonWords) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    result = result.replace(regex, "");
  }
  // Collapse whitespace
  return result.replace(/\s{2,}/g, " ").trim();
}
