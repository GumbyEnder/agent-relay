/**
 * Nitro event handler wrapper for /api/agent/**
 * h3 v2: event.req is a Web Request.
 */
import { defineEventHandler } from "h3";
import { handleAgentApiRequest } from "./agent-api.server";

export default defineEventHandler(async (event) => {
  return handleAgentApiRequest(event.req as Request);
});
