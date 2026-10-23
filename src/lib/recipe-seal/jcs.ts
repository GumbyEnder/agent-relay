/**
 * Recipe Seal — Step 2: RFC 8785 (JCS) canonicalisation.
 *
 * A bundle's identity is sha256 over the canonical manifest. Any deviation in
 * key order, whitespace or number formatting changes the hash and breaks every
 * signature downstream, so this is deliberately strict:
 *  - numbers must be integers (no floats, no -0, no NaN) — money is cents
 *  - arrays and objects only keep own enumerable keys
 *  - undefined/function/symbol are rejected rather than silently dropped
 */
export class CanonicalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalisationError";
  }
}

export function canonicalise(value: unknown): string {
  return write(value);
}

function write(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      return escapeString(v);
    case "number": {
      if (!Number.isFinite(v)) throw new CanonicalisationError(`non-finite number: ${v}`);
      if (!Number.isInteger(v)) throw new CanonicalisationError(`floats are not allowed in a manifest: ${v}`);
      if (Object.is(v, -0)) throw new CanonicalisationError("negative zero is not allowed");
      return String(v);
    }
    case "object":
      break;
    default:
      throw new CanonicalisationError(`unsupported type: ${typeof v}`);
  }

  if (Array.isArray(v)) return `[${v.map((x) => write(x)).join(",")}]`;

  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${escapeString(k)}:${write(obj[k])}`);
  }
  return `{${parts.join(",")}}`;
}

function escapeString(s: string): string {
  // JSON.stringify already produces the JCS-required escaping for the control
  // characters and quotes; JCS leaves non-ASCII unescaped, which it also does.
  return JSON.stringify(s);
}
