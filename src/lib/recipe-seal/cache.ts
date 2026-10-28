/**
 * On-disk recipe cache — offline-first, and never trusted on read.
 *
 * The desktop promise is "your day does not block on a network call". Recipes
 * arrive from our cloud, land here, and keep working offline. But a file on disk
 * is just a file: anything can rewrite it. So a cache hit is re-verified against
 * the pinned publishers on every read — a cached bundle that no longer verifies
 * is deleted, not executed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyTrustedBundle, type TrustAnchor, type TrustVerdict } from "./trust";

export interface CachedRecipe {
  id: string;
  version: string;
  keyId: string;
  title: string;
  sha256: string;
  cachedAt: string;
  file: string;
}

export function cacheDir(dataDir: string): string {
  return join(dataDir, "recipes");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

/**
 * Verify + store a bundle. Refuses anything not anchored to a pinned publisher,
 * so the cache can never become a laundering path for an unpinned recipe.
 */
export function putRecipe(
  dataDir: string,
  bytes: Uint8Array,
  anchors?: TrustAnchor[],
): { ok: boolean; verdict: TrustVerdict; cached?: CachedRecipe } {
  const verdict = verifyTrustedBundle(bytes, anchors);
  if (!verdict.ok || !verdict.manifest) return { ok: false, verdict };

  const m = verdict.manifest;
  const dir = cacheDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const digest = sha256(bytes);
  const file = join(dir, `${safeName(m.id)}@${safeName(m.version)}.${digest.slice(0, 12)}.bezz`);
  writeFileSync(file, bytes);

  const entry: CachedRecipe = {
    id: m.id,
    version: m.version,
    keyId: m.author.key_id,
    title: typeof m.listing?.title === "string" ? m.listing.title : m.id,
    sha256: digest,
    cachedAt: new Date().toISOString(),
    file,
  };
  const indexPath = join(dir, "index.json");
  const index = listRecipeFiles(dir).filter((f) => f.file !== file);
  index.push(entry);
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  return { ok: true, verdict, cached: entry };
}

function listRecipeFiles(dir: string): CachedRecipe[] {
  try {
    return JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as CachedRecipe[];
  } catch {
    return [];
  }
}

/**
 * List cached recipes, re-verifying each against the pinned publishers.
 * A bundle that fails verification is removed and reported as `rejected`.
 */
export function listRecipes(
  dataDir: string,
  anchors?: TrustAnchor[],
): { valid: CachedRecipe[]; rejected: Array<{ file: string; reason: string; detail?: string }> } {
  const dir = cacheDir(dataDir);
  const valid: CachedRecipe[] = [];
  const rejected: Array<{ file: string; reason: string; detail?: string }> = [];
  if (!existsSync(dir)) return { valid, rejected };

  for (const entry of listRecipeFiles(dir)) {
    if (!existsSync(entry.file)) continue;
    const verdict = verifyTrustedBundle(readFileSync(entry.file), anchors);
    if (verdict.ok) {
      valid.push(entry);
    } else {
      rejected.push({ file: entry.file, reason: String(verdict.reason), detail: verdict.detail });
      try {
        rmSync(entry.file, { force: true });
      } catch {
        /* leave it; it is already refused */
      }
    }
  }
  return { valid, rejected };
}

/** Read a cached bundle by id (optionally version), re-verified. */
export function readRecipe(
  dataDir: string,
  id: string,
  version?: string,
  anchors?: TrustAnchor[],
): { ok: boolean; bytes?: Uint8Array; entry?: CachedRecipe; reason?: string; detail?: string } {
  const { valid, rejected } = listRecipes(dataDir, anchors);
  const match = valid.find((r) => r.id === id && (!version || r.version === version));
  if (!match) {
    const bad = rejected.find((r) => r.file.includes(safeName(id)));
    return bad
      ? { ok: false, reason: bad.reason, detail: bad.detail }
      : { ok: false, reason: "NOT_CACHED", detail: `no cached recipe ${id}${version ? `@${version}` : ""}` };
  }
  return { ok: true, bytes: readFileSync(match.file), entry: match };
}
