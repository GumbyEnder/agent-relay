import { describe, it, expect, vi } from "vitest";
import { createHttpClient, type FetchLike } from "./http-client.js";
import { createMissionsAfterApprove } from "./devboards-adapter.js";
import type { DraftApprovalAudit } from "./types.js";

function validAudit(): DraftApprovalAudit {
  return {
    event: "draft_approved",
    draft_id: "drft_f9k2",
    draft_version: "v3",
    draft_snapshot_id: "snap_77a1",
    user_action: "approve_pressed",
    timestamp: "2026-09-16T14:02:11-04:00",
    cost_envelope_at_approve: { min_usd: 1, max_usd: 2, currency: "USD" },
    work_items_approved: ["write_sow", "fairness_check"],
    missions_created_after: [],
    gate: "first_ticket_cut",
  };
}

describe("HTTP ingest client", () => {
  it("createMission POSTs ingest/github not /missions", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          created: true,
          mission: { id: "msn_test1", column: "inbox" },
        }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "ark_test",
      fetch,
      nextNumber: () => 42,
    });
    const r = await client.createMission({
      title: "Write Sow",
      objective: "obj",
      projectId: "board_etzsvw4mq7d8",
      tags: ["beezilla:cut:v3"],
    });
    expect(r.mission.id).toBe("msn_test1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/agent/ingest/github");
    expect(calls[0]!.url).not.toContain("/missions");
    const payload = JSON.parse(calls[0]!.body ?? "{}");
    expect(payload.projectId).toBe("board_etzsvw4mq7d8");
    expect(payload.number).toBe(42);
    expect(payload.repository.full_name).toBe("GumbyEnder/agent-relay");
  });

  it("createMissionsAfterApprove refuses without audit and never fetches", async () => {
    const fetch = vi.fn();
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "ark_test",
      fetch,
    });
    await expect(
      createMissionsAfterApprove(null, client, "board_etzsvw4mq7d8", "frodo"),
    ).rejects.toThrow(/Refused/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("createMissionsAfterApprove with valid audit ingest twice", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          mission: { id: `msn_${urls.length}` },
        }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "ark_test",
      fetch,
    });
    const ids = await createMissionsAfterApprove(
      validAudit(),
      client,
      "board_etzsvw4mq7d8",
      "frodo",
    );
    expect(ids).toEqual(["msn_1", "msn_2"]);
    expect(urls.every((u) => u.endsWith("/api/agent/ingest/github"))).toBe(
      true,
    );
  });
});
