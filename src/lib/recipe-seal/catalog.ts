/**
 * Recipe catalog client — how a local install gets NEW recipes from our cloud.
 *
 * The product rule is "day-to-day runs locally; recipes are centralized". That
 * means the desktop app needs exactly one cloud call, and it must not be a trust
 * boundary it can be talked across:
 *
 *   GET  {BZ_CATALOG_URL}/catalog.json          -> a list, nothing more
 *   GET  {BZ_CATALOG_URL}{entry.url}            -> bundle bytes
 *
 * The catalog is UNTRUSTED, even though it is ours. A compromised catalog must not
 * be able to install code, so:
 *   - the entry's sha256 (when present) must match the bytes we downloaded;
 *   - the bundle must verify AND its author key must be pinned in this build;
 *   - nothing is written to the cache unless both pass.
 *
 * A catalog that lists a recipe we cannot fetch cleanly yields a refused entry,
 * never a partial install.
 */

import { createHash } from "node:crypto";
import { putRecipe, type CachedRecipe } from "./cache";
import type { TrustAnchor, TrustVerdict } from "./trust";

export interface CatalogEntry {
  id: string;
  version: string;
  title?: string;
  /** hex sha256 of the bundle bytes; verified when the catalog provides it */
  sha256?: string;
  /** path relative to the catalog base URL */
  url: string;
  keyId?: string;
}

export interface CatalogResult {
  ok: boolean;
  entries: CatalogEntry[];
  error?: string;
}

/** Hard cap on a downloaded bundle: 8 MB. A recipe is text + a small wasm check. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export function catalogBaseUrl(raw = process.env.BZ_CATALOG_URL): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  // Only http(s): a file:// catalog would let a local file masquerade as the cloud.
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`catalog URL must be http(s), got ${value.slice(0, 40)}`);
  }
  return value;
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Read the catalog listing. Never throws for a network/parse problem. */
export async function fetchCatalog(base = catalogBaseUrl(), init?: RequestInit): Promise<CatalogResult> {
  if (!base) return { ok: false, entries: [], error: "no catalog configured (set BZ_CATALOG_URL)" };
  let res: Response;
  try {
    res = await fetch(`${base}/catalog.json`, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    return { ok: false, entries: [], error: `could not reach the catalog: ${err instanceof Error ? err.message : err}` };
  }
  if (!res.ok) return { ok: false, entries: [], error: `catalog responded ${res.status}` };

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, entries: [], error: "catalog is not valid JSON" };
  }

  const list = (parsed as { recipes?: unknown })?.recipes;
  if (!Array.isArray(list)) return { ok: false, entries: [], error: "catalog has no recipes array" };

  const entries: CatalogEntry[] = [];
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    const id = asString(e.id);
    const version = asString(e.version);
    const url = asString(e.url);
    if (!id || !version || !url) continue; // a malformed row is skipped, not fatal
    entries.push({
      id,
      version,
      url,
      title: asString(e.title) || undefined,
      sha256: asString(e.sha256).toLowerCase() || undefined,
      keyId: asString(e.keyId) || undefined,
    });
  }
  return { ok: true, entries };
}

export interface DownloadResult {
  ok: boolean;
  status: number;
  bytes?: Uint8Array;
  error?: string;
}

/** Download one entry's bytes, enforcing the size cap and (when given) the digest. */
export async function downloadBundle(
  base: string,
  entry: CatalogEntry,
  init?: RequestInit,
): Promise<DownloadResult> {
  const url = entry.url.startsWith("http") ? entry.url : `${base}${entry.url.startsWith("/") ? "" : "/"}${entry.url}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { ok: false, status: 0, error: `download failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `download responded ${res.status}` };

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BUNDLE_BYTES) {
    return { ok: false, status: res.status, error: `bundle is ${Math.round(declared / 1024)} KB, over the ${MAX_BUNDLE_BYTES / 1024 / 1024} MB limit` };
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BUNDLE_BYTES) {
    return { ok: false, status: res.status, error: "bundle exceeded the size limit while downloading" };
  }
  if (buf.byteLength === 0) return { ok: false, status: res.status, error: "bundle was empty" };

  if (entry.sha256) {
    const digest = createHash("sha256").update(buf).digest("hex");
    if (digest !== entry.sha256) {
      return { ok: false, status: res.status, error: `bundle does not match the catalog digest (expected ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)` };
    }
  }
  return { ok: true, status: res.status, bytes: buf };
}

export interface InstallResult {
  ok: boolean;
  entry: CatalogEntry;
  verdict?: TrustVerdict;
  cached?: CachedRecipe;
  error?: string;
}

/**
 * Download one catalog entry and cache it — but only if it verifies AND is signed
 * by a publisher pinned in this build. Downloading is not installing.
 */
export async function installRecipe(
  dataDir: string,
  entry: CatalogEntry,
  opts: { anchors?: TrustAnchor[]; base?: string; init?: RequestInit } = {},
): Promise<InstallResult> {
  let base = opts.base;
  if (!base) {
    try {
      base = catalogBaseUrl();
    } catch (err) {
      return { ok: false, entry, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (!base) return { ok: false, entry, error: "no catalog configured (set BZ_CATALOG_URL)" };

  const dl = await downloadBundle(base, entry, opts.init);
  if (!dl.ok || !dl.bytes) return { ok: false, entry, error: dl.error ?? "download produced no bytes" };

  const put = putRecipe(dataDir, dl.bytes, opts.anchors);
  if (!put.ok) {
    return {
      ok: false,
      entry,
      verdict: put.verdict,
      error: `${put.verdict.reason}${put.verdict.detail ? `: ${put.verdict.detail}` : ""}`,
    };
  }
  return { ok: true, entry, verdict: put.verdict, cached: put.cached };
}
