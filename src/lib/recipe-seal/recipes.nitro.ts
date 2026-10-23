/**
 * Nitro handler for /api/recipes/**
 *
 * Thin adapter: reads the request, resolves the operator session and the
 * capability token, and delegates to `routeRecipes` (which owns all the logic
 * and is tested without booting the app).
 */
import { defineEventHandler, getMethod, readBody, setResponseHeader, setResponseStatus } from "h3";
import { getSql } from "@/lib/db";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
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
  const user = await getSessionUserFromHeaders(headers).catch(() => null);

  const authorization = headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;

  const callerKey =
    (headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    event.node?.req?.socket?.remoteAddress ||
    "unknown";

  let body: unknown = undefined;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    body = await readBody(event).catch(() => ({}));
  }

  const deps = await getDeps();
  const result = await routeRecipes(
    { method, path, body, token, operatorId: user?.id ?? null, callerKey },
    deps,
  );

  setResponseStatus(event, result.status);
  for (const [k, v] of Object.entries(result.headers ?? {})) setResponseHeader(event, k, v);
  return result.body;
});
