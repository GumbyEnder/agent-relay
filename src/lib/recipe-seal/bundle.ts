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
  /**
   * What a shopper sees. Everything here is published in clear, so it is the one
   * part of the manifest an author writes *about* the recipe rather than *of* it.
   * The leak gate makes no exception for it: prose copied from the sealed half is
   * refused here exactly as it is anywhere else.
   */
  listing: {
    title: string;
    description: string;
    updated_at: string;
    /** The shelf price. 0 means free; there is no half-free. */
    price_honey_drops: number;
  };
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
    listing: { t: "object", keys: {
      title: { t: "string" }, description: { t: "string" },
      updated_at: { t: "string" }, price_honey_drops: { t: "int" } } },
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
/**
 * The closed vocabulary for the manifest's descriptor fields.
 *
 * These are the ONLY values a manifest may declare as an output or a tool.
 *
 * Why closed: the leak gate has to allow a manifest to share words with the sealed
 * prose, because a recipe describes what it produces and the manifest declares the
 * same thing. The first attempt allowed any string the manifest carried — and that
 * certified itself: a publisher could copy 32 characters of sealed prose into
 * `capability.outputs` and the gate would excuse every window inside it, publish
 * 201 and serve the prose. An exemption may only ever come from vocabulary fixed
 * in code, never from the document under judgement.
 *
 * Consequence, stated plainly: adding a new output kind or tool is a code change.
 * That is a deliberate cost, paid so the no-plaintext claim can be made at all.
 */
export const OUTPUT_VOCAB: readonly string[] = [
  "comparison-table", "recommendation", "missing-terms-section",
  "document", "spreadsheet", "presentation", "summary", "checklist", "letter",
];

export const TOOL_VOCAB: readonly string[] = [
  "calculate", "calculator", "search_knowledge", "lookup_market_rate", "fetch_website",
  "render_document", "render_presentation", "render_sheet",
  "send", "email", "submit", "file", "publish", "pay", "sign", "wire", "transfer",
];

