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
      codes: Object.keys(codes).sort(),
      engine: ENGINE,
    },
  };
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
  return program.rules.map((r) =>
    defineRule({
      id: r.id,
      code: r.code,
      severity: r.severity,
      description: r.description,
      expr: r.expr,
    }),
  );
}

/** Convenience: codes map from a compiled artifact (public, safe to ship). */
export function codeMap(rules: Rule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) out[r.code] = r.description;
  return out;
}
