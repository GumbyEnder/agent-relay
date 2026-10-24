/**
 * Recipe Seal — Step 1: the sealed container.
 *
 * A `.wasm` module (valid WebAssembly: magic + version + one custom section)
 * whose custom section carries the compiled rule program, folded with a
 * per-build keystream. There are no readable rule ids, descriptions or literals
 * in the artifact — `strings checks.wasm` returns nothing useful.
 *
 * Honest scope: this is obfuscation, not cryptography. The sealed program is
 * data for a VM that ships with the platform; the protection is that recovering
 * the predicates requires reversing the fold and decoding the program, not that
 * it is mathematically impossible. Rule *codes* (C01…) are public by design.
 */
import { createHash, randomBytes } from "node:crypto";
import type { CompiledChecks, Rule } from "./types";
import { defineRule } from "./author";

const SECTION_NAME = "rsk1";
export const ENGINE = "recipe-checks/1";

interface RuleProgram {
  v: 1;
  engine: string;
  rules: Rule[];
}

// ── keystream (xorshift32, seeded from the container salt) ────────────────────
function keystream(seedBytes: Uint8Array, length: number): Uint8Array {
  let s = 0;
  for (const b of seedBytes) s = (Math.imul(s, 31) + b) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function fold(bytes: Uint8Array, salt: Uint8Array): Uint8Array {
  const ks = keystream(salt, bytes.length);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ ks[i];
  return out;
}

// ── minimal wasm writer (magic + version + one custom section) ────────────────
function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function emitWasm(payload: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(SECTION_NAME);
  const body: number[] = [...uleb(name.length), ...name, ...payload];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    0x00,                   // custom section id
    ...uleb(body.length),
    ...body,
  ]);
}

function readWasm(bytes: Uint8Array): Uint8Array {
  const magic = [0x00, 0x61, 0x73, 0x6d];
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== magic[i]) throw new Error("not a wasm module");
  }
  let i = 8;
  if (bytes[i] !== 0x00) throw new Error("unexpected section: expected custom");
  i++;
  // ULEB128 section length
  let size = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[i++];
    size |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  let nameLen = 0;
  shift = 0;
  for (;;) {
    const b = bytes[i++];
    nameLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const name = new TextDecoder().decode(bytes.slice(i, i + nameLen));
  if (name !== SECTION_NAME) throw new Error(`unexpected section name: ${name}`);
  i += nameLen;
  return bytes.slice(i, i + size - nameLen);
}

// ── public API ────────────────────────────────────────────────────────────────
export function compile(rules: Rule[], opts: { salt?: Uint8Array } = {}): CompiledChecks {
  if (rules.length === 0) throw new Error("refusing to compile an empty rule set");
  const codes: Record<string, string> = {};
  for (const r of rules) {
    if (codes[r.code] && codes[r.code] !== r.description) {
      throw new Error(`duplicate rule code ${r.code}`);
    }
    codes[r.code] = r.description;
  }

  const program: RuleProgram = {
    v: 1,
    engine: ENGINE,
    // ids and descriptions stay in: they are needed for author-side debugging and
    // are folded on disk. They never cross the API boundary.
    rules: rules.map((r) => ({ ...r })),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(program));
  const salt = opts.salt ?? randomBytes(8);
  const payload = new Uint8Array(salt.length + encoded.length);
  payload.set(salt, 0);
  payload.set(fold(encoded, salt), salt.length);
  const wasm = emitWasm(payload);

  return {
    wasm,
    codes,
    manifest: {
      sha256: createHash("sha256").update(wasm).digest("hex"),
      rules: rules.length,
      // The MAP, not the key list: the verify tier explains a fired code from the
      // manifest alone. An array here silently produced empty descriptions.
      codes,
      engine: ENGINE,
    },
  };
}

/**
 * Structural validation of a sealed rule program.
 *
 * A compiled module can `load` and still throw the first time it evaluates: a
 * malformed expression shape (`{op:"and", args:"x"}`) passes JSON parsing and
 * then dies on `.every`. Earlier versions only regex-compiled `matches`, so such
 * a module published 201, 500'd verify, and — worse — let `run` call the model
 * before throwing, giving a licensee unlimited inference at platform cost.
 *
 * Every opcode is checked for its required fields and field types, recursively,
 * with a depth cap. An expression the VM would not understand is refused here.
 */
const SIMPLE_OPS = new Set(["truthy", "falsy", "empty", "nonempty", "canonicalUnit", "integer"]);
const NUM_CMP_OPS = new Set(["lt", "lte", "gt", "gte"]);
const EQ_OPS = new Set(["eq", "neq"]);
const STRING_OPS = new Set(["starts", "ends", "has"]);
const PATH_PAIR_OPS = new Set(["ltePath", "eqPath"]);
const COLLECTION_OPS = new Set(["allOf", "anyOf", "noneOf"]);
const MAX_DEPTH = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function requireString(e: Record<string, unknown>, key: string, path: string): string {
  const v = e[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${path}: '${key}' must be a non-empty string`);
  return v;
}

function requireArray(e: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = e[key];
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${path}: '${key}' must be a non-empty array`);
  return v;
}

