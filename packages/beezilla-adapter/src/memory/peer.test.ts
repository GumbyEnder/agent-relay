import { describe, it, expect, vi } from "vitest";
import { ensurePeer } from "./peer.js";
import { BEEZILLA_HONCHO_WORKSPACE } from "./honcho.js";

describe("ensurePeer", () => {
  it("POSTs the user id into beezilla-clients", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.id).toBe("bz_user1");
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const r = await ensurePeer("bz_user1", fetchImpl, "https://honcho.example");
    expect(r.workspace).toBe(BEEZILLA_HONCHO_WORKSPACE);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/v3/workspaces/beezilla-clients/peers");
  });

  it("rejects empty userId", async () => {
    await expect(ensurePeer("  ", fetch, "https://honcho.example")).rejects.toThrow(/userId/);
  });
});
