/**
 * BZ-F012 — model selection policy (versioned, reasoned, evidence-gated).
 *
 * No "best model" is asserted without tasks and evidence. Selection order:
 *  1. Hard eligibility: the model must be in the approved server-side catalog
 *     (privacy/availability are catalog-curation concerns, never client input).
 *  2. Task/phase policy: verification/deliverable turns for high-stakes job
 *     types (legal, technical) require a reasoning-capable entry WHEN one
 *     exists; everything else uses the default (Value) entry.
 *  3. Minimum quality: the expert fixture suite (fixtures/expert-fixtures.json,
 *     BZ-F040) is the representative test set — a model/provider/prompt change
 *     that fails the suite is ineligible regardless of price.
 *  4. Preference: 'value' (default) keeps the first catalog entry; 'faster'
 *     prefers an entry labelled fast; 'thorough' prefers reasoning-capable.
 *  5. Escalation stays inside the catalog — there is no silent cloud fallback.
 *  6. Every decision records policy version + reason + phase internally.
 */

import { getModels } from "./llm";

export const MODEL_POLICY_VERSION = "mp-1.0.0";

export type ModelPreference = "value" | "faster" | "thorough";
export type ModelPhase = "discovery" | "deliverable" | "verification" | "extraction";

export interface ModelDecision {
  model: string;
  label: string;
  policyVersion: string;
  phase: ModelPhase;
  reason: string;
}

interface CatalogEntry {
  label: string;
  model: string;
}

const REASONING_HINT = /think|reason|kimi|qwen/i;

function isReasoningCapable(e: CatalogEntry): boolean {
  return REASONING_HINT.test(`${e.label} ${e.model}`);
}

/**
 * Pick the model for this turn. Returns the DECISION (with the human-readable
 * reason), never just an id — the reason is the audit trail.
 */
export function selectModel(opts: {
  jobType: string;
  phase: ModelPhase;
  preference?: ModelPreference;
  /** An explicit, catalog-validated user choice always wins. */
  overrideModel?: string;
}): ModelDecision {
  const catalog = getModels() as CatalogEntry[];
  const fallback: CatalogEntry | undefined = catalog[0];
  const decide = (entry: CatalogEntry | undefined, reason: string): ModelDecision => ({
    model: (entry ?? fallback)?.model ?? "",
    label: (entry ?? fallback)?.label ?? "default",
    policyVersion: MODEL_POLICY_VERSION,
    phase: opts.phase,
    reason,
  });

  if (opts.overrideModel) {
    const hit = catalog.find((e) => e.model === opts.overrideModel);
    if (hit) return decide(hit, `owner picked "${hit.label}" for this turn (catalog-validated)`);
    // An override outside the catalog is refused, not silently honored.
    return decide(fallback, `requested model is not in the approved catalog — stayed on the default`);
  }

  const highStakes = opts.jobType === "legal" || opts.jobType === "technical";
  const needsReasoning =
    (highStakes && (opts.phase === "deliverable" || opts.phase === "verification")) ||
    opts.preference === "thorough";
  if (needsReasoning) {
    const reasoning = catalog.find(isReasoningCapable);
    if (reasoning) {
      return decide(reasoning, `${opts.jobType} ${opts.phase} turn — reasoning-capable entry preferred within the approved catalog`);
    }
    return decide(fallback, `${opts.jobType} ${opts.phase} turn wanted reasoning but the catalog has none — stayed on the default (no silent escalation)`);
  }

  if (opts.preference === "faster") {
    const fast = catalog.find((e) => /fast|flash|quick/i.test(e.label));
    if (fast) return decide(fast, `owner preference Faster — picked the fastest-labelled eligible entry`);
  }

  return decide(fallback, `default Value policy — first approved catalog entry`);
}
