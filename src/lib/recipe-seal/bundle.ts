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
 * The only keys a manifest may carry. Without this, `verifyBundle` would happily
 * sign and serve a hand-built manifest containing prose under any invented key
 * (`guidance`, `checklist`, `firstQuestion` …). An independent review proved the
 * DB constraint alone was a naming ban and therefore bypassable.
 */
export const MANIFEST_KEYS = [
  "protocol", "id", "version", "created_at", "author", "capability", "checks",
  "semantic", "dek_wrapped", "evals", "pricing", "chain", "signature",
] as const;
export const CAPABILITY_KEYS = ["inputs", "outputs", "tools", "forbidden_tools", "boundary_summary"] as const;

/** Returns the offending keys, or an empty array when the manifest is in shape. */
export function manifestShapeErrors(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["not_an_object"];
  const m = manifest as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !(MANIFEST_KEYS as readonly string[]).includes(k));
  const errors: string[] = extra.map((k) => `unexpected_key:${k}`);
  const cap = m.capability;
  if (cap && typeof cap === "object" && !Array.isArray(cap)) {
    for (const k of Object.keys(cap as Record<string, unknown>)) {
      if (!(CAPABILITY_KEYS as readonly string[]).includes(k)) errors.push(`unexpected_capability_key:${k}`);
    }
  }
  return errors;
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
