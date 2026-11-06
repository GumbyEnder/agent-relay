/**
 * Mission-lane enforcement rules — P3 write-path guard.
 *
 * The SQL view `ar_mission_lane_violations` (0052) is the audit definition of a
 * violation. This module is the *write-path* definition: the same eight rule
 * codes, applied to the row a write is about to produce, so a bad transition is
 * refused with a 422 instead of being written and reported afterwards.
 *
 * Authority: Shane, 2026-11-05 (via grokbot, topic work), docs/MISSION-LANES-ENFORCEMENT.md:
 *   * `closed` is Shane-only — no other authority, including frodo
 *   * humans are exempt by the server-side authenticated principal, never by a
 *     body flag; their transitions are still recorded
 *   * agents and system actors get no exemption
 *   * enforce_active = per-board lanes_enforce AND the global LANES_ENFORCE env;
 *     the env is subtractive only, and an *unset* env is not consent
 */

export const LANES = ["open", "evidence", "closed", "blocked_evidence"] as const;
export type Lane = (typeof LANES)[number];

export const EVIDENCE_TYPES = [
  "test",
  "command_exit",
  "file",
  "url",
  "api_readback",
  "none",
] as const;

export const CHECK_RESULTS = ["pass", "fail", "blocked", "unverified"] as const;

/** A closed lane is writable only under this authority string. */
export const CLOSED_AUTHORITY = "shane";

export type LaneActorKind = "human" | "agent" | "system";

export type LaneViolationCode =
  | "lane_missing"
  | "lane_ambiguous"
  | "closed_no_authority"
  | "closed_no_evidence"
  | "pass_no_ref"
  | "blocked_no_reason"
  | "column_lane_mismatch"
  | "no_lane_history";

export type LaneViolation = { rule_code: LaneViolationCode; detail: string };

export type LaneRow = {
  lane: string | null;
  column_id: string;
  lane_authority?: string | null;
  evidence_type?: string | null;
  evidence_ref?: string | null;
  check_result?: string | null;
  evidence_missing?: string | null;
};

export type LaneWrite = {
  lane?: string | null;
  lane_authority?: string | null;
  evidence_type?: string | null;
  evidence_ref?: string | null;
  check_result?: string | null;
  check_output?: string | null;
  evidence_missing?: string | null;
};

/**
 * Global veto. Read once per call (not at module load) so a test can toggle it,
 * and so an unset/blank value reads as OFF — an absent env var is not consent.
 */
