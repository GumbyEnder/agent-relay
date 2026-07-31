/**
 * Nitro production handler for /api/agent/** (Vercel / node deploy).
 * Dev uses the Vite middleware in vite.config.ts instead.
 */
// @ts-expect-error Nitro auto-imports defineEventHandler / toWebRequest
import { handleAgentApiRequest } from "../../../../src/lib/agent-api.server";

export default defineEventHandler(async (event: unknown) => {
  // @ts-expect-error Nitro runtime
  const req = toWebRequest(event);
  return handleAgentApiRequest(req);
});
