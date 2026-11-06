/**
 * Which hostname is which product.
 *
 * One deployment serves two products, so the hostname — not the build — decides
 * what a visitor is looking at. This module is deliberately dependency-free
 * (no h3, no React) so the Nitro middleware, the auth config and any server
 * helper can all agree on the answer.
 */

/** Where the consumer product lives when we send console traffic to it. */
export const CONSUMER_ORIGIN = "https://beezilla.net";

/** Hosts that present the consumer (BeeZilla) product. */
const DEFAULT_CONSUMER_HOSTS = ["beezilla.net", "www.beezilla.net"];

/** Consumer hosts, overridable with `BZ_CONSUMER_HOSTS=a,b` (tests, cutover). */
export function consumerHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.BZ_CONSUMER_HOSTS ?? "").trim();
  if (!raw) return DEFAULT_CONSUMER_HOSTS;
  const list = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_CONSUMER_HOSTS;
}

/** True when this hostname serves the BeeZilla product. Port is ignored. */
export function isConsumerHost(host: string | null | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h) return false;
  return consumerHosts().includes(h);
}
