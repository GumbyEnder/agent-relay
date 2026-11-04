/**
 * PUBLIC BUILD STUB — the marketplace management plane is not in this build.
 *
 * The real module is `private/registry.ts` in github.com:GumbyEnder/beezilla-recipes,
 * copied into `src/lib/private/` by `scripts/sync-private.mjs` before the build.
 * A clone without a credential to that repository gets this stub instead, so the
 * open-source tree still typechecks and still builds — it just has no registry.
 *
 * Contract kept deliberately exact: `BundleRow` is the same shape the real row
 * carries, because `src/lib/wallet/wallet.nitro.ts` reads `manifest` off it.
 * Adding a field here that the real module does not have would make the two
 * builds diverge in a way no test would catch.
 */
export type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

export interface BundleRow {
  hash: string;
  recipe_id: string;
  version: string;
  author_id: string;
  manifest: unknown;
  bundle_ref: string;
  semantic_ref: string;
  checks_ref: string;
  status: "draft" | "published" | "revoked";
  created_at: string;
}

/** No registry in a public build: every lookup misses, nothing is ever sold. */
export async function getBundle(_q: QueryFn, _hash: string): Promise<BundleRow | null> {
  return null;
}

export async function listBundles(_q: QueryFn, _limit = 50): Promise<BundleRow[]> {
  return [];
}
