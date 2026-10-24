/**
 * Recipe Seal — Step 2: the `.srb` bundle.
 *
 * A bundle is a deterministic zip of three entries:
 *   manifest.json   — public: capability, codes, evals, pricing, hashes
 *   semantic.enc    — the prose half, AES-256-GCM under a per-bundle DEK
 *   checks.wasm     — the sealed evaluator from Step 1
 *
 * Identity is `sha256(JCS(manifest without signature))`. The author signs that
 * digest with Ed25519; the DEK is wrapped under a KEK so the platform (or a TEE
 * runtime) can unwrap it without ever persisting plaintext.
 *
 * Honest scope note: the semantic blob is protected at rest and in transit. It is
 * NOT protected from the process that decrypts it — that is what Step 3 and the
 * server-side-only execution rule are for.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, randomBytes, sign, verify, type KeyObject,
} from "node:crypto";
import { canonicalise } from "./jcs";
import { makeZip, readZip } from "./zip";

export const PROTOCOL = "recipe-seal/1";
const AAD_DEK = "recipe-seal/dek/1";

export interface Capability {
  inputs: { name: string; type: string; required: boolean }[];
  outputs: string[];
  tools: string[];
  forbidden_tools: string[];
  boundary_summary: string;
}

export interface RecipeManifest {
  protocol: typeof PROTOCOL;
  id: string;
  version: string;
  created_at: string;
  author: { id: string; name: string; key_id: string; public_key: string };
  capability: Capability;
  checks: {
    module: "checks.wasm";
    sha256: string;
    rules: number;
    codes: Record<string, string>;
    engine: string;
  };
  semantic: { blob: "semantic.enc"; sha256: string; alg: "AES-256-GCM"; nonce: string; aad: string };
  dek_wrapped: string;
  // Integers only: a signed document cannot contain floats without inviting
  // canonicalisation disputes. Money is cents; rates are basis points.
  evals: { corpus_sha256: string | null; cases: number; pass_rate_bp: number | null };
  pricing: { unit: "run"; amount_cents: number; quota_default: number | null; split_bp: Record<string, number> };
  chain: { hash_algo: "sha256"; commitment: string | null };
  signature?: string;
}

/**
 * Structural manifest schema. An allow-list of *keys* was not enough: a review
 * showed `capability` could be an array or a string of prose, `pricing` could be
 * prose, and `capability.inputs[].description` could carry anything, all of which
 * verified "successfully". Types and unknown keys are validated at every level.
 */
type Spec =
  | { t: "string" } | { t: "int" } | { t: "boolean" }
  | { t: "nullable-string" } | { t: "nullable-int" }
  | { t: "string[]" } | { t: "string-map" } | { t: "int-map" }
  | { t: "object"; keys: Record<string, Spec>; optional?: string[] }
  | { t: "array"; of: Spec };

const MANIFEST_SPEC: Spec = {
  t: "object",
  optional: ["signature"],
  keys: {
    protocol: { t: "string" }, id: { t: "string" }, version: { t: "string" },
    created_at: { t: "string" },
    author: { t: "object", keys: {
      id: { t: "string" }, name: { t: "string" }, key_id: { t: "string" }, public_key: { t: "string" } } },
    capability: { t: "object", keys: {
      inputs: { t: "array", of: { t: "object", keys: {
        name: { t: "string" }, type: { t: "string" }, required: { t: "boolean" } } } },
      outputs: { t: "string[]" },
      tools: { t: "string[]" },
      forbidden_tools: { t: "string[]" },
      boundary_summary: { t: "string" } } },
    checks: { t: "object", keys: {
      module: { t: "string" }, sha256: { t: "string" }, rules: { t: "int" },
      codes: { t: "string-map" }, engine: { t: "string" } } },
    semantic: { t: "object", keys: {
      blob: { t: "string" }, sha256: { t: "string" }, alg: { t: "string" },
      nonce: { t: "string" }, aad: { t: "string" } } },
    dek_wrapped: { t: "string" },
    evals: { t: "object", keys: {
      corpus_sha256: { t: "nullable-string" }, cases: { t: "int" },
      pass_rate_bp: { t: "nullable-int" } } },
    pricing: { t: "object", keys: {
      unit: { t: "string" }, amount_cents: { t: "int" },
      quota_default: { t: "nullable-int" }, split_bp: { t: "int-map" } } },
    chain: { t: "object", keys: {
      hash_algo: { t: "string" }, commitment: { t: "nullable-string" } } },
    signature: { t: "string" },
  },
};

