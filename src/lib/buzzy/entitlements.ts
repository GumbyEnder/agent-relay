/**
 * Entitlements and usage — the difference between "we proxy our key" and "we sell
 * access to our key".
 *
 * Every request that spends our provider money passes three questions in order:
 *
 *   1. is this token still allowed?      (tokens_valid_after, per account)
 *   2. is this plan allowed to ask?      (plan → scope allowance, model allowlist)
 *   3. is there quota left in the window? (ledger sum over 24 h)
 *
 * Only then does the gateway call the provider, and only then is a row written.
 * Refusals are recorded too, with status='refused' and the code — because "why did
 * this user hit a wall" must be answerable from data, not from memory.
 *
 * Design choice: quotas are computed from the ledger (rolling 24 h), never from a
 * counter column. A counter drifts whenever a request dies mid-flight; a SUM over an
 * index cannot.
 */
import { getSql } from "@/lib/db";

export type PlanName = "free" | "starter" | "pro";

export interface PlanRules {
  /** inference requests allowed in a rolling 24 h window */
  inferencePerDay: number;
  /** music seconds allowed in a rolling 24 h window (0 = the plan includes none) */
  musicSecondsPerDay: number;
  /** hard cap on one music request, whatever the remaining quota */
  musicMaxSeconds: number;
  /** images rendered per day; 0 = the plan does not include art */
  imagesPerDay: number;
  /**
   * Seconds a "Browser use" node may keep a server browser open in a rolling 24 h (the
   * browser costs money while it is open, so it is counted by the second). 0 = none.
   */
  browserSecondsPerDay: number;
  /**
   * Calls an "API use" node may make from this server's address in a rolling 24 h. A
   * node's Try it runs on the server, so on the free plan it would otherwise be a
   * shared egress proxy with no daily ceiling. 0 = the plan includes none.
   */
  apiCallsPerDay: number;
  /** models this plan may name; null = the deployment's own default set */
  models: string[] | null;
}

/**
 * Prices are the owner's business; these are cost ceilings. Change them here, not in
 * three call sites.
 */