const DESCRIPTOR_VOCAB: ReadonlySet<string> = new Set(
  [...OUTPUT_VOCAB, ...TOOL_VOCAB].map((v) => v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")),
);

/** A short window of the fixed vocabulary — the only text a manifest may share. */
const VOCAB_WINDOWS: readonly string[] = [...DESCRIPTOR_VOCAB].filter(Boolean);

function capabilityVocabErrors(m: unknown): string[] {
  const errors: string[] = [];
  if (!plainObject(m)) return errors;
  const cap = (m as Record<string, unknown>).capability;
  if (!plainObject(cap)) return errors;
  const allowed = new Set([...OUTPUT_VOCAB, ...TOOL_VOCAB]);
  for (const field of ["outputs", "tools", "forbidden_tools"]) {
    const v = cap[field];
    if (!Array.isArray(v)) continue;
    for (const e of v) {
      if (typeof e !== "string") continue;
      if (!allowed.has(e)) errors.push(`capability.${field}:not_in_vocabulary`);
    }
  }
  return errors;
}

export function manifestShapeErrors(manifest: unknown): string[] {
  const errors: string[] = [];
  checkSpec(manifest, MANIFEST_SPEC, "", errors);
  errors.push(...capabilityVocabErrors(manifest));
  errors.push(...listingShapeErrors(manifest));
  return errors;
}

/**
 * The shopfront. These are limits, not opinions: a title that never ends is a
 * denial-of-service on every list view, and a negative price is a transfer of
 * Honey Drops *to* the buyer. The description is capped because it is free text
 * that ships in clear to every shopper, and an unbounded field in a published
 * document is a place to hide a recipe one paragraph at a time.
 */
const LISTING_TITLE_MAX = 120;
const LISTING_DESCRIPTION_MAX = 600;

function listingShapeErrors(manifest: unknown): string[] {
  const out: string[] = [];
  if (!plainObject(manifest)) return out;
  const l = manifest.listing;
  if (!plainObject(l)) { out.push("listing:missing"); return out; }
  const title = l.title, desc = l.description, price = l.price_honey_drops, upd = l.updated_at;
  if (typeof title !== "string" || title.trim().length === 0) out.push("listing.title:empty");
  else if (title.length > LISTING_TITLE_MAX) out.push("listing.title:too_long");
  if (typeof desc !== "string") out.push("listing.description:not_a_string");
  else if (desc.length > LISTING_DESCRIPTION_MAX) out.push("listing.description:too_long");
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0) {
    out.push("listing.price_honey_drops:invalid");
  }
  if (typeof upd !== "string" || Number.isNaN(Date.parse(upd))) out.push("listing.updated_at:not_a_date");
  return out;
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
import { foldConfusables } from "./confusables";

const SEAL_LEAK_N = 4;

/**
 * Script-agnostic word tokens.
 *
 * This used to be `split(/[^a-z0-9]+/)`, which silently dropped every non-ASCII
 * letter: a sealed half written in Cyrillic, Greek or Arabic tokenised to `[]`,
 * so the guard set was empty and the prose published and served verbatim. The
 * guard must tokenise whatever text exists, not only English.
 */
function tokens(s: string): string[] {
  // Confusables fold first: homoglyph substitution is an identity trick, and every
  // pass downstream should see the character the reader sees.
  return foldConfusables(s.normalize("NFKC").toLowerCase()).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Character window for the script-agnostic pass. Chinese/Japanese text has no
 * word boundaries, so a "word" is the whole sentence and no 4-gram survives.
 * Comparing normalised character windows catches exact reproduction in any
 * script without depending on a tokenizer agreeing about what a word is.
 */
const SEAL_LEAK_CHARS = 10;

/**
 * Logographic scripts carry far more information per character: six Chinese
 * characters are roughly a clause, while ten Latin characters are barely a word
 * and a half. Using one floor for both either under-protects CJK (an eight
 * character clause slipped through a ten character window) or floods Latin
 * manifests with false positives (an eight character floor refused the honest
 * fixture). The floor varies by script; the SCOPE does not — every string is
 * compared, whatever the script.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

function windowFor(s: string): number {
  return CJK.test(s) ? 6 : SEAL_LEAK_CHARS;
}

/** NFKC, lowercase, letters and digits only — spaces and punctuation removed. */
function normalizeForCompare(s: string): string {
  return foldConfusables(s.normalize("NFKC").toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Every key name in the manifest schema. This is the structural vocabulary the
 * manifest is REQUIRED to contain ("capability", "boundary_summary", "split_bp"),
 * so a sealed half sharing one of these words is not a leak. Derived from the
 * spec rather than from the manifest, because checks.codes keys are author-chosen
 * and must never be welcomed in.
 */
const SCHEMA_KEY_NAMES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  const walk = (spec: Spec | undefined): void => {
    if (!spec || spec.t !== "object") return;
    for (const [k, v] of Object.entries(spec.keys)) {
      out.add(normalizeForCompare(k));
      walk(v as Spec);
      if ((v as { t?: string }).t === "array") walk((v as { of: Spec }).of);
    }
  };
  walk(MANIFEST_SPEC);
  return out;
})();

const STOPWORDS = new Set([
  "the", "and", "or", "a", "an", "is", "are", "to", "of", "in", "for", "with", "no", "not",
  "that", "it", "you", "your", "be", "by", "as", "at", "on", "from", "this", "these", "those",
  "if", "then", "than", "but", "so", "we", "they", "he", "she", "i", "my", "its", "into",
  "does", "did", "do", "has", "have", "was", "were", "will", "would", "can", "could", "should",
]);

/** Distinct words that carry meaning, for order-independent comparison. */
function contentTokens(text: string): string[] {
  return tokens(text).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function ngrams(text: string, n: number): Set<string> {
  const t = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

/**
 * Every string in the sealed half that must never appear in a served manifest.
 *
 * Object KEYS are included. The sealed payload is attacker/author-shaped JSON, and
 * a boundary can live in a key exactly as easily as in a value:
 * `{"Never invents a price or a payment term": "placeholder"}` walks to a
 * values-only collector as ["placeholder"], so the boundary never entered the
 * guard set and a manifest reproducing it published cleanly. Found by an
 * independent review (round 8) — keys were fixed on the MANIFEST side in round 7
 * and missed on the SEMANTIC side.
 */
/**
 * Split the sealed half into VALUES and KEYS.
 *
 * They are kept apart on purpose. Round 12 showed that interleaving keys into the
 * value text both inflated the guard (a short value plus its field name looked
 * searchable when neither part could match) and — worse — made the comparison run
 * per field, so prose stored ONE WORD PER FIELD produced no window and no 4-gram
 * and published verbatim. Values are therefore concatenated into one text and
 * judged as a document; keys are judged individually.
 */
function collectParts(semantic: unknown): { values: string[]; keys: string[] } {
  const values: string[] = [];
  const keys: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string" || v instanceof String) {
      const str = String(v);
      if (str.trim()) values.push(str);
      return;
    }
    if (Array.isArray(v)) {
      // A boundary stored as a word array is one phrase, not four short values.
      const joined = v.map((x) => String(x)).join(" ");
      if (joined.trim()) values.push(joined);
      v.forEach(collect);
      return;
    }
    if (plainObject(v)) {
      for (const [k, val] of Object.entries(v)) {
        if (k.trim()) keys.push(k);
        collect(val);
      }
    }
  };
  collect(semantic);
  return { values, keys };
}

export function guardMaterial(semantic: unknown): {
  strings: string[];
  text: string;
  values: string[];
  keys: string[];
  searchable: boolean;
} {
  const { values, keys } = collectParts(semantic);
  // The sealed half as ONE document. Word-per-field storage becomes a sentence
  // again the moment the values are joined, which is the whole point.
  const text = values.join(" ");
  // Searchable = the comparison can actually see something: a 4-word run in the
  // joined values, or one value/key long enough to window.
  const searchable =
    tokens(text).length >= SEAL_LEAK_N ||
    values.some((v) => normalizeForCompare(v).length >= windowFor(v)) ||
    keys.some((k) => normalizeForCompare(k).length >= windowFor(k));
  return { strings: [...values, ...keys], text, values, keys, searchable };
}

export function semanticLeakInManifest(manifest: unknown, semantic: unknown): string[] {
  const material = guardMaterial(semantic);
  // Fail CLOSED. Nothing to compare means the no-plaintext promise cannot be
  // evaluated, so it must not read as "clean".
  if (material.strings.length === 0) return ["<no_sealed_text>"];
  if (!material.searchable) return ["<unsearchable_sealed_text>"];

  const hits: string[] = [];

  // ── The manifest, as (path, text) pairs plus its whole de-spaced text ───────
  const entries: Array<[string, string]> = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") { entries.push([path || "<root>", value]); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (plainObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        const child = path ? `${path}.${k}` : k;
        // Object KEYS are attacker-chosen in checks.codes and pricing.split_bp.
        entries.push([`${child}<key>`, k]);
        walk(v, child);
      }
    }
  };
  walk(manifest, "");

  // The whole manifest as one text. Comparing a sealed window against this is
  // correct: the manifest IS one document, so a run crossing two of its own
  // fields is still contiguous text a reader sees. (The mistake in earlier rounds
  // was splicing the SEALED fields together, which is what collided with ordinary
  // vocabulary and refused the honest fixture.)
  const manifestText = entries.map(([, v]) => v).join(" ");
  const manifestNorm = normalizeForCompare(manifestText);
  const manifestTokens = tokens(manifestText);
  // Values only, for the cross-field word run: a key sitting between two values
  // ("K1 no vat due K2 now on friday") breaks contiguity that a reader of the
  // served JSON still experiences as one sentence.
  const manifestValueTokens = tokens(
    entries.filter(([path]) => !path.endsWith("<key>")).map(([, v]) => v).join(" "),
  );

  // Vocabulary terms the SEALED half carries as token-aligned runs may appear in
  // the manifest: that text is a public identifier, not prose.
  const sealedRunNormsForVocab = new Set<string>();
  {
    const st = tokens(material.text);
    for (let i = 0; i < st.length; i++) {
      let acc = "";
      for (let j = i; j < st.length && j < i + 4; j++) { acc += st[j]; sealedRunNormsForVocab.add(acc); }
    }
    for (const k of material.keys) {
      const kt = tokens(k);
      if (kt.length) sealedRunNormsForVocab.add(kt.join(""));
    }
  }
  const excusedForVocab = (normValue: string): boolean =>
    VOCAB_WINDOWS.some((v) => sealedRunNormsForVocab.has(v) && (normValue === v || normValue.startsWith(v) || normValue.endsWith(v)));

  // ── Sealed side ────────────────────────────────────────────────────────────
  // Values are joined into one document UNCONDITIONALLY. No predicate decides
  // whether the sealed half counts as "a document": rounds 12 and 13 each found
  // that such a switch was itself the hole (one word per field; then two
  // multi-token values). Token-aligned matching makes the join safe.
  const sealedTokens = tokens(material.text);
  const sealedGrams = new Set<string>();
  for (let i = 0; i + SEAL_LEAK_N <= sealedTokens.length; i++) {
    sealedGrams.add(sealedTokens.slice(i, i + SEAL_LEAK_N).join(" "));
  }
  for (const key of material.keys) {
    const kt = tokens(key);
    for (let i = 0; i + SEAL_LEAK_N <= kt.length; i++) sealedGrams.add(kt.slice(i, i + SEAL_LEAK_N).join(" "));
  }

  // 1. Word-run inside one manifest field — names the field.
  if (sealedGrams.size > 0) {
    for (const [path, text] of entries) {
      const mt = tokens(text);
      for (let i = 0; i + SEAL_LEAK_N <= mt.length; i++) {
        if (sealedGrams.has(mt.slice(i, i + SEAL_LEAK_N).join(" "))) { hits.push(path); break; }
      }
      if (hits.length > 0) break;
    }
  }

  // 2. Word-run across manifest fields — a clause split over two of them.
  if (!hits.includes("<concatenated>") && sealedGrams.size > 0) {
    for (let i = 0; i + SEAL_LEAK_N <= manifestValueTokens.length; i++) {
      if (sealedGrams.has(manifestValueTokens.slice(i, i + SEAL_LEAK_N).join(" "))) { hits.push("<concatenated>"); break; }
    }
  }

  // 3. Order-independent: a bag of content words survives chunking and reversal.
  const manifestBag = new Set<string>();
  for (const t of manifestTokens) if (!SCHEMA_KEY_NAMES.has(t)) manifestBag.add(t);

  const covers = (text: string): boolean => {
    let content = [...new Set(contentTokens(text))];
    if (content.length < 3) {
      const fallback = [...new Set(tokens(text).filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
      if (fallback.length < 2) return false;
      content = fallback;
    }
    if (content.length === 0) return false;
    const threshold = content.length >= 5 ? 0.7 : 1;
    const present = content.filter((t) => manifestBag.has(t)).length;
    return present / content.length >= threshold;
  };

  if (!hits.includes("<vocabulary>")) {
    for (const s of material.values) {
      if (contentTokens(s).length < 3) continue;
      // A value that IS a declared output/tool descriptor shares words with the
      // manifest by design. Without this, sealing outputContract ["comparison
      // table"] against outputs ["comparison-table"] was refused.
      if (excusedForVocab(normalizeForCompare(s))) continue;
      if (covers(s)) { hits.push("<vocabulary>"); break; }
    }
  }
  if (!hits.includes("<vocabulary>") &&
      !excusedForVocab(normalizeForCompare(material.text)) &&
      covers(material.text)) hits.push("<vocabulary>");

  // 4. Inside a single word, per sealed field. Catches scripts with no word
  // boundaries (a CJK sentence is one token, so passes 1-3 see nothing).
  // A vocabulary term is excused only when the sealed half carries it as a
  // token-aligned run. Plain containment let a sealed "xxrecommendationxx" excuse
  // the full public word and publish 14 characters of sealed text; requiring the
  // term to appear as its own run ("comparison table" counts, "xx…xx" does not)
  // keeps the honest fixture working without that hole.
  const sealedRunNorms = new Set<string>();
  for (let i = 0; i < sealedTokens.length; i++) {
    let acc = "";
    for (let j = i; j < sealedTokens.length && j < i + 4; j++) {
      acc += sealedTokens[j];
      sealedRunNorms.add(acc);
    }
  }
  for (const key of material.keys) {
    const kt = tokens(key);
    if (kt.length) sealedRunNorms.add(kt.join(""));
  }
  const excused = (w: string): boolean =>
    SCHEMA_KEY_NAMES.has(w) ||
    VOCAB_WINDOWS.some((v) => v.includes(w) && sealedRunNorms.has(v));

  const windowScan = (doc: string, label: string): boolean => {
    const g = normalizeForCompare(doc);
    const width = windowFor(doc);
    if (g.length < width) return false;
    for (let i = 0; i + width <= g.length; i++) {
      const w = g.slice(i, i + width);
      if (excused(w)) continue;
      if (manifestNorm.includes(w)) { hits.push(label); return true; }
    }
    return false;
  };

  if (!hits.includes("<normalized>")) {
    for (const v of material.values) if (windowScan(v, "<normalized>")) break;
  }
  if (!hits.includes("<key>")) {
    for (const k of material.keys) if (windowScan(k, "<key>")) break;
  }

  // 5. A whole sealed field with its spacing removed. Round 13's reviewer showed
  // that "no vat due" and a manifest carrying "novatdueno" sailed through: the
  // comparison aligns on word boundaries, and removing the spaces dissolves them.
  // Only WHOLE fields are tested here, never windows — comparing de-spaced
  // fragments is what spliced one sealed field onto the next and refused the
  // honest fixture. A whole field is a unit the author actually wrote.
  if (hits.length === 0) {
    for (const v of material.values) {
      if (tokens(v).length < 2) continue;
      const g = normalizeForCompare(v);
      if (g.length < windowFor(v)) continue;
      if (excused(g)) continue;
      if (manifestNorm.includes(g)) { hits.push("<despaced>"); break; }
    }
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
      let total = 0;
      for (const [k, v] of Object.entries(pricing.split_bp)) {
        if (!Number.isSafeInteger(v) || v < 0 || v > 10_000) errors.push(`pricing.split_bp.${k}:range`);
        else total += v;
      }
      // Over-allocating made splitCost pay a negative platform share.
      if (total > 10_000) errors.push("pricing.split_bp:over_allocated");
    }
  }
  const codes = man.checks?.codes;
  if (codes) {
    for (const [k, v] of Object.entries(codes)) {
      if (!k.trim()) errors.push("checks.codes:empty_key");
      if (!nonEmpty(v)) errors.push(`checks.codes.${k}:empty`);
    }
  }
  if (man.checks) {
    if (!Number.isSafeInteger(man.checks.rules) || man.checks.rules < 1) errors.push("checks.rules:range");
    else if (codes && man.checks.rules < Object.keys(codes).length) errors.push("checks.rules:below_code_count");
  }
  return errors;
}