/** Top-level manifest keys, derived from the spec (the DB constraint mirrors it). */
export const MANIFEST_KEYS = Object.keys((MANIFEST_SPEC as { keys: Record<string, Spec> }).keys);

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkSpec(value: unknown, spec: Spec, path: string, errors: string[]): void {
  const bad = (why: string) => { errors.push(`${path || "<root>"}:${why}`); };
  switch (spec.t) {
    case "string": if (typeof value !== "string") bad("not_a_string"); return;
    case "int": if (!Number.isSafeInteger(value)) bad("not_an_integer"); return;
    case "boolean": if (typeof value !== "boolean") bad("not_a_boolean"); return;
    case "nullable-string":
      if (value !== null && typeof value !== "string") bad("not_a_string_or_null"); return;
    case "nullable-int":
      if (value !== null && !Number.isSafeInteger(value)) bad("not_an_integer_or_null"); return;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) bad("not_a_string_array");
      return;
    case "string-map":
      if (!plainObject(value) || Object.values(value).some((v) => typeof v !== "string")) bad("not_a_string_map");
      return;
    case "int-map":
      if (!plainObject(value) || Object.values(value).some((v) => !Number.isSafeInteger(v))) bad("not_an_int_map");
      return;
    case "array":
      if (!Array.isArray(value)) { bad("not_an_array"); return; }
      value.forEach((v, i) => checkSpec(v, spec.of, `${path}[${i}]`, errors));
      return;
    case "object": {
      if (!plainObject(value)) { bad("not_an_object"); return; }
      const allowed = new Set(Object.keys(spec.keys));
      const optional = new Set(spec.optional ?? []);
      for (const k of Object.keys(value)) {
        if (!allowed.has(k)) errors.push(`${path ? `${path}.` : ""}${k}:unexpected_key`);
      }
      for (const [k, sub] of Object.entries(spec.keys)) {
        if (!(k in value)) {
          if (!optional.has(k)) errors.push(`${path ? `${path}.` : ""}${k}:missing`);
          continue;
        }
        checkSpec(value[k], sub, path ? `${path}.${k}` : k, errors);
      }
      return;
    }
  }
}

/** Returns the offending paths, or an empty array when the manifest is in shape. */
export function manifestShapeErrors(manifest: unknown): string[] {
  const errors: string[] = [];
  checkSpec(manifest, MANIFEST_SPEC, "", errors);
  return errors;
}

/**
 * The producer-side leak gate.
 *
 * A manifest is *published* — served to anyone who asks. If any of its strings
 * reproduces the sealed prose, the product's central promise is broken, so this
 * runs at seal time AND again at publish time (the two places a manifest is
 * produced). Field exclusions are deliberately absent: a review showed a manifest
 * could hide the boundary inside `checks.codes.C99`, or split it across two
 * fields, and still be served verbatim.
 */
const SEAL_LEAK_N = 4;

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function ngrams(text: string, n: number): Set<string> {
  const t = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

/**
 * Returns the manifest paths that reproduce the sealed text.
 *
 * Two passes: per-string (so the report names the field) and a concatenated blob
 * (so a secret split across two fields is still caught).
 */
export function semanticLeakInManifest(manifest: unknown, semantic: unknown): string[] {
  const semanticStrings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") { semanticStrings.push(v); return; }
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (plainObject(v)) { for (const val of Object.values(v)) collect(val); }
  };
  collect(semantic);
  const guarded = new Set<string>();
  for (const str of semanticStrings) for (const g of ngrams(str, SEAL_LEAK_N)) guarded.add(g);
  if (guarded.size === 0) return [];

  const hits: string[] = [];
  const strings: Array<[string, string]> = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      strings.push([path, value]);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (plainObject(value)) { for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k); }
  };
  walk(manifest, "");

  for (const [path, value] of strings) {
    const t = tokens(value);
    for (let i = 0; i + SEAL_LEAK_N <= t.length; i++) {
      if (guarded.has(t.slice(i, i + SEAL_LEAK_N).join(" "))) { hits.push(path); break; }
    }
  }
  // Cross-field: the secret may be split so no single string contains the run.
  const blob = strings.map(([, v]) => v).join(" ");
  const bt = tokens(blob);
  for (let i = 0; i + SEAL_LEAK_N <= bt.length; i++) {
    if (guarded.has(bt.slice(i, i + SEAL_LEAK_N).join(" "))) { hits.push("<concatenated>"); break; }
  }
  return hits;
}