/** Models a free account may name: the cheap lane only. Paid plans: any model. */
export const FREE_MODELS = (process.env.BZ_FREE_MODELS ?? "google/gemini-3.1-flash-lite,z-ai/glm-5.3-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

export const PLANS: Record<PlanName, PlanRules> = {
  // Music is the most expensive unit we buy, so it is a paid perk: a free account
  // gets chat on the cheap lane, not audio generation.
  free: { inferencePerDay: 100, musicSecondsPerDay: 0, musicMaxSeconds: 60, imagesPerDay: 0, browserSecondsPerDay: 600, apiCallsPerDay: 20, models: FREE_MODELS },
  starter: { inferencePerDay: 1000, musicSecondsPerDay: 900, musicMaxSeconds: 180, imagesPerDay: 60, browserSecondsPerDay: 3600, apiCallsPerDay: 300, models: null },
  pro: { inferencePerDay: 10000, musicSecondsPerDay: 3600, musicMaxSeconds: 600, imagesPerDay: 400, browserSecondsPerDay: 14400, apiCallsPerDay: 1000, models: null },
};

export const DEFAULT_PLAN: PlanName = ((): PlanName => {
  const raw = (process.env.BZ_DEFAULT_PLAN ?? "").trim().toLowerCase();
  return raw === "starter" || raw === "pro" || raw === "free" ? (raw as PlanName) : "free";
})();

export interface Entitlement {
  userId: string;
  plan: PlanName;
  planUntil: Date | null;
  tokensValidAfter: Date;
}

const asPlan = (raw: unknown): PlanName => {
  const v = String(raw ?? "").toLowerCase();
  return v === "starter" || v === "pro" || v === "free" ? (v as PlanName) : DEFAULT_PLAN;
};

/**
 * Read the account's entitlement. No row means the deployment default plan, with no
 * revocation epoch — a brand-new account must work, not 500.
 */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const id = (userId ?? "").trim();
  if (!id) return { userId: "", plan: DEFAULT_PLAN, planUntil: null, tokensValidAfter: new Date(0) };
  try {
    const sql = await getSql();
    const rows = await sql<{ plan: string; plan_until: string | null; tokens_valid_after: string | null }>`
      SELECT plan, plan_until, tokens_valid_after
      FROM bz_entitlements
      WHERE user_id = ${id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { userId: id, plan: DEFAULT_PLAN, planUntil: null, tokensValidAfter: new Date(0) };
    const until = row.plan_until ? new Date(row.plan_until) : null;
    // An expired paid plan falls back to free rather than failing closed on the whole
    // account: a lapsed card should downgrade the user, not lock them out of chat.
    const effective = until && until.getTime() < Date.now() ? "free" : asPlan(row.plan);
    return {
      userId: id,
      plan: effective as PlanName,
      planUntil: until,
      tokensValidAfter: row.tokens_valid_after ? new Date(row.tokens_valid_after) : new Date(0),
    };
  } catch {
    // A ledger we cannot read must not take chat down; free is the safe ceiling.
    return { userId: id, plan: DEFAULT_PLAN, planUntil: null, tokensValidAfter: new Date(0) };
  }
}

/** Thrown when the usage ledger cannot be read. */
export class UsageUnreadable extends Error {
  readonly scope: string;
  constructor(scope: string) {
    super(`usage ledger unreadable for scope ${scope}`);
    this.name = "UsageUnreadable";
    this.scope = scope;
  }
}

/**
 * Units spent in the rolling window, for one scope.
 *
 * Throws when the ledger cannot be read. It used to return 0, which made every
 * "is there quota left" answer a yes during a database hiccup — the browser and
 * the API node then spent with no ceiling at all. Callers decide: the gate
 * (checkQuota) fails closed, the display path (browserInfo) says it does not know.
 */
export async function unitsInWindow(userId: string, scope: string, hours = 24): Promise<number> {
  let rows: Array<{ used: string | number | null }>;
  try {
    const sql = await getSql();
    rows = await sql<{ used: string | number | null }>`
      SELECT COALESCE(SUM(units), 0) AS used
      FROM bz_usage
      WHERE user_id = ${userId}
        AND scope = ${scope}
        AND status = 'ok'
        AND created_at > now() - (${hours}::text || ' hours')::interval
    `;
  } catch {
    throw new UsageUnreadable(scope);
  }
  const used = Number(rows[0]?.used ?? 0);
  if (!Number.isFinite(used)) throw new UsageUnreadable(scope);
  return used;
}

export interface QuotaVerdict {
  ok: boolean;
  code?: "plan_required" | "quota_exhausted" | "model_not_allowed" | "usage_unknown";
  error?: string;
  plan: PlanName;
  used?: number;
  limit?: number;
}

/**
 * Would this request be allowed? Pure decision — writing usage is a separate step so
 * a refused request can still be recorded without being counted as spend.
 */
export async function checkQuota(opts: {
  userId: string;
  scope: "inference" | "music" | "image" | "browser" | "api";
  /** music: requested seconds. inference: 1. browser: the seconds about to be used (default 1). api: calls about to be made (default 1) */
  units?: number;
  model?: string;
}): Promise<QuotaVerdict> {
  const ent = await getEntitlement(opts.userId);
  const rules = PLANS[ent.plan] ?? PLANS.free;

  // A ledger we cannot read is not a ledger that says "nothing used yet". Every
  // scope below refuses rather than passing with used = 0.
  const usage = async (scope: string): Promise<number | null> => {
    try {
      return await unitsInWindow(opts.userId, scope);
    } catch {
      return null;
    }
  };
  const unreadable = (scope: string): QuotaVerdict => ({
    ok: false,
    code: "usage_unknown",
    plan: ent.plan,
    error: `BeeZilla can't read how much ${scope} is left today, so it won't start more until it can — try again in a moment`,
  });

  if (opts.scope === "music") {
    const want = Math.max(1, Math.round(opts.units ?? 0));
    if (rules.musicSecondsPerDay <= 0) {
      return {
        ok: false,
        code: "plan_required",
        plan: ent.plan,
        error: `the ${ent.plan} plan does not include BeeZilla music — music is part of the paid plans`,
      };
    }
    if (want > rules.musicMaxSeconds) {
      return {
        ok: false,
        code: "quota_exhausted",
        plan: ent.plan,
        limit: rules.musicMaxSeconds,
        error: `one track is capped at ${rules.musicMaxSeconds}s on the ${ent.plan} plan`,
      };
    }
    const used = await usage("music");
    if (used === null) return unreadable("music");
    if (used + want > rules.musicSecondsPerDay) {
      return {
        ok: false,
        code: "quota_exhausted",
        plan: ent.plan,
        used,
        limit: rules.musicSecondsPerDay,
        error: `music quota for the ${ent.plan} plan is ${rules.musicSecondsPerDay}s per day — ${Math.max(0, Math.floor(rules.musicSecondsPerDay - used))}s left`,
      };
    }
    return { ok: true, plan: ent.plan, used, limit: rules.musicSecondsPerDay };
  }

  if (opts.scope === "browser") {
    const want = Math.max(1, Math.round(opts.units ?? 1));
    const used = await usage("browser");
    if (used === null) return unreadable("browser");
    if (rules.browserSecondsPerDay <= 0 || used + want > rules.browserSecondsPerDay) {
      const left = Math.max(0, Math.floor(rules.browserSecondsPerDay - used));
      return {
        ok: false,
        code: rules.browserSecondsPerDay <= 0 ? "plan_required" : "quota_exhausted",
        plan: ent.plan,
        used,
        limit: rules.browserSecondsPerDay,
        error: rules.browserSecondsPerDay <= 0
          ? `the ${ent.plan} plan does not include the server browser`
          : `the ${ent.plan} plan includes ${Math.round(rules.browserSecondsPerDay / 60)} minutes of server browser a day, and ${left <= 0 ? "today's are used up" : `${Math.ceil(left / 60)} minute${left > 60 ? "s are" : " is"} left`}. It comes back on a rolling 24 hours`,
      };
    }
    return { ok: true, plan: ent.plan, used, limit: rules.browserSecondsPerDay };
  }

  if (opts.scope === "image") {
    const want = Math.max(1, Math.round(opts.units ?? 1));
    if (rules.imagesPerDay <= 0) {
      return {
        ok: false,
        code: "plan_required",
        plan: ent.plan,
        error: `the ${ent.plan} plan does not include BeeZilla art — images are part of the paid plans`,
      };
    }
    const used = await usage("image");
    if (used === null) return unreadable("image");
    if (used + want > rules.imagesPerDay) {
      return {
        ok: false,
        code: "quota_exhausted",
        plan: ent.plan,
        used,
        limit: rules.imagesPerDay,
        error: `image quota for the ${ent.plan} plan is ${rules.imagesPerDay} per day — ${Math.max(0, rules.imagesPerDay - used)} left`,
      };
    }
    return { ok: true, plan: ent.plan, used, limit: rules.imagesPerDay };
  }

  // API use: a node's "Try it" calls a website from this server's address, so it is a
  // shared egress proxy — it belongs to a plan and it is counted, not just rate-limited.
  // The in-process limiter in boardNodes.nitro (30 tries / 10 min) stays as the flood
  // guard; this is the daily ceiling that the free plan was missing entirely.
  if (opts.scope === "api") {
    const want = Math.max(1, Math.round(opts.units ?? 1));
    if (rules.apiCallsPerDay <= 0) {
      return {
        ok: false,
        code: "plan_required",
        plan: ent.plan,
        error: `the ${ent.plan} plan does not include API use — it needs calls made from BeeZilla's own address, which is part of the paid plans`,
      };
    }
    const used = await usage("api");
    if (used === null) return unreadable("API use");
    if (used + want > rules.apiCallsPerDay) {
      return {
        ok: false,
        code: "quota_exhausted",
        plan: ent.plan,
        used,
        limit: rules.apiCallsPerDay,
        error: `API use on the ${ent.plan} plan is ${rules.apiCallsPerDay} calls per day — ${Math.max(0, rules.apiCallsPerDay - used)} left, back on a rolling 24 hours`,
      };
    }
    return { ok: true, plan: ent.plan, used, limit: rules.apiCallsPerDay };
  }

  // Inference: count requests, and hold the caller to the plan's model list when the
  // deployment publishes one.
  const model = (opts.model ?? "").trim();
  if (model && rules.models && !rules.models.includes(model)) {
    return {
      ok: false,
      code: "model_not_allowed",
      plan: ent.plan,
      error: `the ${ent.plan} plan does not include ${model}`,
    };
  }
  const used = await usage("inference");
  if (used === null) return unreadable("chat");
  if (used + 1 > rules.inferencePerDay) {
    return {
      ok: false,
      code: "quota_exhausted",
      plan: ent.plan,
      used,
      limit: rules.inferencePerDay,
      error: `inference quota for the ${ent.plan} plan is ${rules.inferencePerDay} requests per day — it resets on a rolling 24 h window`,
    };
  }
  return { ok: true, plan: ent.plan, used, limit: rules.inferencePerDay };
}

