/**
 * BeeZilla — Per-job token metering (usage events)
 *
 * Instruments every agent/model call so token consumption (prompt +
 * completion) and estimated cost are tracked per job and per expert,
 * then surfaced in the product.
 *
 * Persistence: usage events are stored as ar_events notes tagged `usage`
 * with the event payload as context JSON — same pattern drafts already use.
 * No new database.
 *
 * Constraint: this file lives in packages/beezilla-adapter/src/lib/ and
 * does NOT touch Dev Boards internals (the board engine, board-store.server.ts,
 * or the agent API).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single usage event recorded for one model call */
export interface UsageEvent {
  jobId: string;
  agentId: string;
  model: string;
  phase: "interview" | "draft" | "research" | "review" | "other";
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number | null;
  estimated: boolean;
  createdAt: number;
}

/** Per-1M token price for a model */
export interface ModelPrice {
  modelId: string;
  inputPer1M: number;
  outputPer1M: number;
}

/** Roll-up of usage for a job */
export interface JobSpend {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number | null;
  byPhase: Record<string, { tokens: number; cost: number | null }>;
  byModel: Record<string, { tokens: number; cost: number | null }>;
}

// ---------------------------------------------------------------------------
// Model price table (per-1M input / output, USD)
// ---------------------------------------------------------------------------