/**
 * Value/shape rules the structural spec cannot express: an empty id, a negative
 * price or a code with no description makes a manifest publishable but unusable.
 */
export function manifestValueErrors(m: unknown): string[] {
  const errors: string[] = [];
  if (!plainObject(m)) return errors;
  const man = m as Partial<RecipeManifest>;
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!nonEmpty(man.id)) errors.push("id:empty");
  if (!nonEmpty(man.version)) errors.push("version:empty");
  if (typeof man.id === "string" && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(man.id)) errors.push("id:charset");
  if (typeof man.version === "string" && !/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$/.test(man.version)) errors.push("version:charset");
  const pricing = man.pricing;
  if (pricing) {
    if (!Number.isSafeInteger(pricing.amount_cents) || pricing.amount_cents < 0 || pricing.amount_cents > 100_000_000) {
      errors.push("pricing.amount_cents:range");
    }
    if (pricing.quota_default !== null && (!Number.isSafeInteger(pricing.quota_default) || pricing.quota_default < 0)) {
      errors.push("pricing.quota_default:range");
    }
    if (pricing.split_bp) {
      for (const [k, v] of Object.entries(pricing.split_bp)) {
        if (!Number.isSafeInteger(v) || v < 0 || v > 10_000) errors.push(`pricing.split_bp.${k}:range`);
      }
    }
  }
  const codes = man.checks?.codes;
  if (codes) {
    for (const [k, v] of Object.entries(codes)) {
      if (!k.trim()) errors.push("checks.codes:empty_key");
      if (!nonEmpty(v)) errors.push(`checks.codes.${k}:empty`);
    }
  }
  if (man.checks && (!Number.isSafeInteger(man.checks.rules) || man.checks.rules < 0)) errors.push("checks.rules:range");
  return errors;
}

/**
 * Everything publish must check about a manifest before it is served. One call so
 * no caller can pick a subset.
 */
export function manifestPublishErrors(manifest: unknown, semantic: unknown): string[] {
  return [...manifestShapeErrors(manifest), ...manifestValueErrors(manifest),
    ...semanticLeakInManifest(manifest, semantic).map((p) => `leaks_sealed_text:${p}`)];
}

export const BUNDLE_REASONS = [
  "NOT_ZIP", "MISSING_ENTRY", "NO_CHECKS", "MANIFEST_SCHEMA", "UNSUPPORTED_PROTOCOL",
  "BAD_SIGNATURE", "HASH_MISMATCH_CHECKS", "HASH_MISMATCH_SEMANTIC",
  "DEK_UNWRAP_FAILED", "SEMANTIC_AAD_MISMATCH", "SEMANTIC_DECRYPT_FAILED",
] as const;
export type BundleReason = (typeof BUNDLE_REASONS)[number];

export interface BundleParts {
  manifest: RecipeManifest;
  semanticEnc: Uint8Array;
  checksWasm: Uint8Array;
}

export interface SealInput {
  recipeId: string;
  version: string;
  semantic: unknown;
  checksWasm: Uint8Array;
  checks: { sha256: string; rules: number; codes: Record<string, string>; engine: string };
  capability: Capability;
  author: { id: string; name: string; keyId: string; privateKey: KeyObject };
  kek: Uint8Array;
  evals?: { corpus_sha256?: string | null; cases?: number; pass_rate_bp?: number | null };
  pricing?: { amount_cents?: number; quota_default?: number | null; split_bp?: Record<string, number> };
  createdAt?: string;
  /** test-only determinism hooks */
  dek?: Uint8Array;
  nonce?: Uint8Array;
  dekNonce?: Uint8Array;
}

// ── primitives ────────────────────────────────────────────────────────────────
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function aeadSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from(nonce), ct, cipher.getAuthTag()]);
}