/** Write one ledger row. Never throws: a failed audit write must not fail the request. */
export async function recordUsage(opts: {
  userId: string;
  scope: string;
  units: number;
  ms: number;
  status: "ok" | "refused" | "failed";
  code?: string | null;
  model?: string | null;
  jti?: string | null;
}): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      INSERT INTO bz_usage (user_id, scope, units, ms, status, code, model, jti)
      VALUES (
        ${opts.userId},
        ${opts.scope},
        ${opts.units},
        ${Math.max(0, Math.round(opts.ms))},
        ${opts.status},
        ${opts.code ?? null},
        ${opts.model ?? null},
        ${opts.jti ?? null}
      )
    `;
  } catch (err) {
    console.warn("[buzzy/usage] could not record usage:", err instanceof Error ? err.message : err);
  }
}

/** Strictly increasing: a revocation must invalidate tokens minted in the same second. */
export async function revokeTokens(userId: string): Promise<Date> {
  const sql = await getSql();
  const rows = await sql<{ tokens_valid_after: string }>`
    INSERT INTO bz_entitlements (user_id, tokens_valid_after, updated_at)
    VALUES (${userId}, now() + interval '1 second', now())
    ON CONFLICT (user_id) DO UPDATE
      SET tokens_valid_after = now() + interval '1 second',
          updated_at = now()
    RETURNING tokens_valid_after
  `;
  return new Date(rows[0].tokens_valid_after);
}

export async function setPlan(userId: string, plan: PlanName, planUntil?: Date | null, note?: string): Promise<void> {
  const sql = await getSql();
  await sql`
    INSERT INTO bz_entitlements (user_id, plan, plan_until, note, updated_at)
    VALUES (${userId}, ${plan}, ${planUntil ?? null}, ${note ?? null}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET plan = ${plan},
          plan_until = ${planUntil ?? null},
          note = COALESCE(${note ?? null}, bz_entitlements.note),
          updated_at = now()
  `;
}

/** Everything a UI needs to say "you are on X, Y left". */
export async function describeEntitlement(userId: string) {
  const ent = await getEntitlement(userId);
  const rules = PLANS[ent.plan];
  // Read-only display: an unreadable ledger says "unknown", it does not take the page
  // down. The gate is checkQuota, and there an unreadable ledger refuses.
  const read = (scope: string) => unitsInWindow(userId, scope).catch(() => null);
  const [inferenceUsed, musicUsed] = await Promise.all([read("inference"), read("music")]);
  return {
    plan: ent.plan,
    planUntil: ent.planUntil?.toISOString() ?? null,
    limits: {
      inferencePerDay: rules.inferencePerDay,
      musicSecondsPerDay: rules.musicSecondsPerDay,
      musicMaxSeconds: rules.musicMaxSeconds,
      models: rules.models,
    },
    used: { inference: inferenceUsed, musicSeconds: musicUsed },
    remaining: {
      inference: inferenceUsed === null ? null : Math.max(0, rules.inferencePerDay - inferenceUsed),
      musicSeconds: musicUsed === null ? null : Math.max(0, rules.musicSecondsPerDay - musicUsed),
    },
  };
}
