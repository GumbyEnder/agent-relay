import { handleAgentApiRequest } from "../../src/lib/agent-api.server";

export default defineEventHandler(async (event) => {
  const req = toWebRequest(event);
  return handleAgentApiRequest(req);
});