function aeadOpen(key: Uint8Array, payload: Uint8Array, aad: string): Uint8Array {
  if (payload.length < 12 + 16) throw new Error("aead_truncated");
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const ct = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Ed25519 keypair for tests and the CLI. */
export function generateAuthorKey(): { privateKey: KeyObject; publicKeyRaw: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { privateKey, publicKeyRaw: raw, keyId: `ed25519:${sha256Hex(raw).slice(0, 8)}` };
}

export function authorPublicKeyB64(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

/** Stable AAD: known before the blob is sealed, independent of the blob itself. */
function semanticAad(manifest: RecipeManifest): string {
  return `${manifest.protocol}|${manifest.id}|${manifest.version}|${manifest.checks.sha256}`;
}

function digestOf(manifest: RecipeManifest): string {
  const { signature: _sig, ...unsigned } = manifest;
  return sha256Hex(canonicalise(unsigned));
}

// ── seal ──────────────────────────────────────────────────────────────────────
export function sealBundle(input: SealInput): { bytes: Uint8Array; manifest: RecipeManifest; digest: string } {
  if (!input.checksWasm || input.checksWasm.length === 0) {
    throw new Error("NO_CHECKS: refusing to seal a recipe without a checks module");
  }
  const checksSha = sha256Hex(input.checksWasm);
  if (input.checks.sha256 && input.checks.sha256 !== checksSha) {
    throw new Error("checks manifest hash does not match the module bytes");
  }
  if (input.kek.length !== 32) throw new Error("KEK must be 32 bytes");

  const dek = input.dek ?? randomBytes(32);
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes");
  const nonce = input.nonce ?? randomBytes(12);
  const dekNonce = input.dekNonce ?? randomBytes(12);

  const manifest: RecipeManifest = {
    protocol: PROTOCOL,
    id: input.recipeId,
    version: input.version,
    created_at: input.createdAt ?? new Date().toISOString(),
    author: {
      id: input.author.id,
      name: input.author.name,
      key_id: input.author.keyId,
      public_key: authorPublicKeyB64(input.author.privateKey),
    },
    capability: input.capability,
    checks: {
      module: "checks.wasm",
      sha256: checksSha,
      rules: input.checks.rules,
      codes: input.checks.codes,
      engine: input.checks.engine,
    },
    semantic: { blob: "semantic.enc", sha256: "", alg: "AES-256-GCM", nonce: "", aad: "manifest-digest" },
    dek_wrapped: "",
    evals: {
      corpus_sha256: input.evals?.corpus_sha256 ?? null,
      cases: input.evals?.cases ?? 0,
      pass_rate_bp: input.evals?.pass_rate_bp ?? null,
    },
    pricing: {
      unit: "run",
      amount_cents: input.pricing?.amount_cents ?? 0,
      quota_default: input.pricing?.quota_default ?? 500,
      split_bp: input.pricing?.split_bp ?? { author: 7000, platform: 3000 },
    },
    chain: { hash_algo: "sha256", commitment: null },
  };

  // The AAD binds the blob to (protocol, id, version, checks) — all known before
  // the blob is sealed, so there is no digest/blob circularity. The signature
  // then covers the manifest that carries the blob's hash.
  const aad = semanticAad(manifest);
  const semanticBytes = new TextEncoder().encode(JSON.stringify(input.semantic));
  const semanticEnc = new Uint8Array(aeadSeal(dek, nonce, semanticBytes, aad));
  manifest.semantic.sha256 = sha256Hex(semanticEnc);
  manifest.semantic.nonce = Buffer.from(nonce).toString("base64");
  manifest.dek_wrapped = Buffer.from(aeadSeal(input.kek, dekNonce, dek, AAD_DEK)).toString("base64");

  // Producer gate #1: refuse to seal a manifest that carries the prose it seals,
  // or that is structurally unusable (negative price, empty id, empty code).
  const sealErrors = manifestPublishErrors(manifest, input.semantic);
  if (sealErrors.length > 0) {
    throw new Error(`INVALID_MANIFEST: ${sealErrors.join(",")} — this manifest cannot be published`);
  }

  const digest = digestOf(manifest);
  manifest.signature = sign(null, Buffer.from(digest, "hex"), input.author.privateKey).toString("base64");

  const bytes = makeZip([
    { name: "checks.wasm", data: input.checksWasm },
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    { name: "semantic.enc", data: semanticEnc },
  ]);

  return { bytes, manifest, digest };
}

// ── verify / open ─────────────────────────────────────────────────────────────
export interface VerifyResult {
  ok: boolean;
  reason?: BundleReason;
  detail?: string;
  manifest?: RecipeManifest;
  digest?: string;
}

export function verifyBundle(bytes: Uint8Array): VerifyResult {
  try {
    let entries: Map<string, Uint8Array>;
    try {
      entries = readZip(bytes);
    } catch (err) {
      return { ok: false, reason: "NOT_ZIP", detail: String(err instanceof Error ? err.message : err) };
    }
    const manifestRaw = entries.get("manifest.json");
    const semantic = entries.get("semantic.enc");
    const checks = entries.get("checks.wasm");
    if (!manifestRaw || !semantic) return { ok: false, reason: "MISSING_ENTRY" };
    if (!checks || checks.length === 0) return { ok: false, reason: "NO_CHECKS" };

    let manifest: RecipeManifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as RecipeManifest;
    } catch {
      return { ok: false, reason: "MANIFEST_SCHEMA" };
    }
    if (manifest.protocol !== PROTOCOL) return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
    if (!manifest.signature) return { ok: false, reason: "MANIFEST_SCHEMA", detail: "missing signature" };
    // Structural allow-list: a self-signed manifest is only trustworthy if it is
    // also in shape, otherwise "verified" just means "self-consistent" and a
    // publisher could smuggle prose in under an invented key.
    const shapeErrors = manifestShapeErrors(manifest);
    if (shapeErrors.length > 0) {
      return { ok: false, reason: "MANIFEST_SCHEMA", detail: shapeErrors.join(",") };
    }

    const digest = digestOf(manifest);
    const publicKey = createPublicKey({
      key: Buffer.from(manifest.author.public_key, "base64"),
      format: "der",
      type: "spki",
    });
    const sigOk = verify(null, Buffer.from(digest, "hex"), publicKey,
      Buffer.from(manifest.signature, "base64"));
    if (!sigOk) return { ok: false, reason: "BAD_SIGNATURE", manifest, digest };

    if (sha256Hex(checks) !== manifest.checks.sha256) {
      return { ok: false, reason: "HASH_MISMATCH_CHECKS", manifest, digest };
    }
    if (sha256Hex(semantic) !== manifest.semantic.sha256) {
      return { ok: false, reason: "HASH_MISMATCH_SEMANTIC", manifest, digest };
    }
    return { ok: true, manifest, digest };
  } catch (err) {
    // Never throw at a caller that is verifying untrusted bytes: a manifest
    // missing author.public_key used to raise ERR_INVALID_ARG_TYPE out of
    // verifyBundle and BRI the request to a 500.
    return { ok: false, reason: "MANIFEST_SCHEMA",
      detail: err instanceof Error ? err.message : String(err) };
  }
}

export function partsOf(bytes: Uint8Array): BundleParts | null {
  try {
    const entries = readZip(bytes);
    const manifestRaw = entries.get("manifest.json");
    const semanticEnc = entries.get("semantic.enc");
    const checksWasm = entries.get("checks.wasm");
    if (!manifestRaw || !semanticEnc || !checksWasm) return null;
    return {
      manifest: JSON.parse(new TextDecoder().decode(manifestRaw)) as RecipeManifest,
      semanticEnc,
      checksWasm,
    };
  } catch {
    return null;
  }
}

/** Unwrap the DEK and decrypt the semantic half. Callers must never persist the result. */
export function openSemantic(
  parts: BundleParts,
  kek: Uint8Array,
): { ok: true; semantic: unknown } | { ok: false; reason: BundleReason; detail?: string } {
  let dek: Uint8Array;
  try {
    dek = new Uint8Array(aeadOpen(kek, Buffer.from(parts.manifest.dek_wrapped, "base64"), AAD_DEK));
  } catch (err) {
    return { ok: false, reason: "DEK_UNWRAP_FAILED", detail: String(err instanceof Error ? err.message : err) };
  }
  // AAD is recomputed from the manifest: a blob lifted from another bundle fails.
  const aad = semanticAad(parts.manifest);
  try {
    const plain = aeadOpen(dek, parts.semanticEnc, aad);
    return { ok: true, semantic: JSON.parse(new TextDecoder().decode(plain)) };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    return { ok: false, reason: msg.includes("unable to authenticate") ? "SEMANTIC_AAD_MISMATCH" : "SEMANTIC_DECRYPT_FAILED", detail: msg };
  }
}

/** Manifest only — never touches the semantic blob. */
export function inspectBundle(bytes: Uint8Array): RecipeManifest | null {
  return partsOf(bytes)?.manifest ?? null;
}
