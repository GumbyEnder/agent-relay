/**
 * Recipe Seal — Step 1: the rule VM.
 *
 * Deterministic by construction: no clock, no randomness, no IO, no locale.
 * Every node visit costs one fuel unit; exceeding the budget is a hard failure,
 * not a silent pass.
 */
import { BudgetExceededError, type EvaluationResult, type Expr, type Literal, type Rule } from "./types";

export const FUEL_BUDGET = 2_000_000;

type Ctx = Record<string, unknown>;

function resolve(ctx: Ctx | unknown, path: string): unknown {
  if (path === "" || path === ".") return ctx;
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Ctx)[part];
  }
  return cur;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function cmp(op: string, a: unknown, b: Literal): boolean {
  if (op === "eq") return a === b;
  if (op === "neq") return a !== b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  switch (op) {
    case "lt": return a < b;
    case "lte": return a <= b;
    case "gt": return a > b;
    case "gte": return a >= b;
    default: return false;
  }
}

class Fuel {
  nodes = 0;
  constructor(private readonly budget: number) {}
  spend(): void {
    if (++this.nodes > this.budget) throw new BudgetExceededError();
  }
}

function evalExpr(expr: Expr, ctx: unknown, fuel: Fuel): boolean {
  fuel.spend();
  switch (expr.op) {
    case "and": return expr.args.every((a) => evalExpr(a, ctx, fuel));
    case "or": return expr.args.some((a) => evalExpr(a, ctx, fuel));
    case "not": return !evalExpr(expr.arg, ctx, fuel);

    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return cmp(expr.op, resolve(ctx, expr.path), expr.value);

    case "in": {
      const v = resolve(ctx, expr.path);
      return expr.values.includes(v as Literal);
    }
    case "starts": {
      const v = resolve(ctx, expr.path);
      return typeof v === "string" && v.startsWith(expr.value);
    }
    case "ends": {
      const v = resolve(ctx, expr.path);
      return typeof v === "string" && v.endsWith(expr.value);
    }
    case "has": {
      const v = resolve(ctx, expr.path);
      return typeof v === "string" && v.includes(expr.value);
    }
    case "truthy": {
      const v = resolve(ctx, expr.path);
      return v !== null && v !== undefined && v !== false && v !== "" && v !== 0;
    }
    case "falsy": {
      const v = resolve(ctx, expr.path);
      return v === null || v === undefined || v === false || v === "" || v === 0;
    }
    case "empty": {
      const v = resolve(ctx, expr.path);
      if (v === null || v === undefined) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === "string") return v.trim() === "";
      return false;
    }
    case "nonempty": {
      const v = resolve(ctx, expr.path);
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "string") return v.trim() !== "";
      return v !== null && v !== undefined;
    }

    case "matches": {
      const v = resolve(ctx, expr.path);
      if (typeof v !== "string") return false;
      // Author-supplied patterns are capped; only the `i` flag is honoured so a
      // sealed program can never smuggle stateful (g/y) behaviour in.
      if (expr.pattern.length > 500) return false;
      // String() so a malformed flag cannot throw here; the author validator
      // refuses non-strings at load, this is the runtime backstop.
      const flags = String(expr.flags ?? "").replace(/[^i]/g, "");
      return new RegExp(expr.pattern, flags).test(v);
    }
    case "canonicalUnit": {
      const v = resolve(ctx, expr.path);
      return typeof v === "string" && v === v.trim().toLowerCase().replace(/\.$/, "") && v.length > 0;
    }
    case "integer": {
      const v = resolve(ctx, expr.path);
      return typeof v === "number" && Number.isInteger(v);
    }
    case "ltePath": {
      const a = resolve(ctx, expr.a);
      const b = resolve(ctx, expr.b);
      return typeof a === "number" && typeof b === "number" && a <= b;
    }
    case "eqPath": {
      const a = resolve(ctx, expr.a);
      const b = resolve(ctx, expr.b);
      return a !== undefined && b !== undefined && a === b;
    }

    case "allOf": {
      const arr = asArray(resolve(ctx, expr.path));
      if (!arr) return false; // fail closed: no collection means unverifiable
      const scoped = expr.where ? arr.filter((e) => evalExpr(expr.where as Expr, e, fuel)) : arr;
      return scoped.every((e) => evalExpr(expr.check, e, fuel));
    }
    case "anyOf": {
      const arr = asArray(resolve(ctx, expr.path));
      if (!arr) return false;
      const scoped = expr.where ? arr.filter((e) => evalExpr(expr.where as Expr, e, fuel)) : arr;
      return scoped.some((e) => evalExpr(expr.check, e, fuel));
    }
    case "noneOf": {
      const arr = asArray(resolve(ctx, expr.path));
      if (!arr) return true; // nothing asserted, nothing violated
      const scoped = expr.where ? arr.filter((e) => evalExpr(expr.where as Expr, e, fuel)) : arr;
      return !scoped.some((e) => evalExpr(expr.check, e, fuel));
    }
    case "countGte": {
      const arr = asArray(resolve(ctx, expr.path));
      if (!arr) return false;
      const scoped = expr.where ? arr.filter((e) => evalExpr(expr.where as Expr, e, fuel)) : arr;
      return scoped.length >= expr.n;
    }
    default: {
      // Unknown opcode: fail closed. A sealed program can never "pass" by
      // containing a node this VM does not understand.
      return false;
    }
  }
}

export function evaluateDraft(
  draft: unknown,
  rules: Rule[],
  opts: { budget?: number } = {},
): EvaluationResult {
  const started = Date.now();
  const fuel = new Fuel(opts.budget ?? FUEL_BUDGET);
  const codes: string[] = [];
  const warnings: string[] = [];
  let ok = true;

  try {
    for (const rule of rules) {
      const pass = evalExpr(rule.expr, draft, fuel);
      if (pass) continue;
      if (rule.severity === "block") {
        ok = false;
        codes.push(rule.code);
      } else {
        warnings.push(rule.code);
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return {
        ok: false,
        codes: ["C00"],
        warnings,
        ms: Date.now() - started,
        nodes: fuel.nodes,
        budgetExceeded: true,
      };
    }
    throw err;
  }

  // Codes are stable and sorted: the response must not reveal evaluation order.
  codes.sort();
  warnings.sort();
  return { ok, codes, warnings, ms: Date.now() - started, nodes: fuel.nodes };
}
