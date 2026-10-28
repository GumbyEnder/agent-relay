/**
 * BZ-F043 — read the operator's saved model controls for one turn.
 *
 * The controls live in `ar_operator_prefs.prefs` (the existing JSONB column), so
 * this adds no schema. Everything read here is ownership-scoped to the `userId`
 * the turn already resolved — a turn for one account cannot read another's.
 *
 * Validation is deliberate: a stored value that the running policy does not
 * recognise is NOT passed through. It degrades to `value` and reports why, so a
 * stale pref or a hand-edited row leaves a trace instead of quietly changing
 * which model answers.
 */

import type { Sql } from "@/lib/db";
import type { ModelPreference } from "./modelPolicy";

/** The preferences the running policy understands. Keep in step with modelPolicy. */
export const KNOWN_PREFERENCES: readonly ModelPreference[] = [
  "value",
  "faster",
  "thorough",
  "cheapest",
] as const;

export interface ModelPrefs {
  preference: ModelPreference;
  /** "stored" when the saved value was used; "default" when it was absent or rejected. */
  preferenceSource: "stored" | "default";
  /** Set only when a stored value was rejected. Human-readable, for the audit record. */
  degradation?: string;
  provider?: string;
  localOnly: boolean;
  budgetCapCents?: number;
  /** Spend already recorded this calendar month, in cents. */
  spentCents: number;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function readModelPrefs(sql: Sql, userId: string): Promise<ModelPrefs> {
  const rows = (await sql`
    select prefs from ar_operator_prefs where user_id = ${userId} limit 1
  `) as Array<{ prefs: unknown }>;

  const raw = rows[0]?.prefs;
  const prefs: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const stored = asString(prefs.modelPreference);
  let preference: ModelPreference = "value";
  let preferenceSource: ModelPrefs["preferenceSource"] = "default";
  let degradation: string | undefined;

  if (stored) {
    const hit = KNOWN_PREFERENCES.find((p) => p === stored);
    if (hit) {
      preference = hit;
      preferenceSource = "stored";
    } else {
      degradation = `stored modelPreference "${stored}" is not recognised by policy mp-1.1.0 — used the default (value)`;
    }
  }

  // Spend: cost_usd is nullable until the catalog carries a price map, so an
  // unpriced deployment sums to 0 and the cap simply has nothing to count yet.
  const spendRows = (await sql`
    select coalesce(sum(cost_usd), 0) as usd
    from buzzy_chat_messages
    where user_id = ${userId}
      and cost_usd is not null
      and created_at >= date_trunc('month', now())
  `) as Array<{ usd: unknown }>;
  const usd = asNumber(spendRows[0]?.usd) ?? 0;

  const cap = asNumber(prefs.budgetCapCents);

  return {
    preference,
    preferenceSource,
    ...(degradation ? { degradation } : {}),
    provider: asString(prefs.provider),
    localOnly: prefs.localOnly === true,
    ...(cap !== undefined && cap > 0 ? { budgetCapCents: cap } : {}),
    spentCents: Math.max(0, Math.round(usd * 100)),
  };
}

/** Validate a client-supplied patch before it is written to the prefs row. */
export function validateModelPrefsPatch(
  patch: Record<string, unknown>,
): { ok: true; clean: Record<string, unknown> } | { ok: false; error: string } {
  const clean: Record<string, unknown> = {};

  if ("modelPreference" in patch) {
    const v = patch.modelPreference;
    if (v === null || v === "") {
      clean.modelPreference = null;
    } else {
      const s = asString(v);
      if (!s || !KNOWN_PREFERENCES.some((p) => p === s)) {
        return {
          ok: false,
          error: `modelPreference must be one of ${KNOWN_PREFERENCES.join(", ")}`,
        };
      }
      clean.modelPreference = s;
    }
  }

  if ("provider" in patch) {
    const s = asString(patch.provider);
    clean.provider = s ?? null;
  }

  if ("localOnly" in patch) {
    if (typeof patch.localOnly !== "boolean") {
      return { ok: false, error: "localOnly must be a boolean" };
    }
    clean.localOnly = patch.localOnly;
  }

  if ("budgetCapCents" in patch) {
    const v = patch.budgetCapCents;
    if (v === null) {
      clean.budgetCapCents = null;
    } else {
      const n = asNumber(v);
      if (n === undefined || n < 0 || !Number.isInteger(n)) {
        return { ok: false, error: "budgetCapCents must be a non-negative integer number of cents" };
      }
      clean.budgetCapCents = n;
    }
  }

  return { ok: true, clean };
}
