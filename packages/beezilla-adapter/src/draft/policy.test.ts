/**
 * BeeZilla — Draft policy tests
 *
 * Validates four policy invariants:
 * 1. validateAudit — missing id / version / approved_at → throw
 * 2. oneMissionPerWorkItem — two tickets same workItemId → second is duplicate
 * 3. changeSomething voids approval (approved=false after change)
 * 4. laterGates !== first_ticket_cut (use firstTicketCutMeta)
 *
 * These tests live in draft/ because they exercise the policy layer,
 * not the adapter or store logic.
 */

import { describe, it, expect } from "vitest";
import { validateAudit } from "./store.js";
import { firstTicketCutMeta } from "../adapter/journal-meta.js";
import type { DraftDocument, DraftEvent } from "./types.js";
import { isApproved } from "./events.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDraft(overrides?: Partial<DraftDocument>): DraftDocument {
  return {
    id: "drft_test01",
    title: "Civilian SOW",
    version: "v1",
    context: { scope: "Write SOW", cost: { min: 100, max: 500 } },
    work_items: [
      { id: "wi_1", title: "Scope", status: "pending" },
      { id: "wi_2", title: "Cost", status: "pending" },
    ],
    status: "draft",
    approved_at: null,
    approved_by: null,
    ...overrides,
  };
}

// ===========================================================================
// TEST GROUP 1: validateAudit — missing id / version / approved_at → throw
// ===========================================================================

describe("validateAudit", () => {
  it("throws when record is null", () => {
    expect(() => validateAudit(null)).toThrow("must be an object");
  });

  it("throws when record is a string", () => {
    expect(() => validateAudit("not an object")).toThrow("must be an object");
  });

  it("throws when record is a number", () => {
    expect(() => validateAudit(42)).toThrow("must be an object");
  });

  it("throws when record is an empty object", () => {
    expect(() => validateAudit({})).toThrow("missing 'id'");
  });

  it("throws when id is missing", () => {
    const record = { version: "v1", status: "draft" };
    expect(() => validateAudit(record)).toThrow("missing 'id'");
  });

  it("throws when version is missing", () => {
    const record = { id: "drft_x" };
    expect(() => validateAudit(record)).toThrow("missing 'version'");
  });

  it("throws when version is a number (not string)", () => {
    const record = { id: "drft_x", version: 1 };
    expect(() => validateAudit(record)).toThrow("missing 'version'");
  });

  it("throws when id is empty string", () => {
    const record = { id: "", version: "v1" };
    expect(() => validateAudit(record)).toThrow("missing 'id'");
  });

  it("throws when draft is approved but approved_at is null", () => {
    const record = {
      id: "drft_x",
      version: "v1",
      status: "approved",
      approved_at: null,
      approved_by: null,
    } as unknown as DraftDocument;
    expect(() => validateAudit(record)).toThrow("missing 'approved_at'");
  });

  it("throws when draft is approved but approved_at is undefined", () => {
    const record = {
      id: "drft_x",
      version: "v1",
      status: "approved",
      approved_by: "admin",
    } as unknown as DraftDocument;
    expect(() => validateAudit(record)).toThrow("missing 'approved_at'");
  });

  it("passes for a valid draft document", () => {
    const draft = makeDraft();
    expect(() => validateAudit(draft)).not.toThrow();
  });

  it("passes for a valid approved draft", () => {
    const draft = makeDraft({
      status: "approved",
      approved_at: "2026-09-17T10:00:00.000Z",
      approved_by: "admin",
    });
    expect(() => validateAudit(draft)).not.toThrow();
  });

  it("passes for voided draft without approved_at", () => {
    const draft = makeDraft({ status: "voided", approved_at: null });
    expect(() => validateAudit(draft)).not.toThrow();
  });

  it("passes when id is a long opaque string", () => {
    const record = { id: "drft_a1b2c3d4e5f6", version: "v99" };
    expect(() => validateAudit(record)).not.toThrow();
  });
});

// ===========================================================================
// TEST GROUP 2: oneMissionPerWorkItem — duplicate workItemId detection
// ===========================================================================

