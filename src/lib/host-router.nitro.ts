/**
 * Host/product split for the two products that share this repo.
 *
 * Since stage 2 of the split (2026-11-17) there can be TWO services from this one
 * repo: the console service (everything) and the BeeZilla service (consumer
 * surface only). `BZ_SURFACE` says which one this process is:
 *
 *   all     — default, one service, hostname decides (the pre-split behaviour)
 *   buzzy   — consumer service: `/buzzy/*`, the BeeZilla APIs, auth, capability
 *             endpoints and the platform healthcheck. Console paths 404 here.
 *   console — operator service: Buzzy pages 301 to the product domain.
 *
 * The decision itself lives in `./product-surface` as a pure function so
 * `scripts/test-surface-routing.ts` can drive every case in CI. This file is only
 * the h3 adapter: read the request, ask for a decision, act on it. That split
 * exists because a routing bug lands on a page a customer is looking at, and the
 * old version could only be tested by deploying it.
 */
import { defineEventHandler, getRequestURL, sendRedirect, setResponseStatus } from "h3";
import type { H3Event } from "h3";
import { CONSUMER_ORIGIN, isConsumerHost } from "./product-hosts";
import { decideSurface, moveEnabled, surfaceFromEnv } from "./product-surface";

/** Request host without port, honouring the proxy header Railway sets. */
function requestHost(event: H3Event): string {
  const headers = event.node?.req?.headers ?? {};
  const forwarded = headers["x-forwarded-host"];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? headers.host ?? "";
  return String(raw).split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

export default defineEventHandler((event) => {
  const url = getRequestURL(event);
  const host = requestHost(event);

  const decision = decideSurface({
    surface: surfaceFromEnv(),
    host,
    pathname: url.pathname,
    method: event.node?.req?.method ?? "GET",
    search: url.search,
    moveEnabled: moveEnabled(),
    consumerOrigin: CONSUMER_ORIGIN,
    isConsumerHost: isConsumerHost(host),
  });

  if (decision.kind === "redirect") return sendRedirect(event, decision.to, decision.status);
  if (decision.kind === "deny") {
    // Loud on purpose: a console path on the consumer service is a deployment
    // mistake, and a redirect to /buzzy/talk would hide it behind a chat page.
    setResponseStatus(event, decision.status);
    return { error: "Not here", code: "wrong_surface", detail: decision.reason };
  }
  return;
});
