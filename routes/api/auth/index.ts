import { auth } from "../../../src/lib/auth/server";

export default defineEventHandler(async (event) => {
  return auth.handler(event.req as Request);
});
