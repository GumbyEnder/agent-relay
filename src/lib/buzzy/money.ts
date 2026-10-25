/**
 * Check the money before approval.
 * The page script is the check. This wrapper only types it and refuses a rewritten draft.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export interface MoneyFact {
  key: string;
  label?: string;
  value: string;
  status: string;
  place?: string;
  source?: string;
}

export interface MoneyBriefLine {
  label?: string;
  value: string;
  status: "confirmed" | "skipped" | "open" | "proposed";
}

export interface MoneyCheckItem {
  tone: "match" | "blank" | "unconfirmed" | "wrong";
  text: string;
}

export interface MoneyCheck {
  items: MoneyCheckItem[];
  blocksApproval: boolean;
  /** The draft the owner already has. The check does not fill a blank. */
  draft: string;
}

export interface MoneyInput {
  draft: string;
  facts?: MoneyFact[];
  brief?: MoneyBriefLine[];
  kind?: string;
}

type CheckFn = (input: MoneyInput) => MoneyCheck;

let checkFn: CheckFn | null = null;

function loadCheck(): CheckFn {
  if (checkFn) return checkFn;
  const jsPath = join(dirname(fileURLToPath(import.meta.url)), "../../../public/buzzy/money-check.js");
  const code = readFileSync(jsPath, "utf8");
  const sandbox: { checkMoney?: CheckFn } = {};
  runInNewContext(code, sandbox, { filename: "money-check.js" });
  if (typeof sandbox.checkMoney !== "function") {
    throw new Error("money check missing");
  }
  checkFn = sandbox.checkMoney;
  return checkFn;
}

export function checkMoney(input: MoneyInput): MoneyCheck {
  const draft = typeof input.draft === "string" ? input.draft : "";
  const out = loadCheck()({ ...input, draft });
  const items = Array.isArray(out.items) ? out.items : [];
  return {
    items,
    blocksApproval: items.some((item) => item.tone === "wrong"),
    draft,
  };
}

// ── Spend ceiling ───────────────────────────────────────────────────
// The owner can set a cap; the verdict decides whether a turn proceeds, asks,
// or stops. This is deliberately NOT a cost estimate — it compares spend that
// has already been recorded against a cap the owner set. No price map is
// required to answer "have we spent more than the owner allowed?", which is
// why this control is shippable before per-token prices exist.

export type BudgetVerdict = "allow" | "ask" | "refuse";

export interface BudgetDecision {
  verdict: BudgetVerdict;
  /** Spend already recorded, in cents. Negative input is treated as 0. */
  spentCents: number;
  /** The owner's ceiling. <= 0 means "no cap set". */
  capCents: number;
  remainingCents: number;
  /** Human-readable explanation — the audit trail, not a UI string. */
  reason: string;
}

/**
 * The "ask" band: how close to the cap counts as near enough to confirm first.
 * Defaults to 10% of the cap with a 50c floor, so a small cap still asks before
 * the last few cents and a large cap does not nag from far away.
 */
export function defaultAskWithinCents(capCents: number): number {
  if (!Number.isFinite(capCents) || capCents <= 0) return 0;
  return Math.max(50, Math.round(capCents * 0.1));
}

/**
 * Decide what a spend ceiling means for this turn.
 *
 *  - no cap (`capCents <= 0`)        → allow
 *  - spent >= cap                     → refuse (hard stop; do not silently continue)
 *  - remaining <= ask band            → ask (human confirms before spending more)
 *  - otherwise                        → allow
 *
 * Boundary behaviour is intentional and pinned by tests: `spent === cap` is a
 * refusal, not an "ask" — the owner said stop AT the cap, not after it.
 */
export function budgetVerdict(
  spentCents: number,
  capCents: number,
  opts?: { askWithinCents?: number },
): BudgetDecision {
  const spent = Number.isFinite(spentCents) && spentCents > 0 ? spentCents : 0;
  const cap = Number.isFinite(capCents) ? capCents : 0;

  if (cap <= 0) {
    return {
      verdict: "allow",
      spentCents: spent,
      capCents: cap,
      remainingCents: 0,
      reason: "no spend cap set by the owner — no ceiling to enforce",
    };
  }

  const remaining = cap - spent;

  if (remaining <= 0) {
    return {
      verdict: "refuse",
      spentCents: spent,
      capCents: cap,
      remainingCents: remaining,
      reason: `spend ${spent}c has reached the owner's ${cap}c cap — stopping rather than continuing`,
    };
  }

  const askWithin = opts?.askWithinCents ?? defaultAskWithinCents(cap);
  if (remaining <= askWithin) {
    return {
      verdict: "ask",
      spentCents: spent,
      capCents: cap,
      remainingCents: remaining,
      reason: `${remaining}c left of the owner's ${cap}c cap (within ${askWithin}c) — confirm before spending more`,
    };
  }

  return {
    verdict: "allow",
    spentCents: spent,
    capCents: cap,
    remainingCents: remaining,
    reason: `${remaining}c left of the owner's ${cap}c cap — under the ceiling`,
  };
}
