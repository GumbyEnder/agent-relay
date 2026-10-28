/**
 * BeeZilla — Journal meta helpers for draft approval events.
 *
 * Produces the `meta` object written into a kind=note event when a draft
 * passes the first_ticket_cut gate.
 */

import type { ApprovalMeta } from "../draft/types";

/**
 * Build a first_ticket_cut approval meta object for a draft event.
 *
 * @param draftId  — opaque draft id (e.g. "drft_f9k2")
 * @param version  — draft version string (e.g. "v3")
 * @returns ApprovalMeta ready to be stored in ar_events.meta
 */
export function firstTicketCutMeta(
  draftId: string,
  version: string,
): ApprovalMeta {
  return {
    type: "approval",
    gate: "first_ticket_cut",
    draft_id: draftId,
    draft_version: version,
  };
}