export function lanesEnforceEnvEnabled(
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {},
): boolean {
  const raw = (env.LANES_ENFORCE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** enforce_active = per-board flag AND global env. Global can only veto. */
export function laneEnforceActive(
  perBoard: boolean | null | undefined,
  env?: NodeJS.ProcessEnv,
): boolean {
  return Boolean(perBoard) && lanesEnforceEnvEnabled(env);
}

export function isLane(v: unknown): v is Lane {
  return typeof v === "string" && (LANES as readonly string[]).includes(v);
}

/**
 * Merge a requested lane write onto the current row, applying the defaults the
 * DB CHECK constraints require (`blocked_evidence` and `closed` must carry an
 * authority; a `pass` check must carry a ref).
 */
export function applyLaneWrite(
  current: LaneRow,
  input: LaneWrite,
  actor: { id: string; kind: LaneActorKind },
): LaneRow & { check_output?: string | null } {
  const pick = <T>(next: T | null | undefined, prev: T | null | undefined) =>
    next === undefined ? (prev ?? null) : next;

  const lane = (input.lane ?? current.lane ?? "open") as string;
  // Authority is a property of the lane the row ends up in. A human operator
  // closing a card is `shane`; an agent writing blocked-evidence is itself.
  const laneAuthority =
    input.lane_authority !== undefined
      ? input.lane_authority
      : lane === "closed"
        ? CLOSED_AUTHORITY
        : lane === "blocked_evidence"
          ? actor.id
          : null;

  return {
    lane,
    column_id: current.column_id,
    lane_authority: laneAuthority,
    evidence_type: pick(input.evidence_type, current.evidence_type),
    evidence_ref: pick(input.evidence_ref, current.evidence_ref),
    check_result: pick(input.check_result, current.check_result),
    evidence_missing: pick(input.evidence_missing, current.evidence_missing),
    check_output: input.check_output ?? null,
  };
}

/**
 * Rule codes the resulting row would carry, in the same vocabulary and order as
 * `ar_mission_lane_violations`. Empty array = clean write.
 *
 * `no_lane_history` is deliberately absent: the store inserts the history row in
 * the same transaction as the lane change, so the write can never create it.
 */
export function laneWriteViolations(opts: {
  current: LaneRow;
  next: LaneRow;
  actorKind: LaneActorKind;
}): LaneViolation[] {
  const { current, next, actorKind } = opts;
  const out: LaneViolation[] = [];
  const lane = next.lane;

  if (lane === null || lane === undefined || lane === "") {
    out.push({ rule_code: "lane_missing", detail: "mission has no lane" });
    return out;
  }
  if (!isLane(lane)) {
    out.push({
      rule_code: "lane_ambiguous",
      detail: `lane value not in the four lane vocabulary: ${lane}`,
    });
    return out;
  }

  // closed is Shane-only. Entering it, and leaving it, both need a human
  // principal — an agent may not close a card and may not re-open one.
  if (lane === "closed") {
    if (actorKind !== "human" || next.lane_authority !== CLOSED_AUTHORITY) {
      out.push({
        rule_code: "closed_no_authority",
        detail: `closed lane without ${CLOSED_AUTHORITY} authority (authority=${next.lane_authority ?? "null"}, actor_kind=${actorKind})`,
      });
    }
    if (!next.evidence_ref || next.check_result !== "pass") {
      out.push({
        rule_code: "closed_no_evidence",
        detail: "closed lane without pass + openable evidence_ref",
      });
    }
  } else if (current.lane === "closed" && actorKind !== "human") {
    out.push({
      rule_code: "closed_no_authority",
      detail: `only a human principal may move a closed lane (actor_kind=${actorKind})`,
    });
  }

  if (next.check_result === "pass" && !next.evidence_ref) {
    out.push({ rule_code: "pass_no_ref", detail: "check_result=pass with no evidence_ref" });
  }

  if (lane === "blocked_evidence" && !next.evidence_missing) {
    out.push({
      rule_code: "blocked_no_reason",
      detail: "blocked_evidence lane without evidence_missing",
    });
  }

  const column = next.column_id;
  if (
    (lane === "closed" && column !== "done") ||
    (lane === "blocked_evidence" && column !== "needs_human" && column !== "blocked") ||
    (column === "done" && lane !== "evidence" && lane !== "closed")
  ) {
    out.push({
      rule_code: "column_lane_mismatch",
      detail: `lane ${lane} does not fit column ${column}`,
    });
  }

  // A value outside the DB enum would fail the CHECK constraint as a 500;
  // report it as the ambiguity it is, before the write.
  if (next.evidence_type != null && !(EVIDENCE_TYPES as readonly string[]).includes(next.evidence_type)) {
    out.push({
      rule_code: "lane_ambiguous",
      detail: `evidence_type not in vocabulary: ${next.evidence_type}`,
    });
  }
  if (next.check_result != null && !(CHECK_RESULTS as readonly string[]).includes(next.check_result)) {
    out.push({
      rule_code: "lane_ambiguous",
      detail: `check_result not in vocabulary: ${next.check_result}`,
    });
  }

  return out;
}

/** Human-readable one-liner for an error body. */
export function describeViolations(violations: LaneViolation[]): string {
  return violations.map((v) => `${v.rule_code}: ${v.detail}`).join("; ");
}
