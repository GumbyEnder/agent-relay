/**
 * BeeZilla — Journal Meta Tests
 *
 * Tests:
 * 1. firstTicketCutMeta returns correct shape with type, gate, draft_id, draft_version
 */

import { describe, it, expect } from "vitest";
import { firstTicketCutMeta } from "./journal-meta";

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("firstTicketCutMeta", () => {
  it("returns meta with type approval", () => {
    const meta = firstTicketCutMeta("drft_f9k2", "v3");
    expect(meta.type).toBe("approval");
  });

  it("returns meta with gate first_ticket_cut", () => {
    const meta = firstTicketCutMeta("drft_f9k2", "v3");
    expect(meta.gate).toBe("first_ticket_cut");
  });

  it("returns meta with correct draft_id", () => {
    const meta = firstTicketCutMeta("drft_f9k2", "v3");
    expect(meta.draft_id).toBe("drft_f9k2");
  });

  it("returns meta with correct draft_version", () => {
    const meta = firstTicketCutMeta("drft_f9k2", "v3");
    expect(meta.draft_version).toBe("v3");
  });

  it("works with different draft ids and versions", () => {
    const meta = firstTicketCutMeta("drft_abc", "v7");
    expect(meta.draft_id).toBe("drft_abc");
    expect(meta.draft_version).toBe("v7");
  });
});