export const MODEL_PRICES: ModelPrice[] = [
  // Anthropic Claude
  { modelId: "claude-sonnet-4-20250514", inputPer1M: 3.0, outputPer1M: 15.0 },
  { modelId: "claude-sonnet-4-20251001", inputPer1M: 3.0, outputPer1M: 15.0 },
  { modelId: "claude-opus-4-0", inputPer1M: 15.0, outputPer1M: 75.0 },
  { modelId: "claude-opus-4-20250514", inputPer1M: 15.0, outputPer1M: 75.0 },
  { modelId: "claude-3-5-sonnet-latest", inputPer1M: 3.0, outputPer1M: 15.0 },
  { modelId: "claude-3-5-sonnet-20241022", inputPer1M: 3.0, outputPer1M: 15.0 },
  { modelId: "claude-3-5-haiku-latest", inputPer1M: 0.8, outputPer1M: 4.0 },
  // OpenAI GPT
  { modelId: "gpt-5.1", inputPer1M: 1.0, outputPer1M: 5.0 },
  { modelId: "gpt-5", inputPer1M: 1.0, outputPer1M: 5.0 },
  { modelId: "gpt-5.2", inputPer1M: 1.0, outputPer1M: 5.0 },
  { modelId: "gpt-4.1", inputPer1M: 0.5, outputPer1M: 2.0 },
  { modelId: "gpt-4.1-mini", inputPer1M: 0.2, outputPer1M: 0.8 },
  { modelId: "gpt-4.1-nano", inputPer1M: 0.1, outputPer1M: 0.4 },
  { modelId: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10.0 },
  { modelId: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6 },
  // Google Gemini
  { modelId: "gemini-3-pro", inputPer1M: 1.25, outputPer1M: 5.0 },
  { modelId: "gemini-3-flash", inputPer1M: 0.075, outputPer1M: 0.3 },
  { modelId: "gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 5.0 },
  { modelId: "gemini-2.5-flash", inputPer1M: 0.075, outputPer1M: 0.3 },
  // Other
  { modelId: "glm-5.3-flash", inputPer1M: 0.05, outputPer1M: 0.2 },
  { modelId: "mistral-large", inputPer1M: 2.0, outputPer1M: 6.0 },
  { modelId: "mistral-small", inputPer1M: 0.2, outputPer1M: 0.6 },
];

/** Lookup a price by model id; returns null when unknown */
export function priceFor(modelId: string): ModelPrice | null {
  return MODEL_PRICES.find((p) => p.modelId === modelId) ?? null;
}

// ---------------------------------------------------------------------------
// Persistence helpers (same pattern as draft store: ar_events notes)
// ---------------------------------------------------------------------------

/**
 * Minimal store interface for usage events.
 * Tests inject a fake; the real adapter wires this to the board store.
 */
export interface UsageEventStore {
  appendUsage(missionId: string, event: UsageEvent): Promise<void>;
  listUsage(missionId: string): Promise<UsageEvent[]>;
}

/** Default in-memory store (used by tests and as fallback) */
const _usageStore: UsageEventStore = {
  _events: [] as UsageEvent[],

  async appendUsage(_missionId: string, event: UsageEvent): Promise<void> {
    this._events.push(event);
  },

  async listUsage(missionId: string): Promise<UsageEvent[]> {
    return this._events.filter((e) => e.jobId === missionId);
  },
};

/** Swap the global store (for testing) */
let usageStore: UsageEventStore = _usageStore;

export function setUsageStoreForTesting(store: UsageEventStore): void {
  usageStore = store;
}

/** Reset to the default in-memory store */
export function resetUsageStore(): void {
  usageStore = _usageStore;
  _usageStore._events = [];
}

// ---------------------------------------------------------------------------
// recordUsage — append one usage event
// ---------------------------------------------------------------------------

/**
 * Record a usage event for a job.
 *
 * @param event — the usage event to record
 * @returns the recorded event (with estCostUsd resolved)
 */
export async function recordUsage(event: UsageEvent): Promise<UsageEvent> {
  // Resolve cost if we have a price table entry
  const price = priceFor(event.model);
  const resolved: UsageEvent = {
    ...event,
    estCostUsd:
      price != null
        ? (event.promptTokens * price.inputPer1M + event.completionTokens * price.outputPer1M) / 1_000_000
        : null,
  };
  if (price == null) {
    resolved.estimated = true;
  }
  await usageStore.appendUsage(event.jobId, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// jobSpend — roll up all usage events for a job
// ---------------------------------------------------------------------------

/**
 * Read back all usage events for a job and roll up totals.
 *
 * @param jobId — the job (mission) id
 * @returns aggregated spend data
 */
export async function jobSpend(jobId: string): Promise<JobSpend> {
  const events = await usageStore.listUsage(jobId);

  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estCostUsd: number | null = null;
  const byPhase: Record<string, { tokens: number; cost: number | null }> = {};
  const byModel: Record<string, { tokens: number; cost: number | null }> = {};

  for (const ev of events) {
    const tokens = ev.promptTokens + ev.completionTokens;
    totalTokens += tokens;
    promptTokens += ev.promptTokens;
    completionTokens += ev.completionTokens;
    if (ev.estCostUsd != null) {
      estCostUsd = (estCostUsd ?? 0) + ev.estCostUsd;
    }

    // Per-phase bucket
    if (!byPhase[ev.phase]) {
      byPhase[ev.phase] = { tokens: 0, cost: null };
    }
    byPhase[ev.phase].tokens += tokens;
    if (ev.estCostUsd != null) {
      byPhase[ev.phase].cost = (byPhase[ev.phase].cost ?? 0) + ev.estCostUsd;
    }

    // Per-model bucket
    if (!byModel[ev.model]) {
      byModel[ev.model] = { tokens: 0, cost: null };
    }
    byModel[ev.model].tokens += tokens;
    if (ev.estCostUsd != null) {
      byModel[ev.model].cost = (byModel[ev.model].cost ?? 0) + ev.estCostUsd;
    }
  }

  return { totalTokens, promptTokens, completionTokens, estCostUsd, byPhase, byModel };
}

// ---------------------------------------------------------------------------
// withMetering — wrap an LLM call
// ---------------------------------------------------------------------------

/**
 * Wrap an LLM call so token usage is automatically recorded.
 *
 * Accepts OpenAI-compatible responses (usage.prompt_tokens /
 * usage.completion_tokens) and Anthropic-shaped responses
 * (usage.input_tokens / usage.output_tokens).
 *
 * If the provider returned no usage numbers, estimates from string
 * length (~4 chars/token) with estimated: true.
 *
 * @param jobId — the job id
 * @param agentId — the agent/expert id
 * @param model — the model name
 * @param phase — the workflow phase
 * @param fn — async function that returns the LLM response
 * @returns the original response (unchanged)
 */
export async function withMetering<T>(
  jobId: string,
  agentId: string,
  model: string,
  phase: UsageEvent["phase"],
  fn: () => Promise<T>,
): Promise<T> {
  const response = await fn();

  // Try to extract usage from the response
  let promptTokens = 0;
  let completionTokens = 0;

  if (response && typeof response === "object" && "usage" in response) {
    const usage = (response as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    if (usage) {
      promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    }
  }

  // If no usage numbers, estimate from output string length
  if (promptTokens === 0 && completionTokens === 0) {
    const estimated = true;
    let contentLen = 0;
    if (typeof response === "string") {
      contentLen = response.length;
    } else if (response && typeof response === "object") {
      // Try common response shapes
      const choice = (response as Record<string, unknown>).choices?.[0];
      if (choice && typeof choice === "object") {
        const msg = (choice as Record<string, unknown>).message;
        if (msg && typeof msg === "object") {
          contentLen = String((msg as Record<string, unknown>).content ?? "").length;
        }
      }
      // Fallback: top-level { content: "..." } shape
      if (contentLen === 0) {
        contentLen = String((response as Record<string, unknown>).content ?? "").length;
      }
    }
    completionTokens = Math.round(contentLen / 4);
    promptTokens = Math.max(128, Math.round(completionTokens * 0.5)); // rough estimate

    await recordUsage({
      jobId,
      agentId,
      model,
      phase,
      promptTokens,
      completionTokens,
      estCostUsd: null,
      estimated,
      createdAt: Date.now(),
    });
    return response;
  }

  await recordUsage({
    jobId,
    agentId,
    model,
    phase,
    promptTokens,
    completionTokens,
    estCostUsd: null, // resolved inside recordUsage
    estimated: false,
    createdAt: Date.now(),
  });

  return response;
}