function assertExpr(expr: unknown, path: string, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error(`${path}: expression nesting exceeds ${MAX_DEPTH}`);
  if (!isPlainObject(expr)) throw new Error(`${path}: expression must be an object`);
  const e = expr;
  const op = e.op;
  if (typeof op !== "string") throw new Error(`${path}: missing 'op'`);

  if (op === "and" || op === "or") {
    for (const [i, child] of requireArray(e, "args", path).entries()) assertExpr(child, `${path}.args[${i}]`, depth + 1);
    return;
  }
  if (op === "not") {
    if (!("arg" in e)) throw new Error(`${path}: 'arg' is required for not`);
    assertExpr(e.arg, `${path}.arg`, depth + 1);
    return;
  }
  if (EQ_OPS.has(op)) {
    requireString(e, "path", path);
    if (!("value" in e) || (typeof e.value === "object" && e.value !== null)) {
      throw new Error(`${path}: 'value' must be a scalar literal`);
    }
    return;
  }
  if (NUM_CMP_OPS.has(op)) {
    requireString(e, "path", path);
    if (typeof e.value !== "number" || !Number.isFinite(e.value)) throw new Error(`${path}: 'value' must be a finite number`);
    return;
  }
  if (op === "in") {
    requireString(e, "path", path);
    for (const [i, v] of requireArray(e, "values", path).entries()) {
      if (typeof v === "object" && v !== null) throw new Error(`${path}.values[${i}]: must be a scalar literal`);
    }
    return;
  }
  if (STRING_OPS.has(op)) {
    requireString(e, "path", path);
    requireString(e, "value", path);
    return;
  }
  if (SIMPLE_OPS.has(op) || op === "matches") {
    requireString(e, "path", path);
    if (op === "matches") {
      const pattern = requireString(e, "pattern", path);
      // Must be a string: the VM calls .replace on it, so a numeric flag compiled
      // fine here and threw at evaluation (found by an independent review).
      if (e.flags !== undefined && typeof e.flags !== "string") {
        throw new Error(`${path}: 'flags' must be a string`);
      }
      const flags = e.flags === undefined ? "" : e.flags;
      if (pattern.length > 500) throw new Error(`${path}: pattern longer than 500 characters`);
      new RegExp(pattern, flags.replace(/[^i]/g, ""));  // throws on a malformed pattern
    }
    return;
  }
  if (PATH_PAIR_OPS.has(op)) {
    requireString(e, "a", path);
    requireString(e, "b", path);
    return;
  }
  if (COLLECTION_OPS.has(op) || op === "countGte") {
    requireString(e, "path", path);
    if (op === "countGte" && (typeof e.n !== "number" || !Number.isInteger(e.n) || e.n < 0)) {
      throw new Error(`${path}: 'n' must be a non-negative integer`);
    }
    if (op !== "countGte") {
      if (!("check" in e)) throw new Error(`${path}: 'check' is required for ${op}`);
      assertExpr(e.check, `${path}.check`, depth + 1);
    }
    if (e.where !== undefined) assertExpr(e.where, `${path}.where`, depth + 1);
    return;
  }
  throw new Error(`${path}: unknown op '${op}'`);
}

/** Validate an entire rule set: ids, codes, severities and every expression. */
export function validateRules(rules: Rule[]): void {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error("rule program is empty");
  const codes = new Set<string>();
  for (const [i, rule] of rules.entries()) {
    const at = `rules[${i}]`;
    if (!rule || typeof rule !== "object") throw new Error(`${at}: not an object`);
    if (typeof rule.id !== "string" || rule.id.length === 0) throw new Error(`${at}: missing id`);
    if (typeof rule.code !== "string" || rule.code.length === 0) throw new Error(`${at}: missing code`);
    if (codes.has(rule.code)) throw new Error(`${at}: duplicate code '${rule.code}'`);
    codes.add(rule.code);
    if (!["block", "warn"].includes(String(rule.severity))) throw new Error(`${at}: bad severity`);
    assertExpr(rule.expr, `${at}.expr`);
  }
}

export function loadRules(wasm: Uint8Array): Rule[] {
  const payload = readWasm(wasm);
  const salt = payload.slice(0, 8);
  const folded = payload.slice(8);
  const json = new TextDecoder().decode(fold(folded, salt));
  const program = JSON.parse(json) as RuleProgram;
  if (program.v !== 1 || program.engine !== ENGINE) {
    throw new Error(`unsupported rule program: v${program.v} ${program.engine}`);
  }
  const rules = program.rules.map((r) =>
    defineRule({
      id: r.id,
      code: r.code,
      severity: r.severity,
      description: r.description,
      expr: r.expr,
    }),
  );
  // Validate here, not only at publish: the run path calls the model before it
  // evaluates, so an unvalidated program would spend inference and then throw.
  validateRules(rules);
  return rules;
}

/** Convenience: codes map from a compiled artifact (public, safe to ship). */
export function codeMap(rules: Rule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) out[r.code] = r.description;
  return out;
}
