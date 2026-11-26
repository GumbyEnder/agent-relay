/**
 * Recipe trust anchors — the difference between "signed" and "signed by us".
 *
 * `verifyBundle()` proves a bundle is internally consistent and signed by the
 * key it carries. That is not trust: an attacker can seal their own recipe with
 * their own key and it verifies perfectly. A client that fetches recipes from
 * our cloud must additionally require the signing key to be one **we shipped**.
 *
 * Pins come from the release (and are overridable for staging via
 * `BZ_RECIPE_PUBLISHER_KEYS`). An empty pin list refuses everything — a build
 * with no anchors has no business executing recipes from the network, and
 * failing open there is how "verified" becomes meaningless.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyBundle, type RecipeManifest } from "./bundle";

export interface TrustAnchor {
  keyId: string;
  /** base64 SPKI public key, exactly as it appears in `manifest.author.public_key`. */
  publicKey: string;
  label?: string;
}

export interface TrustVerdict {
  ok: boolean;
  trusted: boolean;
  /** `BundleReason` when the bundle itself is bad, or a trust reason. */
  reason?: string;
  detail?: string;
  manifest?: RecipeManifest;
  /** Which anchor vouched for this bundle. */
  anchor?: string;
}

const TRUST_REASONS = ["NO_TRUST_ANCHOR", "UNPINNED_PUBLISHER"] as const;
export type TrustReason = (typeof TRUST_REASONS)[number];

/**
 * Parse `BZ_RECIPE_PUBLISHER_KEYS`, formatted as
 * `keyId:base64[,keyId:base64]`, or a bare comma list of base64 keys.
 *
 * Split on the LAST colon: a keyId is itself colon-bearing (`ed25519:042d5ca3`),
 * while base64 never contains one — splitting on the first colon silently
 * produced a pin whose "key" was half a keyId and half a key, which then
 * rejected every real bundle.
 */
export function trustAnchorsFromEnv(raw = process.env.BZ_RECIPE_PUBLISHER_KEYS): TrustAnchor[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  const anchors: TrustAnchor[] = [];
  for (const part of value.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const sep = item.lastIndexOf(":");
    if (sep > 0 && sep < item.length - 1) {
      anchors.push({ keyId: item.slice(0, sep), publicKey: item.slice(sep + 1) });
    } else {
      anchors.push({ keyId: `ed25519:${item.slice(0, 8)}`, publicKey: item });
    }
  }
  return anchors;
}

/**
 * Pins shipped with the build, as a file next to the app
 * (`publishers.json` → `{ "publishers": [{ keyId, publicKey }] }`).
 *
 * Loaded at call time from, in order: `BZ_RECIPE_PUBLISHER_FILE`, the working
 * directory (the app root the launcher runs from), then one level up (a repo
 * checkout). The release pipeline replaces this file with the production key
 * set, so a shipped installer cannot silently trust nothing.
 */
export function loadPinFile(filePath: string): TrustAnchor[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { publishers?: unknown };
    if (!Array.isArray(parsed.publishers)) return [];
    const anchors: TrustAnchor[] = [];
    for (const entry of parsed.publishers) {
      const e = entry as { keyId?: unknown; publicKey?: unknown; label?: unknown };
      const publicKey = typeof e.publicKey === "string" ? e.publicKey.trim() : "";
      if (!publicKey) continue;
      anchors.push({
        keyId: typeof e.keyId === "string" && e.keyId ? e.keyId : `ed25519:${publicKey.slice(0, 8)}`,
        publicKey,
        label: typeof e.label === "string" ? e.label : undefined,
      });
    }
    return anchors;
  } catch {
    return [];
  }
}

/**
 * Effective pins: explicit env (dev/staging) wins, then the shipped pin file.
 * Returning [] is a valid answer — it means "this build trusts nothing", which
 * `verifyTrustedBundle` refuses out loud rather than failing open.
 */
export function defaultAnchors(): TrustAnchor[] {
  const fromEnv = trustAnchorsFromEnv();
  if (fromEnv.length > 0) return fromEnv;

  const explicit = (process.env.BZ_RECIPE_PUBLISHER_FILE ?? "").trim();
  const candidates = explicit
    ? [explicit]
    : [join(process.cwd(), "publishers.json"), join(process.cwd(), "..", "publishers.json")];

  for (const file of candidates) {
    if (existsSync(file)) {
      const anchors = loadPinFile(file);
      if (anchors.length > 0) return anchors;
    }
  }
  return [];
}

/** Normalise base64 so whitespace or a trailing newline cannot defeat an exact match. */
function sameKey(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * Verify a bundle AND anchor it to a pinned publisher.
 *
 * Order matters: the bundle's own integrity is checked first, so a tampered or
 * malformed archive reports *that* rather than the less useful "unpinned".
 */
export function verifyTrustedBundle(
  bytes: Uint8Array,
  anchors: TrustAnchor[] = defaultAnchors(),
): TrustVerdict {
  const base = verifyBundle(bytes);
  if (!base.ok) {
    return {
      ok: false,
      trusted: false,
      reason: base.reason,
      detail: base.detail,
      manifest: base.manifest,
    };
  }

  if (anchors.length === 0) {
    return {
      ok: false,
      trusted: false,
      reason: "NO_TRUST_ANCHOR",
      detail:
        "this build ships no publisher keys, so no fetched recipe can be trusted (set BZ_RECIPE_PUBLISHER_KEYS or ship a pin file with the release)",
      manifest: base.manifest,
    };
  }

  const author = base.manifest?.author;
  if (!author?.public_key) {
    return {
      ok: false,
      trusted: false,
      reason: "UNPINNED_PUBLISHER",
      detail: "manifest carries no author key",
      manifest: base.manifest,
    };
  }

  const anchor = anchors.find((a) => sameKey(a.publicKey, author.public_key));
  if (!anchor) {
    return {
      ok: false,
      trusted: false,
      reason: "UNPINNED_PUBLISHER",
      detail: `signed by ${author.key_id ?? "an unknown key"}, which is not pinned in this build`,
      manifest: base.manifest,
    };
  }

  return {
    ok: true,
    trusted: true,
    manifest: base.manifest,
    anchor: anchor.keyId,
  };
}
