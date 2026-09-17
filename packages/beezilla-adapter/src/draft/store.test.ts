/**
 * BeeZilla — Draft store tests
 *
 * In-memory fake store (not live prod). Tests:
 * 1. save → exactly one holder mission, v1, work_items in context, ZERO extra missions
 * 2. save again → v2, previous snapshot on event
 * 3. approve then save → approval_voided, isApproved false
 * 4. incomplete draft cannot approve
 * 5. isApproved derivation sequence
 * 6. civilian view helper strips mission/column/tag words
 */

import { describe, it, expect } from "vitest";
import { saveDraft, loadDraft, bumpVersion, approveDraft } from "./store.js";
import { isApproved } from "./events.js";
import { stripCivilianJargon } from "./types.js";
import type {
  DraftDocument,
  DraftEvent,
  DraftMissionStore,
  StoredEvent,
  StoredMission,
} from "./types.js";

// ---------------------------------------------------------------------------
// In-memory fake store — also exposes events for test assertions
// ---------------------------------------------------------------------------

function createFakeStore(): DraftMissionStore & {
  getEvents(missionId: string): StoredEvent[];
} {
  const missions: Map<string, StoredMission> = new Map();
  const eventsByMission: Map<string, StoredEvent[]> = new Map();
  const tagsToMissions: Map<string, string[]> = new Map();

  return {
    async getMission(id: string): Promise<StoredMission | null> {
      return missions.get(id) ?? null;
    },

    async upsertMission(mission: StoredMission): Promise<void> {
      missions.set(mission.id, mission);
      for (const tag of mission.tags) {
        if (!tagsToMissions.has(tag)) {
          tagsToMissions.set(tag, []);
        }
        if (!tagsToMissions.get(tag)!.includes(mission.id)) {
          tagsToMissions.get(tag)!.push(mission.id);
        }
      }
    },

    async appendEvent(missionId: string, event: StoredEvent): Promise<void> {
      if (!eventsByMission.has(missionId)) {
        eventsByMission.set(missionId, []);
      }
      eventsByMission.get(missionId)!.push(event);
    },

    async listMissionsByTag(tag: string): Promise<StoredMission[]> {
      const ids = tagsToMissions.get(tag) ?? [];
      return ids.map((id) => missions.get(id)!).filter(Boolean);
    },

    getEvents(missionId: string): StoredEvent[] {
      return eventsByMission.get(missionId) ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createDraft(overrides?: Partial<DraftDocument>): DraftDocument {
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

function createEvent(overrides: Partial<DraftEvent>): DraftEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    draft_id: "drft_test01",
    kind: "note",
    meta: { type: "draft_version", version: "v1", work_item_count: 2 },
    timestamp: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

// ===========================================================================
// TEST 1: save → exactly one holder mission, v1, work_items in context, ZERO
//         extra missions
// ===========================================================================

describe("saveDraft — single save", () => {
  it("creates exactly one holder mission with work_items in context, ZERO extra missions", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    const missionId = await saveDraft(store, draft, events);

    // Exactly one mission
    expect(missionId).toBe("draft_drft_test01");
    const missions = await store.listMissionsByTag("beezilla:draft-holder");
    expect(missions).toHaveLength(1);

    // Version bumped from v1 → v2
    expect(draft.version).toBe("v2");

    // Work items in context
    const stored = await store.getMission(missionId);
    expect(stored).not.toBeNull();
    const ctx = JSON.parse(stored!.context) as DraftDocument;
    expect(ctx.work_items).toHaveLength(2);
    expect(ctx.work_items[0].id).toBe("wi_1");

    // ZERO extra missions — only the holder exists
    expect(missions.length).toBe(1);
  });
});

// ===========================================================================
// TEST 2: save again → version increments, previous snapshot on event
// ===========================================================================

describe("saveDraft — second save", () => {
  it("increments version and keeps only one holder mission", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    // First save
    const id1 = await saveDraft(store, draft, events);
    expect(draft.version).toBe("v2");

    // Second save
    const id2 = await saveDraft(store, draft, events);
    expect(draft.version).toBe("v3");

    // Same mission id (upsert)
    expect(id1).toBe(id2);

    // Still only one holder mission
    const missions = await store.listMissionsByTag("beezilla:draft-holder");
    expect(missions).toHaveLength(1);

    // Context contains the latest snapshot (v3)
    const stored = await store.getMission(id1);
    const ctx = JSON.parse(stored!.context) as DraftDocument;
    expect(ctx.version).toBe("v3");
    expect(ctx.work_items).toHaveLength(2);

    // Two draft_version events were appended
    const missionEvents = store.getEvents("draft_drft_test01");
    expect(missionEvents.length).toBe(2);
    for (const ev of missionEvents) {
      expect(ev.meta.type).toBe("draft_version");
    }
  });
});

// ===========================================================================
// TEST 3: approve then save → approval_voided, isApproved false
// ===========================================================================

describe("approve then save → approval_voided", () => {
  it("voids approval when draft is saved after approval", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    // Save draft
    await saveDraft(store, draft, events);

    // Approve
    await approveDraft(store, draft, events, "admin");
    expect(isApproved(events)).toBe(true);
    expect(draft.status).toBe("approved");

    // Save again → should void
    await saveDraft(store, draft, events);

    // Now isApproved should be false (latest event is draft_version, not approval)
    expect(isApproved(events)).toBe(false);
    expect(draft.status).toBe("draft");
  });
});

// ===========================================================================
// TEST 4: incomplete draft cannot approve
// ===========================================================================

describe("approveDraft — completeness check", () => {
  it("rejects approval when work_items is empty", async () => {
    const store = createFakeStore();
    const draft = createDraft({ work_items: [] });
    const events: DraftEvent[] = [];

    await saveDraft(store, draft, events);

    await expect(
      approveDraft(store, draft, events, "admin"),
    ).rejects.toThrow("Cannot approve draft with no work items");
  });

  it("rejects approval when draft is already approved", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    await saveDraft(store, draft, events);
    await approveDraft(store, draft, events, "admin");

    await expect(
      approveDraft(store, draft, events, "admin"),
    ).rejects.toThrow("Draft is already approved");
  });
});

