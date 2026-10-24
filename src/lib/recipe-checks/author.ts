/**
 * Recipe Seal — Step 1: authoring API.
 *
 * Rules are expressed with combinators rather than arbitrary TypeScript, because
 * an arbitrary function cannot be compiled to a deterministic, sealed program.
 * This is the trade that makes the whole protocol possible.
 */
import type { Expr, Literal, Rule, Severity } from "./types";

// ── expression builders ───────────────────────────────────────────────────────
export const and = (...args: Expr[]): Expr => ({ op: "and", args });
export const or = (...args: Expr[]): Expr => ({ op: "or", args });
export const not = (arg: Expr): Expr => ({ op: "not", arg });

export const eq = (path: string, value: Literal): Expr => ({ op: "eq", path, value });
export const neq = (path: string, value: Literal): Expr => ({ op: "neq", path, value });
export const oneOf = (path: string, values: Literal[]): Expr => ({ op: "in", path, values });
export const lt = (path: string, value: number): Expr => ({ op: "lt", path, value });
export const lte = (path: string, value: number): Expr => ({ op: "lte", path, value });
export const gt = (path: string, value: number): Expr => ({ op: "gt", path, value });
export const gte = (path: string, value: number): Expr => ({ op: "gte", path, value });
export const starts = (path: string, value: string): Expr => ({ op: "starts", path, value });
export const ends = (path: string, value: string): Expr => ({ op: "ends", path, value });
export const has = (path: string, value: string): Expr => ({ op: "has", path, value });
export const truthy = (path: string): Expr => ({ op: "truthy", path });
export const falsy = (path: string): Expr => ({ op: "falsy", path });
export const isEmpty = (path: string): Expr => ({ op: "empty", path });
export const nonempty = (path: string): Expr => ({ op: "nonempty", path });

/** Deterministic regex test. Pattern source is folded into the sealed artifact. */
export const matches = (path: string, pattern: string, flags = "i"): Expr => ({ op: "matches", path, pattern, flags });
/** Value is already a canonical unit token (lowercase, trimmed, no trailing dot). */
export const canonicalUnit = (path: string): Expr => ({ op: "canonicalUnit", path });
/** Value is an integer (money is always integer cents, counts are never guessed). */
export const integer = (path: string): Expr => ({ op: "integer", path });
/** a <= b where both are paths. */
export const ltePath = (a: string, b: string): Expr => ({ op: "ltePath", a, b });
/** a === b where both are paths. */
export const eqPath = (a: string, b: string): Expr => ({ op: "eqPath", a, b });

/** every element of `path` matching `where` must satisfy `check` */
export const allOf = (path: string, check: Expr, where?: Expr): Expr => ({ op: "allOf", path, check, where });
/** at least one element matching `where` satisfies `check` */
export const anyOf = (path: string, check: Expr, where?: Expr): Expr => ({ op: "anyOf", path, check, where });
/** no element matching `where` satisfies `check` */
export const noneOf = (path: string, check: Expr, where?: Expr): Expr => ({ op: "noneOf", path, check, where });
/** at least n elements matching `where` */
export const countGte = (path: string, n: number, where?: Expr): Expr => ({ op: "countGte", path, n, where });

export interface RuleInput {
  id: string;
  code: string;
  severity?: Severity;
  /** Author-side documentation. Never shipped. */
  description: string;
  expr: Expr;
}

export function defineRule(input: RuleInput): Rule {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(input.id)) {
    throw new Error(`rule id must be kebab-case: ${input.id}`);
  }
  if (!/^C\d{2}$/.test(input.code)) {
    throw new Error(`rule code must match C00-C99: ${input.code}`);
  }
  return {
    id: input.id,
    code: input.code,
    severity: input.severity ?? "block",
    description: input.description,
    expr: input.expr,
  };
}

// ── deterministic helpers (available to authors, mirrored in the VM) ──────────

/** Money to integer cents. Rejects scientific notation and thousands separators. */
export function moneyToCents(raw: string): number | null {
  const m = /^-?\d+(\.\d{1,2})?$/.exec(raw.trim());
  if (!m) return null;
  const [whole, frac = ""] = raw.trim().split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  const abs = Math.abs(Number(whole));
  const cents = Number((frac + "00").slice(0, 2));
  return sign * (abs * 100 + cents);
}

/** Normalise a unit token for comparison: lowercase, trim, strip trailing period. */
export function normaliseUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\.$/, "");
}

/** ISO date comparison without Date objects (no timezone drift). */
export function compareIsoDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tokens for leak detection: lowercase alphanumeric runs. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Set of n-token shingles for overlap detection. */
export function shingles(text: string, n = 8): Set<string> {
  const t = tokenise(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}
