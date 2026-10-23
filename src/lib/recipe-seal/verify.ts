/**
 * Recipe Seal — Step 5: the verify tier.
 *
 * Verify runs the sealed evaluator against a draft the CALLER produced. It never
 * decrypts the semantic half and never calls a model — by construction, not by
 * convention: this module has no KEK parameter and does not import the opener.
 * That is what lets it run in a process started without RECIPE_SEAL_KEK.
 */
import { evaluateRecipeChecks } from "../recipe-checks";
import type { Draft } from "../recipe-checks/types";

export interface VerifyInput {
  /** The `checks.wasm` entry from the public bundle. */
  checksWasm: Uint8Array;
  draft: unknown;
  /** Public code -> description, from the manifest (safe to ship). */
  descriptions: Record<string, string>;
  engine?: string;
}

export interface VerifyResult {
  ok: boolean;
  codes: string[];
  warnings: string[];
  descriptions: Record<string, string>;
  engine: string;
  ms: number;
  /** Bucketed so response timing cannot be used as a rule oracle. */
  ms_bucket: "<5" | "<20" | "<50" | ">=50";
}

/** Coarse, stable bucket — never the raw duration. */
export function bucketMs(ms: number): VerifyResult["ms_bucket"] {
  if (ms < 5) return "<5";
  if (ms < 20) return "<20";
  if (ms < 50) return "<50";
  return ">=50";
}

export function verifyDraft(input: VerifyInput): VerifyResult {
  const started = Date.now();
  const result = evaluateRecipeChecks(input.checksWasm, input.draft as Draft);
  const codes = [...result.codes].sort();
  const warnings = [...result.warnings].sort();
  // Only describe codes that fired: the full map lives in the manifest, but
  // echoing it on every response hands an attacker the rule inventory.
  const descriptions: Record<string, string> = {};
  for (const c of [...codes, ...warnings]) {
    if (input.descriptions[c]) descriptions[c] = input.descriptions[c];
  }
  return {
    ok: result.ok,
    codes,
    warnings,
    descriptions,
    engine: input.engine ?? "recipe-checks/1",
    ms: Date.now() - started,
    ms_bucket: bucketMs(Date.now() - started),
  };
}

// ── rate limiting / anti-oracle ───────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter, injectable clock. Deliberately simple: the goal is to
 * make unlimited probing uneconomic, not to be fair under burst.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
    /** Hard cap on tracked keys. The key is caller-supplied, so an unbounded map
     *  is a memory-exhaustion vector: sweep expired buckets, then evict oldest. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Drop only *expired* buckets. Never evict a live counter — that hands the
   *  caller a reset, which is exactly what a limiter must not do. Capacity
   *  pressure is handled by the shared overflow bucket in `take`. */
  private evict(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= t) this.buckets.delete(k);
    }
  }

  /** Returns {allowed, remaining, retryAfterMs}. */
  take(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const t = this.now();
    // At capacity, sweep expired buckets. If still full, route NEW keys into one
    // shared overflow bucket instead of evicting a live counter — eviction reset
    // live limits, so a caller could clear its own 429 by minting fresh keys.
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      this.evict(t);
      if (this.buckets.size >= this.maxKeys) key = "__overflow__";
    }
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterMs: 0 };
    }
    if (b.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: b.resetAt - t };
    }
    b.count++;
    return { allowed: true, remaining: this.limit - b.count, retryAfterMs: 0 };
  }

  /** Distinct drafts seen per caller per hour — the probing signal. */
  noteDraftHash(key: string): number {
    const k = `${key}:drafts`;
    const t = this.now();
    const b = this.buckets.get(k);
    if (!b || b.resetAt <= t) {
      this.buckets.set(k, { count: 1, resetAt: t + 3_600_000 });
      return 1;
    }
    b.count++;
    return b.count;
  }
}

export const LIMITS = {
  anonymousPerMinute: 60,
  tokenPerMinute: 600,
  batchMax: 50,
  /** Alert threshold for distinct drafts per caller per hour. */
  probingDraftsPerHour: 500,
} as const;

export interface BatchResult {
  ok: boolean;
  results?: VerifyResult[];
  error?: { code: "batch_too_large" | "invalid_body"; detail?: string };
  status: number;
}

export function verifyBatch(inputs: VerifyInput[]): BatchResult {
  if (inputs.length > LIMITS.batchMax) {
    return { ok: false, status: 413, error: { code: "batch_too_large", detail: `max ${LIMITS.batchMax}` } };
  }
  if (inputs.length === 0) {
    return { ok: false, status: 400, error: { code: "invalid_body", detail: "empty batch" } };
  }
  return { ok: true, status: 200, results: inputs.map((i) => verifyDraft(i)) };
}
