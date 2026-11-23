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
 *   - the catalog itself must be https (plain http only on loopback);
 *   - every entry must carry a 64-hex sha256, and the bytes we downloaded must
 *     match it — an entry without a digest is not listed at all;
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
  /** hex sha256 of the bundle bytes — required, and verified before anything is cached */
  sha256: string;
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

/** A digest the catalog can be held to: exactly 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Loopback exempts only the machine the catalog is already running on.
 *
 * A plain-http catalog is a free man-in-the-middle: whoever can rewrite the
 * listing chooses which bundle bytes the install verifies. https is the
 * transport rule for anything off this host; loopback stays http so tests and a
 * local staging catalog need no certificate.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Reject a URL that is not https, unless it is plain http to loopback. */
function assertTransport(kind: "catalog" | "bundle", raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${kind} URL is not absolute: ${raw.slice(0, 60)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${kind} URL must be http(s), got ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${kind} URL must be https — plain http is only allowed for a loopback host, got ${parsed.host}`);
  }
  return parsed;
}

export function catalogBaseUrl(raw = process.env.BZ_CATALOG_URL): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  // A file:// catalog would let a local file masquerade as the cloud, and plain
  // http lets anyone on the path decide what "the catalog" says.
  assertTransport("catalog", value);
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
    const sha256 = asString(e.sha256).toLowerCase();
    // A row with no digest is not installable: without it the bytes we receive
    // are whatever the network handed us, and the seal would be the only check.
    // The catalog is the untrusted half of this pair, so it does not get to omit
    // the half that binds it. Skipped like any other malformed row.
    if (!id || !version || !url || !SHA256_HEX.test(sha256)) continue;
    entries.push({
      id,
      version,
      url,
      title: asString(e.title) || undefined,
      sha256,
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

/** Download one entry's bytes, enforcing the transport rule, the size cap and the digest. */
export async function downloadBundle(
  base: string,
  entry: CatalogEntry,
  init?: RequestInit,
): Promise<DownloadResult> {
  // No digest, no download. `fetchCatalog` already drops such rows; this covers
  // an entry handed to us directly (the local API accepts an id and resolves it
  // from the listing, but a caller can also construct one).
  if (!SHA256_HEX.test(entry.sha256 ?? "")) {
    return { ok: false, status: 0, error: "catalog entry carries no sha256 digest — refusing to download an unbound bundle" };
  }
  const rawUrl = /^https?:\/\//i.test(entry.url) ? entry.url : `${base}${entry.url.startsWith("/") ? "" : "/"}${entry.url}`;
  let url: string;
  try {
    url = assertTransport("bundle", rawUrl).toString();
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
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

  // The entry was refused above unless this digest was a well-formed sha256, so
  // the comparison is unconditional — there is no "verify only if advertised".
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== entry.sha256) {
    return { ok: false, status: res.status, error: `bundle does not match the catalog digest (expected ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)` };
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