/**
 * Everything publish must check about a manifest before it is served. One call so
 * no caller can pick a subset.
 */
export function manifestPublishErrors(manifest: unknown, semantic: unknown): string[] {
  const errs = [...manifestShapeErrors(manifest), ...manifestValueErrors(manifest)];
  // Fail closed on the guard's OWN input, not on string presence. A payload with
  // no text has nothing to leak; a payload whose text cannot produce a single
  // 4-gram or character window cannot be proven absent, and that is a refusal.
  const material = guardMaterial(semantic);
  if (material.strings.length === 0) {
    return [...errs, "semantic_payload:empty"];
  }
  if (!material.searchable) {
    return [...errs, "semantic_payload:unsearchable"];
  }
  return [...errs, ...semanticLeakInManifest(manifest, semantic).map((p) => `leaks_sealed_text:${p}`)];
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
  /** Shopfront metadata. Optional so existing callers keep working; a recipe with
   *  no listing is simply not shelf-ready, which `manifestShapeErrors` says plainly. */
  listing?: { title: string; description?: string; updatedAt?: string; priceHoneyDrops?: number };
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
    listing: {
      title: (input.listing?.title ?? input.recipeId).trim(),
      description: (input.listing?.description ?? "").trim(),
      updated_at: input.listing?.updatedAt ?? input.createdAt ?? new Date().toISOString(),
      price_honey_drops: input.listing?.priceHoneyDrops ?? 0,
    },
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
