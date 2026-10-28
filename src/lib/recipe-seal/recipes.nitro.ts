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
import { generateAuthorKey, partsOf, sealBundle, verifyBundle } from "./bundle";
import { publishBundle } from "./registry";
import { bundleKey, checksKey, semanticKey } from "./storage";
import { compileRecipeChecks } from "@/lib/recipe-checks";
import { RECIPES } from "@/lib/buzzy/recipes";
import { isLocalRuntime, localDataDir } from "@/lib/runtime";
import { catalogBaseUrl, fetchCatalog, installRecipe } from "@/lib/recipe-seal/catalog";
import { resolveLocalRequester } from "@/lib/local-owner";
import { defaultAnchors, verifyTrustedBundle } from "./trust";
import { listRecipes, putRecipe } from "./cache";

let depsPromise: Promise<RouteDeps> | null = null;
let authorKeyCache: ReturnType<typeof generateAuthorKey> | null = null;

/**
 * The key hosted uploads are signed with. One per process: a user's recipes are
 * attributable by `author.id`, and the signature attests the platform sealed them.
 * A per-user key would have to be stored, and storing customers' signing keys is a
 * liability we are not taking on to make an upload form work.
 */
function platformAuthorKey() {
  authorKeyCache ??= generateAuthorKey();
  return authorKeyCache;
}

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

  // ── Local (desktop/CLI) recipe cache ──────────────────────────────────────────
  //
  // Local installs keep recipes in a filesystem cache, not the cloud registry, so
  // these three paths never touch the DB. Every bundle is verified against the
  // build's pinned publishers before it is stored OR served — the cache is not a
  // laundering path for an unpinned recipe.
  if (isLocalRuntime() && path.startsWith("/api/recipes/local")) {
    const user = await resolveLocalRequester(headers).catch(() => null);
    if (!user) {
      setResponseStatus(event, 401);
      return { ok: false, error: "Unauthorized", code: "unauthorized" };
    }
    const dataDir = localDataDir();
    const anchors = defaultAnchors();

    // POST body carries the bundle as base64 (a ZIP cannot ride in JSON otherwise).
    let body: unknown = undefined;
    if (method === "POST") body = await readBody(event).catch(() => ({}));

    if (path === "/api/recipes/local" && method === "GET") {
      const listed = listRecipes(dataDir, anchors);
      setResponseStatus(event, 200);
      return { ok: true, pins: anchors.length, ...listed };
    }

    if (path === "/api/recipes/local" && method === "POST") {
      const b64 = typeof (body as { bundle?: unknown })?.bundle === "string"
        ? ((body as { bundle: string }).bundle)
        : "";
      if (!b64) {
        setResponseStatus(event, 400);
        return { ok: false, error: "body.bundle (base64) is required", code: "bad_request" };
      }
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const result = putRecipe(dataDir, bytes, anchors);
      setResponseStatus(event, result.ok ? 201 : 422);
      return {
        ok: result.ok,
        reason: result.verdict.reason,
        detail: result.verdict.detail,
        anchor: result.verdict.anchor,
        cached: result.cached
          ? { id: result.cached.id, version: result.cached.version, title: result.cached.title, sha256: result.cached.sha256 }
          : undefined,
      };
    }

    // The catalog is the only cloud call a local install makes. Listing is
    // read-only; fetching installs ONLY after the bundle verifies against a pinned
    // publisher, so a compromised catalog cannot install code.
    if (path === "/api/recipes/local/catalog" && method === "GET") {
      let base = "";
      try {
        base = catalogBaseUrl();
      } catch (err) {
        setResponseStatus(event, 200);
        return { ok: false, configured: false, entries: [], error: err instanceof Error ? err.message : String(err) };
      }
      if (!base) {
        setResponseStatus(event, 200);
        return { ok: false, configured: false, entries: [], error: "no catalog configured (set BZ_CATALOG_URL)" };
      }
      const result = await fetchCatalog(base);
      setResponseStatus(event, 200);
      return { ok: result.ok, configured: true, catalog: base, entries: result.entries, error: result.error };
    }

    if (path === "/api/recipes/local/fetch" && method === "POST") {
      const id = typeof (body as { id?: unknown })?.id === "string" ? (body as { id: string }).id.trim() : "";
      if (!id) {
        setResponseStatus(event, 400);
        return { ok: false, error: "body.id is required", code: "bad_request" };
      }
      let base = "";
      try {
        base = catalogBaseUrl();
      } catch (err) {
        setResponseStatus(event, 400);
        return { ok: false, error: err instanceof Error ? err.message : String(err), code: "bad_catalog" };
      }
      const listing = await fetchCatalog(base);
      if (!listing.ok) {
        setResponseStatus(event, 502);
        return { ok: false, error: listing.error, code: "catalog_unreachable" };
      }
      const entry = listing.entries.find((e) => e.id === id);
      if (!entry) {
        setResponseStatus(event, 404);
        return { ok: false, error: `no recipe '${id}' in the catalog`, code: "not_found" };
      }
      const installed = await installRecipe(dataDir, entry, { anchors, base });
      setResponseStatus(event, installed.ok ? 201 : 422);
      return {
        ok: installed.ok,
        reason: installed.verdict?.reason,
        detail: installed.verdict?.detail,
        error: installed.error,
        entry: { id: entry.id, version: entry.version, title: entry.title },
        cached: installed.cached
          ? { id: installed.cached.id, version: installed.cached.version, title: installed.cached.title, sha256: installed.cached.sha256 }
          : undefined,
      };
    }

    if (path === "/api/recipes/local/verify" && method === "POST") {
      const b64 = typeof (body as { bundle?: unknown })?.bundle === "string"
        ? ((body as { bundle: string }).bundle)
        : "";
      if (!b64) {
        setResponseStatus(event, 400);
        return { ok: false, error: "body.bundle (base64) is required", code: "bad_request" };
      }
      const verdict = verifyTrustedBundle(new Uint8Array(Buffer.from(b64, "base64")), anchors);
      setResponseStatus(event, 200);
      return {
        ok: verdict.ok,
        trusted: verdict.trusted,
        reason: verdict.reason,
        detail: verdict.detail,
        anchor: verdict.anchor,
        recipe: verdict.manifest
          ? { id: verdict.manifest.id, version: verdict.manifest.version, title: verdict.manifest.listing?.title }
          : undefined,
      };
    }

    setResponseStatus(event, 404);
    return { ok: false, error: "Not found", code: "not_found" };
  }
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

  // ── POST /api/recipes/upload — a person publishes their own recipe ─────────
  //
  // Everything else on this route is operator-only because it enrols a *bundle
  // someone else signed*. This is the one path a normal account may take: they
  // describe the recipe, the server seals it, and they are recorded as the author
  // and therefore the seller.
  //
  // The signing key is the platform's, not theirs. That is a real, stated trade:
  // hosted uploads are custodially signed, ownership is by author id, and the
  // recipe stays encrypted under the server KEK. A bring-your-own-key upload would
  // keep even us out — that is a separate feature, not a checkbox here.
  if (path === "/api/recipes/upload" && method === "POST") {
    const user = opCtx?.user ?? null;
    if (!user) { setResponseStatus(event, 401); return { ok: false, error: "Sign in first", code: "signed_out" }; }

    const deps = await getDeps();
    if (!deps.kek) { setResponseStatus(event, 503); return { ok: false, error: "Publishing is not configured", code: "publish_unavailable" }; }

    const b = (body ?? {}) as Record<string, unknown>;
    const basis = typeof b.basis === "string" ? b.basis : "";
    const template = RECIPES.find((r) => r.id === basis);
    if (!template) {
      setResponseStatus(event, 400);
      return { ok: false, error: "Pick which kind of recipe this is", code: "unknown_basis" };
    }
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const description = typeof b.description === "string" ? b.description.trim() : "";
    const price = Number(b.priceHoneyDrops ?? 0);
    if (title.length < 3) { setResponseStatus(event, 400); return { ok: false, error: "Give it a title", code: "title_required" }; }
    if (!Number.isSafeInteger(price) || price < 0 || price > 100000) {
      setResponseStatus(event, 400);
      return { ok: false, error: "Price must be a whole number of Honey Drops", code: "invalid_price" };
    }

    const semantic = {
      discovery: template.discovery,
      boundary: template.boundary,
      checklist: template.checklist,
      outputContract: template.outputContract,
    };
    const compiled = compileRecipeChecks(template.id, { salt: new Uint8Array(8) });
    const authorKey = platformAuthorKey();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recipe";
    const recipeId = `user.${user.id.slice(0, 8)}.${slug}`;

    let sealed;
    try {
      sealed = sealBundle({
        recipeId,
        version: "1.0.0",
        semantic,
        checksWasm: compiled.wasm,
        checks: compiled.manifest,
        capability: {
          inputs: [{ name: "sources", type: "file[]", required: true }],
          outputs: ["document"],
          tools: ["render_document"],
          forbidden_tools: ["send", "submit"],
          boundary_summary: "read-only; nothing is sent",
        },
        author: { id: user.id, name: user.email || "BeeZilla user", keyId: authorKey.keyId, privateKey: authorKey.privateKey },
        kek: deps.kek,
        listing: { title, description, priceHoneyDrops: price },
        pricing: { amount_cents: 0 },
      });
    } catch (e) {
      // The leak gate lives here too: an upload whose copy reproduces its own
      // sealed half is refused before it can be stored or served.
      setResponseStatus(event, 422);
      return { ok: false, error: String((e as Error).message).slice(0, 300), code: "refused" };
    }

    const verified = verifyBundle(sealed.bytes);
    if (!verified.ok || !verified.manifest) {
      setResponseStatus(event, 400);
      return { ok: false, error: "The sealed bundle did not verify", code: "bad_bundle" };
    }
    const parts = partsOf(sealed.bytes)!;
    try {
      await deps.storage.put(bundleKey(verified.digest!), sealed.bytes);
      await deps.storage.put(semanticKey(verified.digest!), parts.semanticEnc);
      await deps.storage.put(checksKey(verified.digest!), parts.checksWasm);
      const row = await publishBundle(
        <T = Record<string, unknown>>(text: string, params?: unknown[]) => deps.q<T>(text, params ?? []),
        {
          hash: verified.digest!, recipeId, version: verified.manifest.version,
          authorId: user.id, manifest: verified.manifest,
          bundleRef: bundleKey(verified.digest!), semanticRef: semanticKey(verified.digest!),
          checksRef: checksKey(verified.digest!),
        },
      );
      setResponseStatus(event, 201);
      return { ok: true, hash: row.hash, id: recipeId, version: row.version, title, price_honey_drops: price };
    } catch (e) {
      const code = (e as { code?: string }).code;
      setResponseStatus(event, code === "23505" ? 409 : 500);
      return { ok: false, error: code === "23505" ? "You already published this title" : "Could not publish", code: code === "23505" ? "duplicate" : "publish_failed" };
    }
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
