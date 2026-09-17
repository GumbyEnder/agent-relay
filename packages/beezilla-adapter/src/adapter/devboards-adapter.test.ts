/**
 * BeeZilla — Dev Boards Adapter Tests
 * 
 * Tests:
 * 1. Refuse create-missions without audit
 * 2. Refuse create-missions with invalid audit
 * 3. Allow create-missions with valid audit
 * 4. toCivilianCard strips internals (model ids, tokens, Dev Boards jargon)
 * 5. Column mapping is correct
 * 6. poll, claim, heartbeat, deliver, escalate call client correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toCivilianCard,
  createMissionsAfterApprove,
  poll,
  claim,
  heartbeat,
  deliver,
  escalate,
  validateAudit,
} from "./devboards-adapter";
import type {
  DevBoardClient,
  DevBoardMission,
  DraftApprovalAudit,
  PollResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

function createFakeClient(): DevBoardClient {
  return {
    getMissions: vi.fn().mockResolvedValue({ ok: true, missions: [] }),
    createMission: vi.fn().mockResolvedValue({
      ok: true,
      mission: { id: "msn_fake123" },
    }),
    claim: vi.fn().mockResolvedValue({ ok: true }),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
    escalate: vi.fn().mockResolvedValue({ ok: true }),
    deliver: vi.fn().mockResolvedValue({ ok: true }),
    move: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// ---------------------------------------------------------------------------
// Valid audit fixture
// ---------------------------------------------------------------------------

function validAudit(): DraftApprovalAudit {
  return {
    event: "draft_approved",
    draft_id: "drft_f9k2",
    draft_version: "v3",
    draft_snapshot_id: "snap_77a1",
    user_action: "approve_pressed",
    timestamp: "2026-09-16T14:02:11-04:00",
    cost_envelope_at_approve: { min_usd: 1.00, max_usd: 2.00, currency: "USD" },
    work_items_approved: ["write_sow", "fairness_check", "format_pdf_editable", "hand_over"],
    missions_created_after: [],
    gate: "first_ticket_cut",
  };
}

// ---------------------------------------------------------------------------
// Valid mission fixture
// ---------------------------------------------------------------------------

function validMission(overrides?: Partial<DevBoardMission>): DevBoardMission {
  return {
    id: "msn_abc123",
    projectId: "board_xyz",
    title: "Write the scope of work",
    objective: "Draft the SOW text",
    context: "Internal context — should be hidden",
    constraints: "Budget $100–$200",
    acceptance: "User approves SOW",
    column: "running",
    priority: "p1",
    tags: ["v3", "wi_write_sow"],
    assigneeId: "agent_1",
    claimedBy: "agent_1",
    claimedAt: 1726500000000,
    lastHeartbeat: 1726501000000,
    progressNote: "Drafting SOW text",
    artifacts: ["https://example.com/sow.pdf"],
    createdAt: 1726500000000,
    updatedAt: 1726501000000,
    delivery: undefined,
    externalId: null,
    source: null,
    usage: {
      tokensIn: 1200,
      tokensOut: 400,
      model: "gpt-4o-mini",
      toolCalls: 7,
      estimatedUsd: 0.02,
    },
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("validateAudit", () => {
  it("accepts a valid first_ticket_cut audit", () => {
    expect(() => validateAudit(validAudit())).not.toThrow();
  });

  it("throws when audit is null", () => {
    expect(() => validateAudit(null)).toThrow("no audit record provided");
  });

  it("throws when audit is not an object", () => {
    expect(() => validateAudit("string")).toThrow("no audit record provided");
  });

  it("throws when gate is missing", () => {
    const audit = { ...validAudit() };
    delete audit.gate;
    expect(() => validateAudit(audit)).toThrow("expected 'first_ticket_cut'");
  });

  it("throws when gate is wrong", () => {
    const audit = { ...validAudit(), gate: "paid_api" };
    expect(() => validateAudit(audit)).toThrow("expected 'first_ticket_cut'");
  });

  it("throws when draft_version is missing", () => {
    const audit = { ...validAudit() };
    delete (audit as any).draft_version;
    expect(() => validateAudit(audit)).toThrow("missing draft_version");
  });

  it("throws when timestamp is missing", () => {
    const audit = { ...validAudit() };
    delete (audit as any).timestamp;
    expect(() => validateAudit(audit)).toThrow("missing timestamp");
  });

  it("throws when user_action is missing", () => {
    const audit = { ...validAudit() };
    delete (audit as any).user_action;
    expect(() => validateAudit(audit)).toThrow("missing user_action");
  });
});

describe("createMissionsAfterApprove", () => {
  let client: DevBoardClient;

  beforeEach(() => {
    client = createFakeClient();
    vi.clearAllMocks();
  });

  it("refuses without audit", async () => {
    await expect(
      createMissionsAfterApprove(null, client, "board_xyz", "agent_1"),
    ).rejects.toThrow("no audit record provided");
  });

  it("refuses with invalid gate", async () => {
    const audit = { ...validAudit(), gate: "paid_api" };
    await expect(
      createMissionsAfterApprove(audit, client, "board_xyz", "agent_1"),
    ).rejects.toThrow("expected 'first_ticket_cut'");
  });

  it("refuses with incomplete audit (missing draft_version)", async () => {
    const audit = { ...validAudit() };
    delete (audit as any).draft_version;
    await expect(
      createMissionsAfterApprove(audit, client, "board_xyz", "agent_1"),
    ).rejects.toThrow("missing draft_version");
  });

  it("creates missions for each approved work item", async () => {
    const audit = validAudit();
    const result = await createMissionsAfterApprove(
      audit,
      client,
      "board_xyz",
      "agent_1",
    );

    expect(result).toHaveLength(4);
    expect(result).toEqual(["msn_fake123", "msn_fake123", "msn_fake123", "msn_fake123"]);

    // Verify createMission was called 4 times
    expect(client.createMission).toHaveBeenCalledTimes(4);

    // Verify first mission request
    const firstCall = client.createMission.mock.calls[0][0];
    expect(firstCall.title).toBe("Write Sow");
    expect(firstCall.tags).toContain("v3");
    expect(firstCall.tags).toContain("wi_write_sow");
    expect(firstCall.projectId).toBe("board_xyz");
  });

  it("returns empty array when no work items approved", async () => {
    const audit = { ...validAudit(), work_items_approved: [] };
    const result = await createMissionsAfterApprove(
      audit,
      client,
      "board_xyz",
      "agent_1",
    );

    expect(result).toEqual([]);
    expect(client.createMission).not.toHaveBeenCalled();
  });
});

describe("toCivilianCard", () => {
  it("maps running column to Working status", () => {
    const mission = validMission({ column: "running" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Working");
  });

  it("maps inbox column to Waiting status", () => {
    const mission = validMission({ column: "inbox" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Waiting");
  });

  it("maps ready column to Waiting status", () => {
    const mission = validMission({ column: "ready" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Waiting");
  });

  it("maps needs_human column to Needs you status", () => {
    const mission = validMission({ column: "needs_human" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Needs you");
  });

  it("maps review column to Done status", () => {
    const mission = validMission({ column: "review" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Done");
  });

  it("maps done column to Done status", () => {
    const mission = validMission({ column: "done" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Done");
  });

  it("maps blocked column to Needs you status", () => {
    const mission = validMission({ column: "blocked" });
    const card = toCivilianCard(mission);
    expect(card.status).toBe("Needs you");
  });

  it("strips model id from usage", () => {
    const mission = validMission();
    const card = toCivilianCard(mission);
    // card should NOT have a model field
    expect(card).not.toHaveProperty("model");
    expect(card).not.toHaveProperty("usage");
  });

  it("strips token counts from usage", () => {
    const mission = validMission();
    const card = toCivilianCard(mission);
    expect(card).not.toHaveProperty("tokensIn");
    expect(card).not.toHaveProperty("tokensOut");
  });

  it("strips raw agent output (context, constraints, objective)", () => {
    const mission = validMission();
    const card = toCivilianCard(mission);
    expect(card).not.toHaveProperty("context");
    expect(card).not.toHaveProperty("constraints");
    expect(card).not.toHaveProperty("objective");
  });

  it("does not leak Dev Boards jargon", () => {
    const mission = validMission();
    const card = toCivilianCard(mission);
    // Card should only have civilian fields
    const allowedKeys = [
      "cardId", "title", "status", "progressNote",
      "artifacts", "delivery", "_draftVersion", "_workItemId",
    ];
    for (const key of Object.keys(card)) {
      expect(allowedKeys).toContain(key);
    }
  });

  it("extracts draft version from tags", () => {
    const mission = validMission({ tags: ["v3", "wi_write_sow"] });
    const card = toCivilianCard(mission);
    expect(card._draftVersion).toBe("v3");
  });

  it("extracts work item id from tags", () => {
    const mission = validMission({ tags: ["v3", "wi_write_sow"] });
    const card = toCivilianCard(mission);
    expect(card._workItemId).toBe("write_sow");
  });

  it("converts artifact URLs to display names", () => {
    const mission = validMission({
      artifacts: ["https://example.com/path/to/sow.pdf"],
    });
    const card = toCivilianCard(mission);
    expect(card.artifacts).toEqual(["sow.pdf"]);
  });

  it("preserves delivery summary when present", () => {
    const mission = validMission({
      column: "done",
      delivery: "SOW document ready for download",
    });
    const card = toCivilianCard(mission);
    expect(card.delivery).toBe("SOW document ready for download");
  });

  it("uses default progress note when empty", () => {
    const mission = validMission({ progressNote: "" });
    const card = toCivilianCard(mission);
    expect(card.progressNote).toBe("Waiting to start");
  });

  it("preserves cardId from mission id", () => {
    const mission = validMission({ id: "msn_abc123" });
    const card = toCivilianCard(mission);
    expect(card.cardId).toBe("msn_abc123");
  });

  it("preserves title", () => {
    const mission = validMission({ title: "Check it for fairness" });
    const card = toCivilianCard(mission);
    expect(card.title).toBe("Check it for fairness");
  });
});

describe("poll", () => {
  it("delegates to client.getMissions with correct params", async () => {
    const client = createFakeClient();
    await poll(client, "agent_1", "board_xyz", "ready");

    expect(client.getMissions).toHaveBeenCalledWith({
      column: "ready",
      agent: "agent_1",
      project: "board_xyz",
    });
  });

  it("defaults to ready column", async () => {
    const client = createFakeClient();
    await poll(client, "agent_1", "board_xyz");

    expect(client.getMissions).toHaveBeenCalledWith({
      column: "ready",
      agent: "agent_1",
      project: "board_xyz",
    });
  });
});

describe("claim", () => {
  it("delegates to client.claim", async () => {
    const client = createFakeClient();
    await claim(client, "msn_abc123", "agent_1");

    expect(client.claim).toHaveBeenCalledWith("msn_abc123", "agent_1");
  });
});

describe("heartbeat", () => {
  it("delegates to client.heartbeat with note", async () => {
    const client = createFakeClient();
    await heartbeat(client, "msn_abc123", "agent_1", "Drafting SOW");

    expect(client.heartbeat).toHaveBeenCalledWith(
      "msn_abc123",
      "agent_1",
      "Drafting SOW",
    );
  });

  it("delegates to client.heartbeat without note", async () => {
    const client = createFakeClient();
    await heartbeat(client, "msn_abc123", "agent_1");

    expect(client.heartbeat).toHaveBeenCalledWith("msn_abc123", "agent_1", undefined);
  });
});

describe("deliver", () => {
  it("delegates to client.deliver with summary", async () => {
    const client = createFakeClient();
    await deliver(client, "msn_abc123", "agent_1", "SOW complete");

    expect(client.deliver).toHaveBeenCalledWith(
      "msn_abc123",
      "agent_1",
      "SOW complete",
      undefined,
    );
  });

  it("delegates to client.deliver with usage", async () => {
    const client = createFakeClient();
    const usage = { tokensIn: 1000, tokensOut: 300, estimatedUsd: 0.01 };
    await deliver(client, "msn_abc123", "agent_1", "Done", usage);

    expect(client.deliver).toHaveBeenCalledWith(
      "msn_abc123",
      "agent_1",
      "Done",
      usage,
    );
  });
});

describe("escalate", () => {
  it("delegates to client.escalate with question", async () => {
    const client = createFakeClient();
    await escalate(client, "msn_abc123", "agent_1", "What's the budget?");

    expect(client.escalate).toHaveBeenCalledWith(
      "msn_abc123",
      "agent_1",
      "What's the budget?",
    );
  });
});
