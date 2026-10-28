/**
 * BZ-F038 — deterministic calculator.
 *
 * Arithmetic runs HERE, never in the model: + - * / % and parentheses over
 * plain decimals. Recursive-descent parse, no eval, no names, no units
 * guessing. Anything else is an explicit error — a failed calculation is
 * never silently final (QA-11); missing numbers stay missing.
 */

export type CalcResult =
  | { ok: true; value: number; expression: string; steps: string }
  | { ok: false; error: string };

const MAX_LEN = 200;

export function calculate(expression: string): CalcResult {
  const expr = String(expression ?? "").trim();
  if (!expr || expr.length > MAX_LEN) {
    return { ok: false, error: "Give me one arithmetic line, like 3*1200+450." };
  }
  if (!/^[\d\s.+\-*/()%]+$/.test(expr)) {
    return { ok: false, error: "I can only calculate numbers and + - * / % ( ) — no letters or formulas." };
  }

  let pos = 0;
  const peek = () => expr[pos];
  const skipWs = () => { while (expr[pos] === " ") pos++; };

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      skipWs();
      if (peek() === "+") { pos++; value += parseTerm(); }
      else if (peek() === "-") { pos++; value -= parseTerm(); }
      else return value;
    }
  }
  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      skipWs();
      if (peek() === "*") { pos++; value *= parseFactor(); }
      else if (peek() === "/") {
        pos++;
        const d = parseFactor();
        if (d === 0) throw new Error("division by zero");
        value /= d;
      } else if (peek() === "%") { pos++; value %= parseFactor(); }
      else return value;
    }
  }
  function parseFactor(): number {
    skipWs();
    if (peek() === "(") {
      pos++;
      const v = parseExpr();
      skipWs();
      if (peek() !== ")") throw new Error("missing closing parenthesis");
      pos++;
      return v;
    }
    if (peek() === "-") { pos++; return -parseFactor(); }
    if (peek() === "+") { pos++; return parseFactor(); }
    const m = /^[\d.]+/.exec(expr.slice(pos));
    if (!m) throw new Error(`unexpected character at position ${pos + 1}`);
    const num = Number(m[0]);
    if (!Number.isFinite(num)) throw new Error(`bad number "${m[0]}"`);
    pos += m[0].length;
    return num;
  }

  try {
    const value = parseExpr();
    skipWs();
    if (pos < expr.length) throw new Error(`leftover input at position ${pos + 1}`);
    if (!Number.isFinite(value)) throw new Error("result is not a finite number");
    const rounded = Math.round(value * 1e6) / 1e6;
    return { ok: true, value: rounded, expression: expr, steps: `${expr} = ${rounded}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** JSON schema for the calculate tool. */
export const CALCULATE_TOOL = {
  type: "function",
  function: {
    name: "calculate",
    description:
      "Evaluate ONE arithmetic line deterministically (numbers, + - * / %, parentheses). " +
      "Use for any total, sum, or checkable arithmetic — never compute in prose. " +
      "Missing inputs stay missing: do not invent numbers to fill the expression.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "One arithmetic line, e.g. 3*1200+450" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
} as const;
