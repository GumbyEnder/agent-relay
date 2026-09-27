/**
 * Brand configuration — BeeZilla skin is opt-in via BZ_BRAND env var.
 *
 * Runtime-only by design (NOT build-time baked): Railway Docker builds don't
 * receive service variables at build time, so baking `import.meta.env` produced
 * identical client bundles for both deployments. Instead:
 *  - Server: `process.env.BZ_BRAND` is read during SSR; __root renders
 *    `<html data-brand="beezilla">` when set.
 *  - Client: the flag is read from the rendered DOM attribute, so client
 *    components agree with the server without any build-time plumbing.
 */
function serverFlag(): boolean {
  try {
    return process.env.BZ_BRAND === "beezilla";
  } catch {
    return false;
  }
}

function clientFlag(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.brand === "beezilla";
}

export const BZ_BRAND: boolean =
  typeof process !== "undefined" && typeof window === "undefined"
    ? serverFlag()
    : clientFlag();