// ===========================================================================
// TEST 5: isApproved derivation sequence
// ===========================================================================

describe("isApproved — derivation sequence", () => {
  it("returns false for empty events", () => {
    expect(isApproved([])).toBe(false);
  });

  it("returns true when latest event is approval", () => {
    const events = [
      createEvent({
        meta: { type: "draft_version", version: "v1", work_item_count: 2 },
        timestamp: "2026-09-16T10:00:00.000Z",
      }),
      createEvent({
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T11:00:00.000Z",
      }),
    ];
    expect(isApproved(events)).toBe(true);
  });

  it("returns false when latest event is approval_voided", () => {
    const events = [
      createEvent({
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      }),
      createEvent({
        meta: { type: "approval_voided", reason: "New version saved" },
        timestamp: "2026-09-16T11:00:00.000Z",
      }),
    ];
    expect(isApproved(events)).toBe(false);
  });

  it("returns false when latest event is draft_version", () => {
    const events = [
      createEvent({
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T10:00:00.000Z",
      }),
      createEvent({
        meta: { type: "draft_version", version: "v2", work_item_count: 3 },
        timestamp: "2026-09-16T11:00:00.000Z",
      }),
    ];
    expect(isApproved(events)).toBe(false);
  });

  it("derives correctly through full lifecycle", () => {
    const events: DraftEvent[] = [];

    // No events → not approved
    expect(isApproved(events)).toBe(false);

    // Save v1
    events.push(
      createEvent({
        meta: { type: "draft_version", version: "v1", work_item_count: 2 },
        timestamp: "2026-09-16T10:00:00.000Z",
      }),
    );
    expect(isApproved(events)).toBe(false);

    // Approve
    events.push(
      createEvent({
        meta: {
          type: "approval",
          approved_by: "admin",
          gate: "first_ticket_cut",
        },
        timestamp: "2026-09-16T11:00:00.000Z",
      }),
    );
    expect(isApproved(events)).toBe(true);

    // Save v2 → void
    events.push(
      createEvent({
        meta: { type: "approval_voided", reason: "New version saved" },
        timestamp: "2026-09-16T12:00:00.000Z",
      }),
    );
    expect(isApproved(events)).toBe(false);

    events.push(
      createEvent({
        meta: { type: "draft_version", version: "v2", work_item_count: 3 },
        timestamp: "2026-09-16T12:30:00.000Z",
      }),
    );
    expect(isApproved(events)).toBe(false);
  });
});

