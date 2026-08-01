/**
 * Nitro handler for Better Auth: /api/auth/**
 */
import { defineEventHandler } from "h3";
import { auth } from "./auth/server";

export default defineEventHandler(async (event) => {
  return auth.handler(event.req as Request);
});