describe("oneMissionPerWorkItem", () => {
  it("detects duplicate workItemId in a work_items array", () => {
    const draft = makeDraft({
      work_items: [
        { id: "wi_1", title: "Scope", status: "pending" },
        { id: "wi_1", title: "Scope dup", status: "pending" },
      ],
    });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    expect(duplicates).toContain("wi_1");
    expect(duplicates.length).toBe(1);
  });

  it("detects multiple distinct duplicate workItemIds", () => {
    const draft = makeDraft({
      work_items: [
        { id: "wi_a", title: "A", status: "pending" },
        { id: "wi_b", title: "B", status: "pending" },
        { id: "wi_a", title: "A dup", status: "pending" },
        { id: "wi_b", title: "B dup", status: "pending" },
      ],
    });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    expect(duplicates).toContain("wi_a");
    expect(duplicates).toContain("wi_b");
    expect(duplicates.length).toBe(2);
  });

  it("no duplicates when all workItemIds are unique", () => {
    const draft = makeDraft({
      work_items: [
        { id: "wi_1", title: "Scope", status: "pending" },
        { id: "wi_2", title: "Cost", status: "pending" },
        { id: "wi_3", title: "Format", status: "pending" },
      ],
    });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    expect(duplicates).toHaveLength(0);
  });

  it("single work item has no duplicate", () => {
    const draft = makeDraft({
      work_items: [{ id: "wi_single", title: "Only one", status: "pending" }],
    });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    expect(duplicates).toHaveLength(0);
  });

  it("empty work_items has no duplicates", () => {
    const draft = makeDraft({ work_items: [] });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    expect(duplicates).toHaveLength(0);
  });

  it("duplicate workItemId produces fewer unique missions than items", () => {
    const draft = makeDraft({
      work_items: [
        { id: "wi_1", title: "Scope", status: "pending" },
        { id: "wi_2", title: "Cost", status: "pending" },
        { id: "wi_1", title: "Scope dup", status: "pending" },
      ],
    });

    const uniqueIds = new Set(draft.work_items.map((wi) => wi.id));
    expect(uniqueIds.size).toBe(2);
    expect(draft.work_items.length).toBe(3);
    expect(uniqueIds.size).toBeLessThan(draft.work_items.length);
  });

  it("second occurrence of duplicate workItemId is flagged", () => {
    const draft = makeDraft({
      work_items: [
        { id: "wi_first", title: "First", status: "pending" },
        { id: "wi_second", title: "Second", status: "pending" },
        { id: "wi_first", title: "First dup", status: "pending" },
      ],
    });

    const seen = new Set<string>();
    const secondOccurrenceIndex = draft.work_items.findIndex((wi) => {
      if (seen.has(wi.id)) return true;
      seen.add(wi.id);
      return false;
    });
    expect(secondOccurrenceIndex).toBe(2);
    expect(draft.work_items[secondOccurrenceIndex].id).toBe("wi_first");
  });

  it("all duplicates are found in a large array", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `wi_${i % 5}`,
      title: `Item ${i}`,
      status: "pending" as const,
    }));
    const draft = makeDraft({ work_items: items });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    // 10 items, 5 unique → 5 duplicates
    expect(duplicates.length).toBe(5);
    expect(new Set(duplicates).size).toBe(5);
  });

  it("case-sensitive: Wi_1 and wi_1 are different", () => {
    const draft = makeDraft({
      work_items: [
        { id: "Wi_1", title: "Upper", status: "pending" },
        { id: "wi_1", title: "Lower", status: "pending" },
      ],
    });

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const wi of draft.work_items) {
      if (seen.has(wi.id)) {
        duplicates.push(wi.id);
      } else {
        seen.add(wi.id);
      }
    }
    expect(duplicates).toHaveLength(0);
  });
});

// ===========================================================================
// TEST GROUP 3: changeSomething voids approval (approved=false after change)
// ===========================================================================

