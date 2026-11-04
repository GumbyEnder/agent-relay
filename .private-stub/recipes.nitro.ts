/**
 * PUBLIC BUILD STUB — `/api/recipes*` answers 503 in an open build.
 *
 * Same reasoning as `stubs/registry.ts`: the real handler lives in the private
 * repository and is synced into `src/lib/private/recipes.nitro.ts`. The route is
 * still registered by `vite.config.ts`, so an outsider hitting it gets a plain
 * answer instead of a 404 that reads like a missing feature.
 */
export default function marketplaceDisabled() {
  return {
    ok: false,
    error: "The recipe marketplace is not enabled in this build",
    code: "marketplace_disabled",
  };
}
