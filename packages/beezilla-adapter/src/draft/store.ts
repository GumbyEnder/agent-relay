/**
 * BeeZilla — Draft store
 *
 * Functions that manage the draft-holder mission lifecycle using an
 * injected DraftMissionStore. No live DB — the store is provided at
 * call time so tests can inject a fake.
 *
 * Policy:
 * - One DRAFT-HOLDER mission per draft.
 * - saveDraft: upserts the holder mission with context JSON and tags.
 * - approveDraft: writes ONLY the audit event; does NOT create work-item missions.
 * - bumpVersion: increments version, voids approval if currently approved.
 * - loadDraft: reads the holder mission and parses context back to DraftDocument.
 */

import type {
  DraftDocument,
  DraftEvent,
  DraftMissionStore,
  StoredEvent,
  StoredMission,
} from "./types.js";
import { HOLDER_TAGS, statusTag, versionTag } from "./tags.js";
import {
  buildApprovalEvent,
  buildDraftVersionEvent,
  buildVoidEvent,
  isApproved,
} from "./events.js";

// ---------------------------------------------------------------------------
// validateAudit — thin export: reject records missing id / version / approved_at
// ---------------------------------------------------------------------------

/**
 * Validate that a draft record has the required id, version, and
 * approved_at fields before proceeding with store operations.
 * Throws on missing fields so callers fail fast.
 */
