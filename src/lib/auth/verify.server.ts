import { getRequest } from "@tanstack/react-start/server";
import { auth, authConfigured } from "./server";
import {
  gateCapability,
  resolveOperatorRoleFromEnv,
  type OperatorCapability,
  type OperatorRole,
} from "./roles";

/**
 * Server-side session resolution (server-only).
 *
 * Because this app runs its OWN Better Auth at same-origin `/api/auth/*`, the
 * session cookie is sent with every request to this app — server functions AND
 * SSR loaders included. So we resolve the user straight from the request cookies
 * via `auth.api.getSession` (no client-minted JWT needed). Never trust a
 * client-supplied user id — only the result of this verification.
 */

/** True when a real database is configured server-side. */
const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());

/** Re-export so callers can branch on it without importing `server.ts`. */
export { authConfigured };

/**
 * When true, operator writes require a human session + role.
 * Override with AGENT_RELAY_HUMAN_AUTH=0|1.
 *
 * Default: on only for a real deploy-style setup (`BETTER_AUTH_URL` set and auth
 * not disabled). The template always has preview broker client ids, so
 * `authConfigured` alone must NOT lock local Postgres demos.
 */
export function humanAuthRequired(
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {},
): boolean {
  const flag = env.AGENT_RELAY_HUMAN_AUTH?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  if (env.VITE_AUTH_ENABLED === "false") return false;
  const hasPublicAuthUrl = Boolean(env.BETTER_AUTH_URL?.trim());
  return hasPublicAuthUrl && authConfigured;
}

if (databaseConfigured && !authConfigured) {
  console.error(
    "[auth] DATABASE_URL is set but auth is disabled (VITE_AUTH_ENABLED=false) " +
      "— requireUserId() will reject every request (fail closed) rather than " +
      "share one dev user on a real database.",
  );
}

/** Dev fallback user id, used only when auth is disabled (VITE_AUTH_ENABLED=false). */
export const DEV_USER_ID = "dev-user";

/**
 * Thrown by `requireUserId` when the caller has no valid session. Carries
 * `status: 401`; the message is a stable contract — match
 * `err.message === "Unauthorized"` client-side to send the visitor to sign-in.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export type VerifiedUser = { id: string; email: string | null };

/**
 * Resolve session user from arbitrary request headers (agent API / Nitro path).
 * Does not depend on TanStack `getRequest()`.
 */
export async function getSessionUserFromHeaders(
  headers: Headers,
): Promise<VerifiedUser | null> {
  if (!authConfigured) return null;
  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return null;
    return { id: session.user.id, email: session.user.email ?? null };
  } catch {
    return null;
  }
}

/**
 * Resolve the signed-in user from the current request, or `null` when auth isn't
 * configured / nobody is signed in. Safe to call from server functions and SSR
 * loaders.
 *
 * `bearerToken` is for the LIVE PREVIEW: the app runs in a partitioned iframe
 * whose cookies don't reach the server, so `authMiddleware` forwards the session
 * as a bearer token, which we present as `Authorization: Bearer …` (the `bearer`
 * plugin resolves it). When deployed no token is passed and the cookie is used.
 */
export async function getSessionUser(
  bearerToken?: string,
): Promise<VerifiedUser | null> {
  if (!authConfigured) return null;
  const request = getRequest();
  if (!request) return null;
  let headers = request.headers;
  if (bearerToken) {
    headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  return getSessionUserFromHeaders(headers);
}

/**
 * Resolve the current user id for a server function, or throw when unauthorized.
 * Prefer `authMiddleware` (`./middleware`), which calls this for you.
 * - Auth enabled (default) -> the verified session user id; throws
 *   `UnauthorizedError` when signed out. Works in the sandbox preview too (real
 *   sign-in via the baked preview client).
 * - Auth disabled (`VITE_AUTH_ENABLED=false`) + `DATABASE_URL` set -> throw (fail
 *   closed): one shared dev user on a real database would let every visitor
 *   read/write everyone's rows.
 * - Auth disabled + no database -> the shared dev user id.
 */
export async function requireUserId(bearerToken?: string): Promise<string> {
  if (!authConfigured) {
    if (databaseConfigured) {
      throw new Error(
        "Auth is disabled (VITE_AUTH_ENABLED=false) but DATABASE_URL is set — " +
          "refusing to fall back to the shared dev user against a real database.",
      );
    }
    return DEV_USER_ID;
  }
  const user = await getSessionUser(bearerToken);
  if (!user) throw new UnauthorizedError();
  return user.id;
}

export type OperatorContext = {
  user: VerifiedUser | null;
  role: OperatorRole | null;
  authRequired: boolean;
};

/**
 * Build operator context for a request. Optional `lookupDbRole` injects durable roles.
 * Agents with Bearer API keys should not call this path for machine verbs.
 */
export async function resolveOperatorContext(
  headers: Headers,
  opts: {
    lookupDbRole?: (userId: string, email: string | null) => Promise<OperatorRole | null>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<OperatorContext> {
  const env = opts.env ?? process.env;
  const authRequired = humanAuthRequired(env);
  if (!authRequired) {
    return { user: { id: DEV_USER_ID, email: "dev@example.com" }, role: "admin", authRequired: false };
  }
  const user = await getSessionUserFromHeaders(headers);
  if (!user) return { user: null, role: null, authRequired: true };
  let dbRole: OperatorRole | null = null;
  if (opts.lookupDbRole) {
    try {
      dbRole = await opts.lookupDbRole(user.id, user.email);
    } catch {
      dbRole = null;
    }
  }
  const role = resolveOperatorRoleFromEnv(user, dbRole, env);
  return { user, role, authRequired: true };
}

/**
 * Gate a human capability. Returns null when allowed, or an error payload.
 */
export function checkOperatorCapability(
  ctx: OperatorContext,
  cap: OperatorCapability,
): { ok: true; role: OperatorRole } | { ok: false; status: 401 | 403; error: string; code: string } {
  const g = gateCapability(ctx.role, cap, { authRequired: ctx.authRequired });
  if (g.ok && g.role) return { ok: true, role: g.role };
  if (g.reason === "signed_out") {
    return { ok: false, status: 401, error: "Sign in required", code: "signed_out" };
  }
  return {
    ok: false,
    status: 403,
    error: `Role '${ctx.role ?? "none"}' cannot ${cap}`,
    code: "forbidden",
  };
}
