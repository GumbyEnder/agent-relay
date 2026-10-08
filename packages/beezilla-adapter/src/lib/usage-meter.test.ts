/**
 * BeeZilla — Token metering tests
 *
 * - records an event and jobSpend rolls up totals + per-phase + per-model buckets correctly
 * - unknown model → estCostUsd null, estimated true
 * - anthropic-shaped and openai-shaped usage both parsed by withMetering
 * - response missing usage → length-based estimate flagged estimated
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  recordUsage,
  jobSpend,
  withMetering,
  resetUsageStore,
  setUsageStoreForTesting,
  type UsageEvent,
  type UsageEventStore,
} from "./usage-meter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeStore(events: UsageEvent[]): UsageEventStore {
  return {
    async appendUsage(_missionId: string, event: UsageEvent): Promise<void> {
      events.push(event);
    },
    async listUsage(missionId: string): Promise<UsageEvent[]> {
      return events.filter((e) => e.jobId === missionId);
    },
  };
}

function fakeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    jobId: "job_123",
    agentId: "expert_legal",
    model: "claude-sonnet-4-20250514",
    phase: "draft",
    promptTokens: 500,
    completionTokens: 300,
    estCostUsd: null,
    estimated: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("usage-meter", () => {
  beforeEach(() => {
    resetUsageStore();
  });

  afterEach(() => {
    resetUsageStore();
  });

  // -----------------------------------------------------------------------
  // 1. recordUsage + jobSpend roll-up
  // -----------------------------------------------------------------------

  describe("recordUsage + jobSpend roll-up", () => {
    it("records an event and jobSpend rolls up totals correctly", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      const ev = fakeEvent({ promptTokens: 1000, completionTokens: 500 });
      await recordUsage(ev);

      const spend = await jobSpend("job_123");
      expect(spend.totalTokens).toBe(1500);
      expect(spend.promptTokens).toBe(1000);
      expect(spend.completionTokens).toBe(500);
      // claude-sonnet-4: $3/1M input, $15/1M output
      // (1000 * 3 + 500 * 15) / 1M = (3000 + 7500) / 1M = 0.0105
      expect(spend.estCostUsd).toBeCloseTo(0.0105, 6);
    });

    it("rolls up per-phase buckets", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      await recordUsage(fakeEvent({ phase: "draft", promptTokens: 200, completionTokens: 100 }));
      await recordUsage(fakeEvent({ phase: "interview", promptTokens: 300, completionTokens: 200 }));

      const spend = await jobSpend("job_123");
      expect(spend.byPhase.draft.tokens).toBe(300);
      expect(spend.byPhase.interview.tokens).toBe(500);
    });

    it("rolls up per-model buckets", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      await recordUsage(fakeEvent({ model: "claude-sonnet-4-20250514", promptTokens: 400, completionTokens: 200 }));
      await recordUsage(fakeEvent({ model: "gpt-4o", promptTokens: 600, completionTokens: 300 }));

      const spend = await jobSpend("job_123");
      expect(spend.byModel["claude-sonnet-4-20250514"].tokens).toBe(600);
      expect(spend.byModel["gpt-4o"].tokens).toBe(900);
    });

    it("handles multiple jobs independently", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      await recordUsage(fakeEvent({ jobId: "job_a", promptTokens: 100, completionTokens: 50 }));
      await recordUsage(fakeEvent({ jobId: "job_b", promptTokens: 200, completionTokens: 100 }));

      const spendA = await jobSpend("job_a");
      const spendB = await jobSpend("job_b");

      expect(spendA.totalTokens).toBe(150);
      expect(spendB.totalTokens).toBe(300);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Unknown model
  // -----------------------------------------------------------------------

  describe("unknown model", () => {
    it("returns null estCostUsd and sets estimated true", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      const ev = fakeEvent({ model: "unknown-model-xyz", promptTokens: 100, completionTokens: 50 });
      const recorded = await recordUsage(ev);

      expect(recorded.estCostUsd).toBeNull();
      expect(recorded.estimated).toBe(true);

      const spend = await jobSpend("job_123");
      expect(spend.estCostUsd).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 3. withMetering — OpenAI-shaped response
  // -----------------------------------------------------------------------

  describe("withMetering — OpenAI-shaped", () => {
    it("extracts prompt_tokens and completion_tokens", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      const response = {
        id: "chatcmpl-123",
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };

      const result = await withMetering("job_123", "expert_legal", "gpt-4o", "draft", () =>
        Promise.resolve(response),
      );

      expect(result).toBe(response);
      expect(events).toHaveLength(1);
      expect(events[0].promptTokens).toBe(50);
      expect(events[0].completionTokens).toBe(20);
      expect(events[0].estimated).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 4. withMetering — Anthropic-shaped response
  // -----------------------------------------------------------------------

  describe("withMetering — Anthropic-shaped", () => {
    it("extracts input_tokens and output_tokens", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      const response = {
        id: "msg_123",
        content: [{ text: "Hello!" }],
        usage: { input_tokens: 40, output_tokens: 15 },
      };

      const result = await withMetering("job_123", "expert_legal", "claude-sonnet-4-20250514", "draft", () =>
        Promise.resolve(response),
      );

      expect(result).toBe(response);
      expect(events).toHaveLength(1);
      expect(events[0].promptTokens).toBe(40);
      expect(events[0].completionTokens).toBe(15);
      expect(events[0].estimated).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 5. withMetering — missing usage → length-based estimate
  // -----------------------------------------------------------------------

  describe("withMetering — missing usage", () => {
    it("estimates from string length when no usage field", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      const response = { content: "A".repeat(400) }; // 400 chars ≈ 100 tokens

      const result = await withMetering("job_123", "expert_legal", "unknown-model", "research", () =>
        Promise.resolve(response),
      );

      expect(result).toBe(response);
      expect(events).toHaveLength(1);
      expect(events[0].estimated).toBe(true);
      expect(events[0].completionTokens).toBe(100); // 400 / 4
    });

    it("handles non-string responses without usage", async () => {
      const events: UsageEvent[] = [];
      setUsageStoreForTesting(makeFakeStore(events));

      const response = { choices: [{ message: { content: "Hi" } }] };

      const result = await withMetering("job_123", "expert_legal", "gpt-4o", "draft", () =>
        Promise.resolve(response),
      );

      expect(result).toBe(response);
      expect(events).toHaveLength(1);
      expect(events[0].estimated).toBe(true);
      // "Hi" = 2 chars → ~0 tokens, but promptTokens has a floor of 128
      expect(events[0].promptTokens).toBeGreaterThanOrEqual(128);
    });
  });
});
