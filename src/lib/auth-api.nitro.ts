/**
 * Nitro handler for Better Auth: /api/auth/**
 */
import { defineEventHandler } from "h3";
import { handleAuthRequest } from "./auth/server";

export default defineEventHandler(async (event) => {
  return handleAuthRequest(event.req as Request);
});
