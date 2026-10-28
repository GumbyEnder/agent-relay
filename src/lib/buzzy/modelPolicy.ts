/**
 * BZ-F012 / BZ-F041 — model selection policy (versioned, reasoned, evidence-gated).
 *
 * No "best model" is asserted without tasks and evidence. Selection order:
 *  1. Spend ceiling: a hard cap the owner set is enforced BEFORE any model is
 *     chosen. `refuse` stops the turn; `ask` carries through for confirmation.
 *  2. Hard eligibility: the model must be in the approved server-side catalog
 *     (privacy/availability are catalog-curation concerns, never client input).
 *     `localOnly` narrows eligibility to operator-controlled entries and REFUSES
 *     when the catalog has none — it never falls back to a cloud model while
 *     claiming privacy.
 *  3. Provider preference: a named provider must exist in the catalog. An
 *     unknown provider is refused by name, never silently substituted.
 *  4. Task/phase policy: verification/deliverable turns for high-stakes job
 *     types (legal, technical) require a reasoning-capable entry WHEN one
 *     exists; everything else uses the default (Value) entry.
 *  5. Minimum quality: the expert fixture suite (fixtures/expert-fixtures.json,
 *     BZ-F040) is the representative test set — a model/provider/prompt change
 *     that fails the suite is ineligible regardless of price.
 *  6. Preference: 'value' (default) keeps the first eligible entry; 'faster'
 *     prefers an entry labelled fast; 'thorough' prefers reasoning-capable;
 *     'cheapest' orders by declared catalog price and REFUSES when the catalog
 *     carries no price map rather than guessing a number.
 *  7. Escalation stays inside the catalog — there is no silent cloud fallback.
 *  8. Every decision records policy version + reason + phase internally, plus
 *     the refusal code when a control could not be satisfied.
 *
 * Controls that cannot be satisfied are refused BY NAME. A control that quietly
 * degrades to the default is worse than one that refuses: the owner believes a
 * constraint is in force when it is not.
 */

import { getModels } from "./llm";
import { budgetVerdict, type BudgetDecision } from "./money";

export const MODEL_POLICY_VERSION = "mp-1.1.0";

export type ModelPreference = "value" | "faster" | "thorough" | "cheapest";
export type ModelPhase = "discovery" | "deliverable" | "verification" | "extraction";

/** Why a control could not be satisfied. Named so callers can branch on it. */
export type RefusalReason =
  | "unknown_provider"
  | "no_local_models"
  | "no_price_map"
  | "budget_refused"
  | "empty_catalog";

export interface ModelDecision {
  /** Chosen model id. Empty string when `refused` — a refusal routes nowhere. */
  model: string;
  label: string;
  policyVersion: string;
  phase: ModelPhase;
  reason: string;
  /** True when a control could not be satisfied. Callers must not route. */
  refused?: boolean;
  refusedReason?: RefusalReason;
  /** The provider that was chosen or requested. */
  provider?: string;
  /** Present whenever a spend cap was supplied. */
  budget?: BudgetDecision;
}

interface CatalogEntry {
  label: string;
  model: string;
  provider?: string;
  local?: boolean;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
}

const REASONING_HINT = /think|reason|kimi|qwen/i;
const FAST_HINT = /fast|flash|quick/i;

function isReasoningCapable(e: CatalogEntry): boolean {
  return REASONING_HINT.test(`${e.label} ${e.model}`);
}

function isFast(e: CatalogEntry): boolean {
  return FAST_HINT.test(e.label);
}

/** Total declared price per million tokens. Undefined when either side is absent. */
function declaredPrice(e: CatalogEntry): number | undefined {
  const inP = e.priceInPerMTok;
  const outP = e.priceOutPerMTok;
  if (typeof inP !== "number" && typeof outP !== "number") return undefined;
  return (typeof inP === "number" ? inP : 0) + (typeof outP === "number" ? outP : 0);
}

export interface SelectModelOptions {
  jobType: string;
  phase: ModelPhase;
  preference?: ModelPreference;
  /** An explicit, catalog-validated user choice always wins within eligibility. */
  overrideModel?: string;
  /** Preferred provider. Unknown → refused by name. */
  provider?: string;
  /** Operator-controlled inference only. No local entry → refused. */
  localOnly?: boolean;
  /** Owner's spend ceiling in cents. */
  budgetCapCents?: number;
  /** Spend already recorded this period, in cents. */
  spentCents?: number;
}

/**
 * Pick the model for this turn. Returns the DECISION (with the human-readable
 * reason), never just an id — the reason is the audit trail.
 */