export function validateAudit(record: unknown): asserts record is DraftDocument {
  if (!record || typeof record !== "object") {
    throw new Error("Refused: audit record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (!r.id || typeof r.id !== "string") {
    throw new Error("Refused: audit record missing 'id'");
  }
  if (!r.version || typeof r.version !== "string") {
    throw new Error("Refused: audit record missing 'version'");
  }
  // approved_at is required once the draft reaches approval state
  if (r.status === "approved" && (r.approved_at === undefined || r.approved_at === null)) {
    throw new Error("Refused: approved draft missing 'approved_at'");
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAFT_HOLDER_TITLE = "Draft — Awaiting Approval";

// ---------------------------------------------------------------------------
// Helper: serialize / deserialize context
// ---------------------------------------------------------------------------

function serializeContext(doc: DraftDocument): string {
  return JSON.stringify(doc, null, 2);
}

function deserializeContext(raw: string): DraftDocument {
  return JSON.parse(raw) as DraftDocument;
}

// ---------------------------------------------------------------------------
// Helper: build the holder mission
// ---------------------------------------------------------------------------

function buildHolderMission(
  draftId: string,
  doc: DraftDocument,
  events: DraftEvent[],
): StoredMission {
  const tags = [...HOLDER_TAGS, versionTag(doc.version)];

  // If approved, add status tag
  if (doc.status === "approved") {
    tags.push(statusTag("approved"));
  } else if (doc.status === "voided") {
    tags.push(statusTag("voided"));
  }

  return {
    id: `draft_${draftId}`,
    title: DRAFT_HOLDER_TITLE,
    objective: `Draft project: ${doc.title}`,
    context: serializeContext(doc),
    constraints: `Version ${doc.version} — ${doc.work_items.length} work items`,
    acceptance: "User approves the draft",
    column: "inbox",
    priority: "p1",
    tags,
    assigneeId: null,
    claimedBy: null,
    claimedAt: null,
    lastHeartbeat: null,
    progressNote:
      doc.status === "approved"
        ? "Approved — awaiting ticket cut"
        : "Draft in progress",
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: "beezilla-draft",
  };
}

// ---------------------------------------------------------------------------
// saveDraft — upsert the holder mission with current context
// ---------------------------------------------------------------------------

/**
 * Save (or update) a draft.
 *
 * - Upserts the DRAFT-HOLDER mission with the full DraftDocument in context.
 * - Appends a draft_version event.
 * - Returns the mission id.
 */
export async function saveDraft(
  store: DraftMissionStore,
  draft: DraftDocument,
  events: DraftEvent[],
): Promise<string> {
  // If approved, void it first (save invalidates approval)
  if (draft.status === "approved") {
    const voidEvent = buildVoidEvent(draft.id, "New version saved");
    const storedEvent: StoredEvent = {
      id: voidEvent.id,
      mission_id: `draft_${draft.id}`,
      kind: voidEvent.kind,
      meta: voidEvent.meta as unknown as Record<string, unknown>,
      created_at: voidEvent.timestamp,
    };
    await store.appendEvent(`draft_${draft.id}`, storedEvent);
    events.push(voidEvent);
    draft.status = "draft";
  }

  // Increment version on each save
  const versionNum = parseInt(draft.version.replace("v", ""), 10);
  draft.version = `v${versionNum + 1}`;

  const mission = buildHolderMission(draft.id, draft, events);
  await store.upsertMission(mission);

  // Append draft_version event
  const versionEvent = buildDraftVersionEvent(
    draft.id,
    draft.version,
    draft.work_items.length,
  );
  const storedEvent: StoredEvent = {
    id: versionEvent.id,
    mission_id: mission.id,
    kind: versionEvent.kind,
    meta: versionEvent.meta as unknown as Record<string, unknown>,
    created_at: versionEvent.timestamp,
  };
  await store.appendEvent(mission.id, storedEvent);
  events.push(versionEvent);

  return mission.id;
}

// ---------------------------------------------------------------------------
// loadDraft — read holder mission and parse context
// ---------------------------------------------------------------------------

/**
 * Load a draft from the holder mission.
 *
 * - Finds the holder mission by tag.
 * - Parses context JSON back to DraftDocument.
 * - Derives approval state from events.
 */
export async function loadDraft(
  store: DraftMissionStore,
  draftId: string,
  events: DraftEvent[],
): Promise<DraftDocument | null> {
  // Find the holder mission
  const missions = await store.listMissionsByTag(`beezilla:draft-holder`);
  const holder = missions.find((m) => m.id === `draft_${draftId}`);

  if (!holder) return null;

  const doc = deserializeContext(holder.context);

  // Derive approval state from events
  const approved = isApproved(events);
  if (approved && doc.status !== "approved") {
    doc.status = "approved";
  } else if (!approved && doc.status === "approved") {
    // If events say not approved but doc says approved, it was voided
    doc.status = "draft";
  }

  return doc;
}

// ---------------------------------------------------------------------------
// bumpVersion — increment version, void approval if active
// ---------------------------------------------------------------------------

/**
 * Bump the draft version.
 *
 * If the draft is currently approved, writes a void event first.
 * Returns the new version string.
 */
export async function bumpVersion(
  store: DraftMissionStore,
  draft: DraftDocument,
  events: DraftEvent[],
): Promise<string> {
  // If approved, void it first
  if (draft.status === "approved") {
    const voidEvent = buildVoidEvent(draft.id, "New version saved");
    const storedEvent: StoredEvent = {
      id: voidEvent.id,
      mission_id: `draft_${draft.id}`,
      kind: voidEvent.kind,
      meta: voidEvent.meta as unknown as Record<string, unknown>,
      created_at: voidEvent.timestamp,
    };
    await store.appendEvent(`draft_${draft.id}`, storedEvent);
    events.push(voidEvent);
    draft.status = "draft";
  }

  // Increment version
  const versionNum = parseInt(draft.version.replace("v", ""), 10);
  const newVersion = `v${versionNum + 1}`;
  draft.version = newVersion;

  return newVersion;
}

// ---------------------------------------------------------------------------
// approveDraft — write audit event ONLY, no work-item missions
// ---------------------------------------------------------------------------

/**
 * Approve the draft.
 *
 * - Writes ONLY the approval audit event to the mission's event log.
 * - Does NOT create work-item missions (that's createMissionsAfterApprove's job).
 * - Returns the event that was written.
 */
export async function approveDraft(
  store: DraftMissionStore,
  draft: DraftDocument,
  events: DraftEvent[],
  approvedBy: string,
): Promise<DraftEvent> {
  // Check if already approved
  if (isApproved(events)) {
    throw new Error("Draft is already approved");
  }

  // Check completeness — must have at least one work item
  if (draft.work_items.length === 0) {
    throw new Error("Cannot approve draft with no work items");
  }

  // Latest version is highest vN, not newest timestamp (saves can share a second).
  const versionEvents = events.filter((e) => e.meta.type === "draft_version");
  if (versionEvents.length > 0) {
    const n = (v: unknown) =>
      parseInt(String(v ?? "").replace(/^v/i, ""), 10) || 0;
    const latest = versionEvents.reduce((a, b) =>
      n((b.meta as { version?: string }).version) >
      n((a.meta as { version?: string }).version)
        ? b
        : a,
    );
    if ((latest.meta as { version?: string }).version !== draft.version) {
      throw new Error("Cannot approve stale version");
    }
  }

  // Update draft status
  draft.status = "approved";
  draft.approved_at = new Date().toISOString();
  draft.approved_by = approvedBy;

  // Build and write the first_ticket_cut audit event (NO work-item missions)
  const approvalEvent = buildApprovalEvent(draft, approvedBy);
  const storedEvent: StoredEvent = {
    id: approvalEvent.id,
    mission_id: `draft_${draft.id}`,
    kind: approvalEvent.kind,
    meta: approvalEvent.meta as unknown as Record<string, unknown>,
    created_at: approvalEvent.timestamp,
  };
  await store.appendEvent(`draft_${draft.id}`, storedEvent);
  events.push(approvalEvent);

  // Update the holder mission tags
  const mission = await store.getMission(`draft_${draft.id}`);
  if (mission) {
    mission.tags = [
      ...HOLDER_TAGS,
      versionTag(draft.version),
      statusTag("approved"),
    ];
    mission.progressNote = "Approved — awaiting ticket cut";
    mission.updatedAt = Date.now();
    await store.upsertMission(mission);
  }

  return approvalEvent;
}