// ===========================================================================
// TEST 6: stale version cannot approve
// ===========================================================================

describe("approveDraft — stale version rejection", () => {
  it("rejects approval when draft version lags latest version event", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    // Save draft → v2
    await saveDraft(store, draft, events);
    expect(draft.version).toBe("v2");

    // Manually advance draft to v1 (simulating a stale handle)
    draft.version = "v1";

    await expect(
      approveDraft(store, draft, events, "admin"),
    ).rejects.toThrow("Cannot approve stale version");
  });

  it("allows approval when draft version matches latest version event", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    // Save draft → v2
    await saveDraft(store, draft, events);
    expect(draft.version).toBe("v2");

    // Approval should succeed — version matches
    const event = await approveDraft(store, draft, events, "admin");
    expect(isApproved(events)).toBe(true);

    // Verify audit meta fields
    const approvalMeta = event.meta as any;
    expect(approvalMeta.type).toBe("approval");
    expect(approvalMeta.gate).toBe("first_ticket_cut");
    expect(approvalMeta.draft_id).toBe("drft_test01");
    expect(approvalMeta.draft_version).toBe("v2");
    expect(approvalMeta.draft_snapshot_id).toBeDefined();
    expect(approvalMeta.user_action).toBe("approve");
    expect(approvalMeta.timestamp).toBeDefined();
    expect(approvalMeta.cost_envelope_at_approve).toEqual({ min: 100, max: 500 });
    expect(approvalMeta.work_items_approved).toEqual(["wi_1", "wi_2"]);
    expect(approvalMeta.missions_created_after).toEqual([]);
    expect(approvalMeta.snapshot).toEqual(draft.context);
  });

  it("voids old approval — must approve new version", async () => {
    const store = createFakeStore();
    const draft = createDraft();
    const events: DraftEvent[] = [];

    // Save, approve
    await saveDraft(store, draft, events);
    await approveDraft(store, draft, events, "admin");
    expect(isApproved(events)).toBe(true);

    // Save again → v3, approval voided
    await saveDraft(store, draft, events);
    expect(isApproved(events)).toBe(false);
    expect(draft.version).toBe("v3");

    // Now approve the new version
    const event = await approveDraft(store, draft, events, "admin");
    expect(isApproved(events)).toBe(true);

    const approvalMeta = event.meta as any;
    expect(approvalMeta.draft_version).toBe("v3");
  });
});

// ===========================================================================
// TEST 7: civilian view helper strips mission/column/tag words
// ===========================================================================

describe("stripCivilianJargon", () => {
  it("strips 'mission' word", () => {
    const result = stripCivilianJargon("This mission is a task");
    expect(result).toBe("This is a task");
  });

  it("strips 'column' word", () => {
    const result = stripCivilianJargon("Move to the column inbox");
    expect(result).toBe("Move to the inbox");
  });

  it("strips 'tag' word", () => {
    const result = stripCivilianJargon("Add a tag to this");
    expect(result).toBe("Add a to this");
  });

  it("strips 'ticket' word", () => {
    const result = stripCivilianJargon("Create a ticket for this");
    expect(result).toBe("Create a for this");
  });

  it("strips 'work-item' and 'work item'", () => {
    const result1 = stripCivilianJargon("Complete the work-item");
    expect(result1).toBe("Complete the");
    const result2 = stripCivilianJargon("Complete the work item");
    // "work item" is stripped as a phrase
    expect(result2).toBe("Complete the");
  });

  it("collapses whitespace after stripping", () => {
    const result = stripCivilianJargon("This mission is a task");
    // The function collapses multiple spaces into one
    expect(result).toBe("This is a task");
  });

  it("strips multiple jargon words from a sentence", () => {
    const result = stripCivilianJargon(
      "This mission is in the column and has a tag",
    );
    // All jargon words removed, whitespace collapsed
    expect(result).toBe("This is in the and has a");
  });

  it("does not strip non-jargon words containing jargon substrings", () => {
    // "missionary" contains "mission" but \b should prevent matching
    const result = stripCivilianJargon("missionary work");
    // \b matches word boundary, so "mission" in "missionary" should NOT match
    expect(result).toBe("missionary work");
  });
});