export function selectModel(opts: SelectModelOptions): ModelDecision {
  const catalog = getModels() as CatalogEntry[];
  const base = {
    policyVersion: MODEL_POLICY_VERSION,
    phase: opts.phase,
  } as const;

  const refuse = (refusedReason: RefusalReason, reason: string, extra?: Partial<ModelDecision>): ModelDecision => ({
    ...base,
    model: "",
    label: "none",
    refused: true,
    refusedReason,
    reason,
    ...extra,
  });

  const decide = (entry: CatalogEntry, reason: string, extra?: Partial<ModelDecision>): ModelDecision => ({
    ...base,
    model: entry.model,
    label: entry.label,
    provider: entry.provider,
    reason,
    ...extra,
  });

  if (catalog.length === 0) {
    return refuse("empty_catalog", "the approved model catalog is empty — no model can be selected");
  }

  // ── 1. Spend ceiling, enforced before any model is chosen ──────────
  let budget: BudgetDecision | undefined;
  if (typeof opts.budgetCapCents === "number") {
    budget = budgetVerdict(opts.spentCents ?? 0, opts.budgetCapCents);
    if (budget.verdict === "refuse") {
      return refuse("budget_refused", budget.reason, { budget });
    }
  }
  const withBudget = budget ? { budget } : undefined;

  // ── 2. localOnly narrows eligibility to operator-controlled entries ──
  let eligible = catalog;
  if (opts.localOnly) {
    const local = catalog.filter((e) => e.local === true);
    if (local.length === 0) {
      const providers = [...new Set(catalog.map((e) => e.provider ?? "unknown"))].join(", ");
      return refuse(
        "no_local_models",
        `local-only was requested but the approved catalog has no local models configured (available providers: ${providers}) — refusing rather than sending this turn to the cloud`,
        withBudget,
      );
    }
    eligible = local;
  }

  // ── 3. Provider preference is catalog-validated, never assumed ──────
  if (opts.provider) {
    const wanted = opts.provider.toLowerCase();
    const byProvider = eligible.filter((e) => (e.provider ?? "").toLowerCase() === wanted);
    if (byProvider.length === 0) {
      const known = [...new Set(eligible.map((e) => e.provider).filter(Boolean))].join(", ") || "none declared";
      return refuse(
        "unknown_provider",
        `requested provider "${opts.provider}" is not in the approved catalog (available: ${known}) — refusing rather than substituting another provider`,
        { ...withBudget, provider: opts.provider },
      );
    }
    eligible = byProvider;
  }

  const fallback = eligible[0];

  // ── 4. Explicit owner choice wins WITHIN eligibility ───────────────
  if (opts.overrideModel) {
    const hit = eligible.find((e) => e.model === opts.overrideModel);
    if (hit) return decide(hit, `owner picked "${hit.label}" for this turn (catalog-validated)`, withBudget);
    // Distinguish "not in catalog" from "excluded by localOnly/provider" —
    // a silent substitution would defeat the constraint the owner just set.
    const inFullCatalog = catalog.some((e) => e.model === opts.overrideModel);
    if (inFullCatalog) {
      return refuse(
        "unknown_provider",
        `requested model is in the catalog but excluded by the active constraint (localOnly/provider) — refusing rather than overriding the owner's constraint`,
        withBudget,
      );
    }
    return decide(fallback, `requested model is not in the approved catalog — stayed on the default`, withBudget);
  }

  // ── 5. cheapest: needs a declared price map, refuses without one ────
  if (opts.preference === "cheapest") {
    const priced = eligible
      .map((e) => ({ e, price: declaredPrice(e) }))
      .filter((x): x is { e: CatalogEntry; price: number } => typeof x.price === "number");
    if (priced.length === 0) {
      return refuse(
        "no_price_map",
        "cheapest was requested but the approved catalog carries no per-token price map — refusing rather than guessing a cost",
        withBudget,
      );
    }
    const cheapest = priced.sort((a, b) => a.price - b.price)[0]!;
    return decide(
      cheapest.e,
      `owner preference Cheapest — lowest declared catalog price (${cheapest.price}/Mtok)`,
      withBudget,
    );
  }

  // ── 6. High-stakes reasoning rule, then explicit preferences ────────
  const highStakes = opts.jobType === "legal" || opts.jobType === "technical";
  const needsReasoning =
    (highStakes && (opts.phase === "deliverable" || opts.phase === "verification")) ||
    opts.preference === "thorough";
  if (needsReasoning) {
    const reasoning = eligible.find(isReasoningCapable);
    if (reasoning) {
      return decide(
        reasoning,
        `${opts.jobType} ${opts.phase} turn — reasoning-capable entry preferred within the approved catalog`,
        withBudget,
      );
    }
    return decide(
      fallback,
      `${opts.jobType} ${opts.phase} turn wanted reasoning but the eligible catalog has none — stayed on the default (no silent escalation)`,
      withBudget,
    );
  }

  if (opts.preference === "faster") {
    const fast = eligible.find(isFast);
    if (fast) return decide(fast, `owner preference Faster — picked the fastest-labelled eligible entry`, withBudget);
  }

  return decide(fallback, `default Value policy — first approved catalog entry`, withBudget);
}