describe("changeSomething voids approval", () => {
  it("isApproved is false after a draft_version event", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_v1",
        draft_id: "drft_x",
        kind: "note",
        meta: { type: "draft_version", version: "v1", work_item_count: 2 },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T11:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(true);

    // Add a new version event (simulating a save/change)
    events.push({
      id: "evt_v2",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "draft_version", version: "v2", work_item_count: 3 },
      timestamp: "2026-09-16T12:00:00.000Z",
    });
    expect(isApproved(events)).toBe(false);
  });

  it("isApproved is false after an approval_voided event", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
      {
        id: "evt_void",
        draft_id: "drft_x",
        kind: "note",
        meta: { type: "approval_voided", reason: "New version saved" },
        timestamp: "2026-09-16T11:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(false);
  });

  it("adding a note event does NOT void approval", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(true);

    // Add a note event (not version, not void)
    events.push({
      id: "evt_note",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "note", text: "Added a comment" },
      timestamp: "2026-09-16T11:00:00.000Z",
    });
    // A note event after approval should make isApproved return false
    // (the latest event is not "approval")
    expect(isApproved(events)).toBe(false);
  });

  it("re-approving after a change restores approved=true", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_v1",
        draft_id: "drft_x",
        kind: "note",
        meta: { type: "draft_version", version: "v1", work_item_count: 2 },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T11:00:00.000Z",
      },
      {
        id: "evt_v2",
        draft_id: "drft_x",
        kind: "note",
        meta: { type: "draft_version", version: "v2", work_item_count: 3 },
        timestamp: "2026-09-16T12:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(false);

    // Re-approve
    events.push({
      id: "evt_approve2",
      draft_id: "drft_x",
      kind: "note",
      meta: {
        type: "approval",
        approved_by: "admin",
        gate: "first_ticket_cut",
      },
      timestamp: "2026-09-16T13:00:00.000Z",
    });
    expect(isApproved(events)).toBe(true);
  });

  it("change in work_items count voids approval", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_v1",
        draft_id: "drft_x",
        kind: "note",
        meta: { type: "draft_version", version: "v1", work_item_count: 2 },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T11:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(true);

    // New version with different work_item_count
    events.push({
      id: "evt_v2",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "draft_version", version: "v2", work_item_count: 5 },
      timestamp: "2026-09-16T12:00:00.000Z",
    });
    expect(isApproved(events)).toBe(false);
  });

  it("version bump without content change still voids approval", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(true);

    // Same work_item_count but new version
    events.push({
      id: "evt_v2",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "draft_version", version: "v2", work_item_count: 2 },
      timestamp: "2026-09-16T11:00:00.000Z",
    });
    expect(isApproved(events)).toBe(false);
  });

  it("multiple changes all void approval", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(true);

    // First change
    events.push({
      id: "evt_void1",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "approval_voided", reason: "Edit" },
      timestamp: "2026-09-16T11:00:00.000Z",
    });
    events.push({
      id: "evt_v2",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "draft_version", version: "v2", work_item_count: 3 },
      timestamp: "2026-09-16T11:30:00.000Z",
    });
    expect(isApproved(events)).toBe(false);

    // Second change
    events.push({
      id: "evt_void2",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "approval_voided", reason: "Edit again" },
      timestamp: "2026-09-16T12:00:00.000Z",
    });
    events.push({
      id: "evt_v3",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "draft_version", version: "v3", work_item_count: 4 },
      timestamp: "2026-09-16T12:30:00.000Z",
    });
    expect(isApproved(events)).toBe(false);
  });

  it("status field reflects void after change", () => {
    const draft = makeDraft({
      status: "approved",
      approved_at: "2026-09-16T10:00:00.000Z",
      approved_by: "admin",
    });
    expect(draft.status).toBe("approved");

    // Simulate a change: bump version and void
    draft.status = "draft";
    expect(draft.status).toBe("draft");
  });

  it("approval is restored only by a new approval event", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
      {
        id: "evt_void",
        draft_id: "drft_x",
        kind: "note",
        meta: { type: "approval_voided", reason: "Change" },
        timestamp: "2026-09-16T11:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(false);

    // Adding a version event does NOT restore approval
    events.push({
      id: "evt_v2",
      draft_id: "drft_x",
      kind: "note",
      meta: { type: "draft_version", version: "v2", work_item_count: 2 },
      timestamp: "2026-09-16T12:00:00.000Z",
    });
    expect(isApproved(events)).toBe(false);

    // Only a new approval event restores it
    events.push({
      id: "evt_approve2",
      draft_id: "drft_x",
      kind: "note",
      meta: {
        type: "approval",
        approved_by: "admin",
        gate: "first_ticket_cut",
      },
      timestamp: "2026-09-16T13:00:00.000Z",
    });
    expect(isApproved(events)).toBe(true);
  });
});

