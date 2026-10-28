/**
 * BeeZilla — Draft event builders
 *
 * Builds kind=note events stored in ar_events for draft lifecycle.
 * Also provides isApproved — a pure function that derives current
 * approval state from the event list.
 */

import type { ApprovalMeta, DraftDocument, DraftEvent, DraftEventMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Event ID generation
// ---------------------------------------------------------------------------

/** Simple event id generator (prefix + random hex) */
function eventId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Build note events
// ---------------------------------------------------------------------------

/**
 * Build a draft-version event (kind=note, meta.type=draft_version).
 * Called when a draft is saved.
 */
export function buildDraftVersionEvent(
  draftId: string,
  version: string,
  workItemCount: number,
): DraftEvent {
  const meta: DraftEventMeta = {
    type: "draft_version",
    version,
    work_item_count: workItemCount,
  };
  return {
    id: eventId("evt_draft"),
    draft_id: draftId,
    kind: "note",
    meta,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a first-ticket-cut approval event (kind=note, meta.type=approval).
 * Called when the user approves the draft.
 * Does NOT create work-item missions — that happens elsewhere.
 */
export function buildApprovalEvent(
  draft: DraftDocument,
  approvedBy: string,
): DraftEvent {
  const costEnvelope =
    draft.context.cost as { min: number; max: number } | undefined;
  const meta: ApprovalMeta = {
    type: "approval",
    approved_by: approvedBy,
    gate: "first_ticket_cut",
    draft_id: draft.id,
    draft_version: draft.version,
    draft_snapshot_id: eventId("snap"),
    user_action: "approve",
    timestamp: new Date().toISOString(),
    cost_envelope_at_approve: costEnvelope ?? null,
    work_items_approved: draft.work_items.map(wi => wi.id),
    missions_created_after: [],
    snapshot: draft.context,
  };
  return {
    id: eventId("evt_approve"),
    draft_id: draft.id,
    kind: "note",
    meta,
    timestamp: meta.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Build an approval-voided event (kind=note, meta.type=approval_voided).
 * Called when a new version is saved while the draft is approved.
 */
export function buildVoidEvent(
  draftId: string,
  reason: string,
): DraftEvent {
  const meta: DraftEventMeta = {
    type: "approval_voided",
    reason,
  };
  return {
    id: eventId("evt_void"),
    draft_id: draftId,
    kind: "note",
    meta,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// isApproved — pure derivation from events
// ---------------------------------------------------------------------------

/**
 * Derive whether a draft is currently approved from its event list.
 *
 * Rules:
 * 1. Scan events in timestamp order.
 * 2. Latest event wins:
 *    - If latest meta.type is "approval" → approved = true
 *    - If latest meta.type is "approval_voided" → approved = false
 *    - If latest meta.type is "draft_version" → approved = false
 * 3. No events → approved = false
 *
 * This is a pure function — no I/O.
 */
export function isApproved(events: DraftEvent[]): boolean {
  if (events.length === 0) return false;

  // Sort by timestamp to find the latest
  const sorted = [...events].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const latest = sorted[sorted.length - 1];

  switch (latest.meta.type) {
    case "approval":
      return true;
    case "approval_voided":
      return false;
    case "draft_version":
      return false;
    default:
      return false;
  }
}
