import { handleAuthRequest } from "../../../src/lib/auth/server";

export default defineEventHandler(async (event) => {
  return handleAuthRequest(event.req as Request);
});
