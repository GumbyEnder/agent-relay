// @ts-expect-error Nitro auto-imports
import { handleAgentApiRequest } from "../../../../src/lib/agent-api.server";

export default defineEventHandler(async (event: unknown) => {
  // @ts-expect-error Nitro runtime
  const req = toWebRequest(event);
  return handleAgentApiRequest(req);
});
