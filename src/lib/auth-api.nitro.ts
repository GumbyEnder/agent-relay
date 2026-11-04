/**
 * Nitro handler for Better Auth: /api/auth/**
 *
 * Local (desktop/CLI) installs have no better-auth session — no cookie, no
 * sign-in. But the pages decide "am I signed in?" by calling
 * `/api/auth/get-session`, which bypasses our own session chokepoint. Without
 * this branch a desktop window renders, decides nobody is signed in, and
 * bounces to the landing page on every launch.
 *
 * So the same Host + per-launch-token gate answers the UI's own question, in
 * better-auth's response shape. Everything else still goes to better-auth.
 */
import { defineEventHandler } from "h3";
import { handleAuthRequest } from "./auth/server";
import { isLocalRuntime } from "./runtime";
import { resolveLocalRequester } from "./local-owner";

export default defineEventHandler(async (event) => {
  if (isLocalRuntime()) {
    const rawUrl = event.req.url ?? "/";
    const path = new URL(rawUrl, "http://127.0.0.1").pathname.replace(/\/+$/, "");
    if (path === "/api/auth/get-session" || path.endsWith("/get-session")) {
      const headers = new Headers(event.req.headers as unknown as Record<string, string>);
      const user = await resolveLocalRequester(headers);
      if (!user) return null;
      const now = new Date();
      return {
        session: {
          id: "local-session",
          userId: user.id,
          token: "local",
          expiresAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          ipAddress: "127.0.0.1",
          userAgent: "BeeZilla desktop",
        },
        user: {
          id: user.id,
          email: user.email,
          name: user.name || "Owner",
          emailVerified: true,
          image: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      };
    }
  }
  return handleAuthRequest(event.req as Request);
});
