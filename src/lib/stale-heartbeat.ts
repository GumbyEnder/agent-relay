/**
 * Stale-heartbeat policy for Running missions.
 * Pure classifiers — UI and poll/admin surfaces call these.
 *
 * The classification must stay honest about WHICH bucket a card is in:
 *   - orphaned  → nobody owns it (no claimant), or it has no clock at all
 *   - stale     → owned, but its clock is older than the threshold
 * A card that keeps sitting in `running` with no owner is the exact state that
 * stranded 22 missions for 14 months (2026-11-10, msn_* running / claimed_by
 * null). Painting those as "stale" told the UI an agent was merely late when in
 * truth no agent existed. Order matters: ownership is checked first.
 */
import type { Mission, MissionColumn } from "./types";

/** Default: 5 minutes without heartbeat on Running → stale risk. */
export const DEFAULT_STALE_HEARTBEAT_MS = 5 * 60 * 1000;

export type MissionHealth = "ok" | "stale" | "orphaned" | "n/a";

export interface StalePolicy {
  /** Max age of the effective heartbeat clock before stale. */
  thresholdMs: number;
  /** Columns that require heartbeats. */
  columns: readonly MissionColumn[];
  /**
   * Missions carrying any of these tags are permanently exempt from the
   * heartbeat policy (they classify `n/a`, never stale/orphaned). `sustained`
   * marks work that legitimately runs for weeks without an agent attached.
   */
  exemptTags: readonly string[];
}

export const DEFAULT_STALE_POLICY: StalePolicy = {
  thresholdMs: DEFAULT_STALE_HEARTBEAT_MS,
  columns: ["running"],
  exemptTags: ["sustained"],
};

/**
 * Effective heartbeat clock = max(lastHeartbeat, claimedAt), else whichever
 * exists, else null.
 *
 * MAX, not "lastHeartbeat else claimedAt". A card released by the stale sweep
 * and re-claimed 10 seconds later still carries the dead heartbeat from the
 * previous owner; heartbeat-first ordering would read it as stale on arrival and
 * re-open the same defect one turn downstream.
 */
export function effectiveHeartbeatAt(m: Pick<Mission, "lastHeartbeat" | "claimedAt">): number | null {
  const hb = typeof m.lastHeartbeat === "number" && m.lastHeartbeat > 0 ? m.lastHeartbeat : null;
  const claimed = typeof m.claimedAt === "number" && m.claimedAt > 0 ? m.claimedAt : null;
  if (hb == null) return claimed;
  if (claimed == null) return hb;
  return Math.max(hb, claimed);
}

/** Input shape: a full Mission, or a fixture with the same fields. */
export type MissionHealthInput = Pick<
  Mission,
  "column" | "lastHeartbeat" | "claimedAt" | "claimedBy"
> & { tags?: readonly string[] };

function isExempt(m: MissionHealthInput, policy: StalePolicy): boolean {
  if (!m.tags?.length || !policy.exemptTags.length) return false;
  const tags = m.tags.map((t) => t.toLowerCase());
  return policy.exemptTags.some((t) => tags.includes(t.toLowerCase()));
}

/**
 * Classify a single mission against the stale policy.
 * - n/a: not in a heartbeat column, or tagged exempt (`sustained`)
 * - orphaned: in a heartbeat column with no claimant (nobody to heartbeat),
 *             or with no clock at all
 * - stale: owned, clock older than threshold
 * - ok: owned and fresh
 */
export function classifyMissionHealth(
  m: MissionHealthInput,
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): MissionHealth {
  if (!policy.columns.includes(m.column)) return "n/a";
  if (isExempt(m, policy)) return "n/a";
  // Ownership before clock. A released card keeps its old claimed_at/last_heartbeat
  // in some paths; a null claimant is the truth, and the clock is noise.
  if (!m.claimedBy) return "orphaned";
  const at = effectiveHeartbeatAt(m);
  if (at == null) return "orphaned";
  if (nowMs - at > policy.thresholdMs) return "stale";
  return "ok";
}

export function isStaleMission(
  m: MissionHealthInput,
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): boolean {
  return classifyMissionHealth(m, nowMs, policy) === "stale";
}

/** Running (or policy columns) missions past the threshold — reclaim candidates. */
export function listStaleMissions<T extends Mission>(
  missions: T[],
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): T[] {
  return missions.filter((m) => isStaleMission(m, nowMs, policy));
}

export function staleSummary(
  missions: Mission[],
  nowMs: number,
  policy: StalePolicy = DEFAULT_STALE_POLICY,
): {
  thresholdMs: number;
  staleCount: number;
  orphanedCount: number;
  okCount: number;
  staleIds: string[];
} {
  let staleCount = 0;
  let orphanedCount = 0;
  let okCount = 0;
  const staleIds: string[] = [];
  for (const m of missions) {
    const h = classifyMissionHealth(m, nowMs, policy);
    if (h === "stale") {
      staleCount++;
      staleIds.push(m.id);
    } else if (h === "orphaned") orphanedCount++;
    else if (h === "ok") okCount++;
  }
  return {
    thresholdMs: policy.thresholdMs,
    staleCount,
    orphanedCount,
    okCount,
    staleIds,
  };
}

export function policyFromEnv(
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {},
): StalePolicy {
  const raw = env.AGENT_RELAY_STALE_HEARTBEAT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return {
    ...DEFAULT_STALE_POLICY,
    thresholdMs:
      Number.isFinite(n) && n >= 1000 ? n : DEFAULT_STALE_HEARTBEAT_MS,
  };
}
