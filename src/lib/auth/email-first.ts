/**
 * Email-first sign-in (Better Auth plugin) — the BeeZilla "Sign in / Register" page.
 *
 * One page, one field. The visitor types an email and presses Next:
 *   - known email with a password  → the password field appears (or they can ask
 *                                     for a sign-in link — that is "forgot password")
 *   - known email, no password     → a sign-in link is emailed
 *   - unknown email                → a sign-in link is emailed; opening it creates
 *                                     the account (Better Auth magicLink plugin)
 * After a link sign-in the page asks for a password, then opens the app.
 *
 * Endpoints (mounted under /api/auth like every Better Auth route):
 *   POST /email-first/lookup        { email }       → { exists, hasPassword }
 *   GET  /email-first/status        (signed in)     → { hasPassword, canReplace }
 *   POST /email-first/set-password  (signed in)     { newPassword } → { status, replaced }
 *
 * Forgot password, in this design, is "email me a sign-in link" followed by
 * "set a new password". The safety rules follow the OWASP Forgot Password
 * Cheat Sheet:
 *   - the link is a single-use, 15-minute token sent only to the inbox
 *     (magicLink plugin);
 *   - REPLACING a password needs a sign-in from the last 15 minutes, so a
 *     long-lived ("forever") session cookie alone can never change it;
 *   - replacing a password signs out every other device and emails a
 *     "your password was changed" notice;
 *   - lookups, sign-in and password changes are rate limited per IP.
 *
 * Trade-off, on purpose: an email-first page reveals whether an address has an
 * account (the next step differs). The lookup is rate limited to slow
 * address harvesting; the answer carries nothing beyond those two booleans.
 */
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sensitiveSessionMiddleware,
} from "better-auth/api";
import { z } from "zod";

/** A password can be replaced only within this many seconds of signing in. */
export const RECENT_SIGN_IN_SECONDS = 15 * 60;

export interface EmailFirstOptions {
  /**
   * Called after an existing password was replaced (best effort, never throws
   * to the caller). `headers` are the request's, so the notice can be branded
   * by the host the browser used.
   */
  onPasswordReplaced?: (
    user: { id: string; email: string; name?: string | null },
    headers: Headers | null,
  ) => Promise<unknown> | unknown;
}

function isRecent(createdAt: Date | string, now = Date.now()): boolean {
  const started = new Date(createdAt).getTime();
  return Number.isFinite(started) && now - started < RECENT_SIGN_IN_SECONDS * 1000;
}

export const emailFirst = (options: EmailFirstOptions = {}) =>
  ({
    id: "email-first",
    endpoints: {
      emailFirstLookup: createAuthEndpoint(
        "/email-first/lookup",
        {
          method: "POST",
          body: z.object({ email: z.string().trim().min(3).max(320) }),
        },
        async (ctx) => {
          const email = ctx.body.email.toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_EMAIL",
              message: "Enter a valid email address.",
            });
          }
          const found = await ctx.context.internalAdapter.findUserByEmail(email, {
            includeAccounts: true,
          });
          const hasPassword = Boolean(
            found?.accounts.some((a) => a.providerId === "credential" && a.password),
          );
          return ctx.json({ exists: Boolean(found), hasPassword });
        },
      ),

      emailFirstStatus: createAuthEndpoint(
        "/email-first/status",
        { method: "GET", use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          return ctx.json({
            hasPassword: Boolean(account?.password),
            canReplace: isRecent(session.createdAt),
          });
        },
      ),

      emailFirstSetPassword: createAuthEndpoint(
        "/email-first/set-password",
        {
          method: "POST",
          body: z.object({ newPassword: z.string() }),
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const { newPassword } = ctx.body;
          const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
          if (newPassword.length < minPasswordLength) {
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_SHORT",
              message: `Use at least ${minPasswordLength} characters.`,
            });
          }
          if (newPassword.length > maxPasswordLength) {
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_LONG",
              message: `Use at most ${maxPasswordLength} characters.`,
            });
          }

          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          const replacing = Boolean(account?.password);
          if (replacing && !isRecent(session.createdAt)) {
            throw new APIError("FORBIDDEN", {
              code: "SIGN_IN_AGAIN",
              message: "For your safety, sign in again with an email link before changing your password.",
            });
          }

          const hash = await ctx.context.password.hash(newPassword);
          if (!account) {
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: hash,
            });
          } else {
            await ctx.context.internalAdapter.updateAccount(account.id, { password: hash });
          }

          if (replacing) {
            // A reset usually means the old password can't be trusted: end every
            // other session, keep this one.
            const sessions = await ctx.context.internalAdapter.listSessions(user.id);
            await Promise.all(
              sessions
                .filter((s) => s.token !== session.token)
                .map((s) => ctx.context.internalAdapter.deleteSession(s.token)),
            );
            try {
              await options.onPasswordReplaced?.(
                { id: user.id, email: user.email, name: user.name },
                ctx.request?.headers ?? ctx.headers ?? null,
              );
            } catch (err) {
              ctx.context.logger.error("email-first: password-changed notice failed", err);
            }
          }

          return ctx.json({ status: true, replaced: replacing });
        },
      ),
    },
    rateLimit: [
      { pathMatcher: (path: string) => path === "/email-first/lookup", window: 60, max: 10 },
      { pathMatcher: (path: string) => path === "/email-first/set-password", window: 60, max: 5 },
    ],
  }) satisfies BetterAuthPlugin;
