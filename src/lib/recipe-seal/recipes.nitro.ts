/**
 * Nitro handler for /api/recipes/**
 *
 * Thin adapter: reads the request, resolves the operator session and the
 * capability token, and delegates to `routeRecipes` (which owns all the logic
 * and is tested without booting the app).
 */
import { defineEventHandler, getMethod, readBody, setResponseHeader, setResponseStatus } from "h3";
import { getSql } from "@/lib/db";
import { resolveOperatorContext } from "@/lib/auth/verify.server";
import { chatCompletion } from "@/lib/buzzy/llm";
import { createRouteDeps, routeRecipes, type RouteDeps } from "./routes";
import { FsStorage } from "./storage";

let depsPromise: Promise<RouteDeps> | null = null;

function kekFromEnv(): Uint8Array | null {
  const raw = process.env.RECIPE_SEAL_KEK;
  if (!raw) return null;
  try {
    const buf = new Uint8Array(Buffer.from(raw, "base64"));
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

async function getDeps(): Promise<RouteDeps> {
  if (!depsPromise) {
    depsPromise = (async () => {
      const sql = await getSql();
      const q = <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
        sql.query<T>(text, params ?? []);
      return createRouteDeps({
        q,
        storage: new FsStorage(process.env.RECIPE_SEAL_STORAGE_DIR ?? ".data/recipe-seal"),
        // Absent KEK is a valid state: verify works, run answers 503.
        kek: kekFromEnv(),
        // Local-open mode is opt-in for these routes. humanAuthRequired() returns
        // false whenever BETTER_AUTH_URL is unset, so relying on it alone would
        // hand publish/licence to anyone if that var ever went missing.
        allowOpen: process.env.RECIPE_SEAL_ALLOW_OPEN === "1",
        // Inject the execution lane. Without this the paid `run` path answers 503
        // in production no matter what, so licensing and metering would only ever
        // be exercised by the test suite. Absent a configured chat lane the model
        // stays undefined and `run` honestly reports 503 instead of pretending.
        model: process.env.BZ_CHAT_KEY || process.env.BZ_CHAT_BASE_URL
          ? (prompt: string) => chatCompletion([{ role: "user", content: prompt }], { temperature: 0 })
          : undefined,
      });
    })();
  }
  return depsPromise;
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(","));
  }
  return headers;
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  const path = (event.path ?? "").split("?")[0];

  if (!path.startsWith("/api/recipes")) {
    setResponseStatus(event, 404);
    return { ok: false, error: "Not found", code: "not_found" };
  }

  const rawHeaders = (event.node?.req?.headers ?? {}) as Record<string, string | string[] | undefined>;
  const headers = toHeaders(rawHeaders);
  // Role, not mere presence: publish and licence issue gate on `manage_keys`.
  // Roles are durable rows (`ar_operator_roles`), not env flags. Without this the
  // context resolves to role:null for every signed-in human, so publish and licence
  // answered 403 for everyone including an admin — the routes were reachable but
  // nobody could ever enrol a recipe.
  const opCtx = await resolveOperatorContext(headers, {
    lookupDbRole: async (userId, email) => {
      const sql = await getSql();
      const rows = await sql.query<{ role: string }>(
        `select role from ar_operator_roles
          where user_id = $1 or (lower(email) = lower($2) and $2 is not null)
          limit 1`,
        [userId, email ?? null],
      );
      const role = rows[0]?.role;
      return role === "viewer" || role === "operator" || role === "admin" ? role : null;
    },
  }).catch(() => null);

  const authorization = headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;

  // Take the LAST hop: the client controls the start of x-forwarded-for, but the
  // edge proxy appends the address it actually saw. Using [0] made the 60/min
  // anti-probing limit bypassable by sending a fresh header on every request.
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const callerKey = hops.at(-1) || event.node?.req?.socket?.remoteAddress || "unknown";

  let body: unknown = undefined;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    body = await readBody(event).catch(() => ({}));
  }

  const deps = await getDeps();
  const result = await routeRecipes(
    { method, path, body, token, operatorId: opCtx?.user?.id ?? null,
      operatorRole: opCtx?.role ?? null, authRequired: opCtx?.authRequired ?? true, callerKey },
    deps,
  );

  setResponseStatus(event, result.status);
  for (const [k, v] of Object.entries(result.headers ?? {})) setResponseHeader(event, k, v);
  return result.body;
});
