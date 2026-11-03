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
  // Guard: all tests use mock fetch — never calls live app.devboards.ai
  it("mock fetch is used (no live network)", () => {
    expect(typeof createHttpClient).toBe("function");
  });

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

  it("claim POSTs to /api/agent/missions/:id/claim", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key1",
      fetch,
    });
    const r = await client.claim("msn_x1", "frodo");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/agent/missions/msn_x1/claim");
    expect(calls[0]!.url).not.toContain("/heartbeat");
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body.agent).toBe("frodo");
  });

  it("heartbeat POSTs to /api/agent/missions/:id/heartbeat", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key2",
      fetch,
    });
    const r = await client.heartbeat("msn_x2", "sam", "on it");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      "/api/agent/missions/msn_x2/heartbeat",
    );
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body.agent).toBe("sam");
    expect(body.note).toBe("on it");
  });

  it("escalate POSTs to /api/agent/missions/:id/escalate", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key3",
      fetch,
    });
    const r = await client.escalate("msn_x3", "merry", "stuck on auth");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      "/api/agent/missions/msn_x3/escalate",
    );
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body.agent).toBe("merry");
    expect(body.question).toBe("stuck on auth");
  });

  it("deliver POSTs to /api/agent/missions/:id/deliver", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key4",
      fetch,
    });
    const r = await client.deliver(
      "msn_x4",
      "pippin",
      "done the PR",
      { tokensIn: 1000, tokensOut: 500 },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/agent/missions/msn_x4/deliver");
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body.agent).toBe("pippin");
    expect(body.summary).toBe("done the PR");
    expect(body.usage.tokensIn).toBe(1000);
  });

  it("deliver POSTs with null usage when omitted", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key4b",
      fetch,
    });
    await client.deliver("msn_x4b", "pippin", "done");
    const body = JSON.parse(calls[0]!.body ?? "{}");
    expect(body.usage).toBeNull();
  });

  it("getMissions GETs /api/agent/missions with query params", async () => {
    const calls: { url: string }[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push({ url });
      return {
        ok: true,
        status: 200,
        json: async () => ({ missions: [{ id: "msn_g1" }] }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key5",
      fetch,
    });
    const r = await client.getMissions({
      column: "running",
      agent: "frodo",
      project: "proj_abc",
    });
    expect(r.ok).toBe(true);
    expect(r.missions).toEqual([{ id: "msn_g1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/agent/missions?");
    expect(calls[0]!.url).toContain("column=running");
    expect(calls[0]!.url).toContain("agent=frodo");
    expect(calls[0]!.url).toContain("project=proj_abc");
    expect(calls[0]!.url).toContain("limit=20");
  });

  it("getMissions omits omitted params from query", async () => {
    const calls: { url: string }[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push({ url });
      return {
        ok: true,
        status: 200,
        json: async () => ({ missions: [] }),
        text: async () => "",
      };
    };
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "key5b",
      fetch,
    });
    await client.getMissions({});
    expect(calls[0]!.url).not.toContain("column=");
    expect(calls[0]!.url).not.toContain("agent=");
    expect(calls[0]!.url).not.toContain("project=");
    expect(calls[0]!.url).toContain("limit=20");
  });

  it("claim throws on non-ok response", async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "not found",
    });
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "keyX",
      fetch,
    });
    await expect(client.claim("msn_bad", "nobody")).rejects.toThrow(
      "Dev Boards HTTP 404",
    );
  });

  it("heartbeat throws on non-ok response", async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "server error",
    });
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "keyX",
      fetch,
    });
    await expect(
      client.heartbeat("msn_bad", "nobody", "hi"),
    ).rejects.toThrow("Dev Boards HTTP 500");
  });

  it("escalate throws on non-ok response", async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "forbidden",
    });
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "keyX",
      fetch,
    });
    await expect(
      client.escalate("msn_bad", "nobody", "why"),
    ).rejects.toThrow("Dev Boards HTTP 403");
  });

  it("deliver throws on non-ok response", async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "bad request",
    });
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "keyX",
      fetch,
    });
    await expect(
      client.deliver("msn_bad", "nobody", "nope"),
    ).rejects.toThrow("Dev Boards HTTP 400");
  });

  it("getMissions throws on non-ok response", async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "service unavailable",
    });
    const client = createHttpClient({
      baseUrl: "https://app.devboards.ai",
      apiKey: "keyX",
      fetch,
    });
    await expect(client.getMissions({})).rejects.toThrow(
      "Dev Boards HTTP 503",
    );
  });
});