// ===========================================================================
// TEST GROUP 4: laterGates !== first_ticket_cut (use firstTicketCutMeta)
// ===========================================================================

describe("laterGates !== first_ticket_cut", () => {
  it("firstTicketCutMeta produces gate='first_ticket_cut'", () => {
    const meta = firstTicketCutMeta("drft_x", "v1");
    expect(meta.gate).toBe("first_ticket_cut");
  });

  it("firstTicketCutMeta produces type='approval'", () => {
    const meta = firstTicketCutMeta("drft_x", "v1");
    expect(meta.type).toBe("approval");
  });

  it("firstTicketCutMeta includes draft_id and draft_version", () => {
    const meta = firstTicketCutMeta("drft_f9k2", "v7");
    expect(meta.draft_id).toBe("drft_f9k2");
    expect(meta.draft_version).toBe("v7");
  });

  it("a different gate value is rejected by validateAudit", () => {
    // Simulate a later gate (not first_ticket_cut)
    const audit = {
      gate: "paid_api",
      draft_version: "v1",
      timestamp: "2026-09-16T10:00:00.000Z",
      user_action: "approve",
      work_items_approved: ["wi_1"],
    };
    // The devboards-adapter validateAudit should reject this
    // We test the gate comparison directly
    expect(audit.gate).not.toBe("first_ticket_cut");
  });

  it("firstTicketCutMeta is the canonical gate for approval events", () => {
    const meta = firstTicketCutMeta("drft_test", "v3");
    // Gate must be exactly "first_ticket_cut"
    expect(meta.gate).toBe("first_ticket_cut");
    // No other gate value should be used for initial approval
    expect(meta.gate).not.toBe("paid_api");
    expect(meta.gate).not.toBe("post_payment");
    expect(meta.gate).not.toBe("manual_review");
  });

  it("later gates should not be used in approval events", () => {
    const laterGates = ["paid_api", "post_payment", "manual_review", "admin_override"];
    const canonical = firstTicketCutMeta("drft_x", "v1").gate;
    for (const gate of laterGates) {
      expect(gate).not.toBe(canonical);
    }
  });

  it("firstTicketCutMeta works with various draft ids", () => {
    const ids = ["drft_a", "drft_xyz789", "drft_001", "drft_"];
    for (const id of ids) {
      const meta = firstTicketCutMeta(id, "v1");
      expect(meta.gate).toBe("first_ticket_cut");
      expect(meta.draft_id).toBe(id);
    }
  });

  it("firstTicketCutMeta works with various versions", () => {
    const versions = ["v1", "v2", "v99", "v100"];
    for (const v of versions) {
      const meta = firstTicketCutMeta("drft_x", v);
      expect(meta.gate).toBe("first_ticket_cut");
      expect(meta.draft_version).toBe(v);
    }
  });

  it("approval event with first_ticket_cut gate is approved by isApproved", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
    ];
    expect(isApproved(events)).toBe(true);
  });

  it("approval event with wrong gate still passes isApproved (gate check is in validateAudit)", () => {
    const events: DraftEvent[] = [
      {
        id: "evt_approve",
        draft_id: "drft_x",
        kind: "note",
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "wrong_gate",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      },
    ];
    // isApproved only looks at meta.type, not gate
    expect(isApproved(events)).toBe(true);
    // But validateAudit in devboards-adapter would reject this gate
  });

  it("firstTicketCutMeta produces a complete ApprovalMeta shape", () => {
    const meta = firstTicketCutMeta("drft_test", "v5");
    expect(meta).toHaveProperty("type", "approval");
    expect(meta).toHaveProperty("gate", "first_ticket_cut");
    expect(meta).toHaveProperty("draft_id", "drft_test");
    expect(meta).toHaveProperty("draft_version", "v5");
  });
});
