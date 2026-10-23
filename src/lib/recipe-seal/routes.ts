/**
 * Recipe Seal — HTTP routing, framework-free.
 *
 * `routeRecipes` is a pure function over (method, path, body, auth). The h3
 * adapter in `recipes.nitro.ts` is deliberately thin so this file can be tested
 * without booting the app.
 *
 * Access rules:
 *   GET  list/manifest        public
 *   POST verify, verify/batch  public, rate-limited (this is the free tier)
 *   POST run                  capability token, scope `run`
 *   GET  usage                capability token, scope `usage`
 *   POST license, publish     operator/session (checked by the adapter)
 */
import { verifyBundle, partsOf, openSemantic, inspectBundle, sha256Hex, type RecipeManifest } from "./bundle";
import {
  authenticate, getBundle, getUsage, issueLicense, listBundles, publishBundle, recordRun,
  reserveRun, splitCost, type LicenseRow, type QueryFn,
} from "./registry";
import { LIMITS, RateLimiter, verifyBatch, verifyDraft, type VerifyResult } from "./verify";
import { bundleKey, checksKey, semanticKey, type BundleStorage } from "./storage";
import { runSealedRecipe, type SemanticHalf } from "./pipeline";
import { createSafeLogger, memorySink, type LogSink } from "./safe-log";
import { loadRules } from "../recipe-checks";

export interface RouteRequest {
  method: string;
  path: string;
  body?: unknown;
  /** Present for token-authenticated requests; null for public ones. */
  token?: string | null;
  /** Operator identity from the app session (adapter supplies it). */
  operatorId?: string | null;
  /** Anonymous caller key for rate limiting (IP). */
  callerKey?: string;
}

export interface RouteResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RouteDeps {
  q: QueryFn;
  storage: BundleStorage;
  /** 32-byte KEK. Absent proves the verify path needs no plaintext. */
  kek?: Uint8Array | null;
  /** Injected model for `run`. If absent, `run` returns 503. */
  model?: (prompt: string) => Promise<string>;
  logSink?: LogSink;
  now?: () => number;
  anonymousLimiter?: RateLimiter;
  tokenLimiter?: RateLimiter;
}

export interface RecipeError {
  ok: false;
  error: string;
  code: string;
}

const err = (status: number, code: string, error: string): RouteResponse =>
  ({ status, body: { ok: false, error, code } satisfies RecipeError });

export function createRouteDeps(deps: Partial<RouteDeps> & { q: QueryFn; storage: BundleStorage }): RouteDeps {
  const now = deps.now ?? (() => Date.now());
  return {
    ...deps,
    now,
    anonymousLimiter: deps.anonymousLimiter ?? new RateLimiter(LIMITS.anonymousPerMinute, 60_000, now),
    tokenLimiter: deps.tokenLimiter ?? new RateLimiter(LIMITS.tokenPerMinute, 60_000, now),
    logSink: deps.logSink ?? memorySink(),
  };
}

async function loadBundleParts(storage: BundleStorage, hash: string) {
  const srb = await storage.get(bundleKey(hash));
  if (!srb) return null;
  return partsOf(srb);
}

export async function routeRecipes(req: RouteRequest, deps: RouteDeps): Promise<RouteResponse> {
  const { q, storage } = deps;
  const parts = req.path.split("?")[0].split("/").filter(Boolean); // ["api","recipes",…]
  if (parts[0] !== "api" || parts[1] !== "recipes") return err(404, "not_found", "unknown path");
  const rest = parts.slice(2);
  const method = req.method.toUpperCase();
  const body = (req.body ?? {}) as Record<string, unknown>;

  // ── GET /api/recipes ───────────────────────────────────────────────────────
  if (rest.length === 0 && method === "GET") {
    const rows = await listBundles(q);
    return { status: 200, body: { ok: true, recipes: rows.map((r) => ({
      hash: r.hash, id: r.recipe_id, version: r.version, author: r.author_id,
      manifest: r.manifest,
    }) ) } };
  }

  // ── POST /api/recipes (collection) — publish a sealed bundle ───────────────
  if (rest.length === 0 && method === "POST" && body.bundle) {
    if (!req.operatorId) return err(403, "signed_out", "operator session required");
    const bytes = new Uint8Array(Buffer.from(String(body.bundle), "base64"));
    const verified = verifyBundle(bytes);
    if (!verified.ok || !verified.manifest) {
      return err(400, verified.reason ?? "MANIFEST_SCHEMA", "bundle failed verification");
    }
    const manifest = verified.manifest;
    const bundleParts = partsOf(bytes)!;
    await storage.put(bundleKey(verified.digest!), bytes);
    await storage.put(semanticKey(verified.digest!), bundleParts.semanticEnc);
    await storage.put(checksKey(verified.digest!), bundleParts.checksWasm);
    let row;
    try {
      row = await publishBundle(q, {
        hash: verified.digest!, recipeId: manifest.id, version: manifest.version,
        authorId: manifest.author.id, manifest,
        bundleRef: bundleKey(verified.digest!), semanticRef: semanticKey(verified.digest!),
        checksRef: checksKey(verified.digest!),
      });
    } catch (cause) {
      // (recipe_id, version) is unique: republishing changed content under an
      // existing version is a client error, not a 500. An independent review
      // found this surfacing as an unhandled Postgres 23505.
      if ((cause as { code?: string }).code === "23505") {
        return err(409, "version_exists",
          `version ${manifest.version} of ${manifest.id} is already published with a different hash; ` +
          `publish a new version instead`);
      }
      throw cause;
    }
    return { status: 201, body: { ok: true, hash: row.hash, id: row.recipe_id, version: row.version } };
  }

  // ── /api/recipes/:hash/... ─────────────────────────────────────────────────
  const hash = rest[0];
  if (!hash) return err(404, "not_found", "unknown path");

  if (rest.length === 2 && rest[1] === "manifest" && method === "GET") {
    const bundle = await getBundle(q, hash);
    if (!bundle) return err(404, "unknown_bundle", "no such bundle");
    return { status: 200, body: { ok: true, manifest: bundle.manifest } };
  }

  if (rest.length === 2 && rest[1] === "verify" && method === "POST") {
    const limiter = req.token ? deps.tokenLimiter! : deps.anonymousLimiter!;
    const key = req.token ? `tok:${sha256Hex(req.token)}` : `ip:${req.callerKey ?? "unknown"}`;
    const gate = limiter.take(key);
    if (!gate.allowed) {
      return { status: 429, body: { ok: false, error: "rate limited", code: "rate_limited" },
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } };
    }
    const partsBundle = await loadBundleParts(storage, hash);
    if (!partsBundle) return err(404, "unknown_bundle", "no such bundle");
    const manifest = partsBundle.manifest;
    return verifyResponse(partsBundle.checksWasm, manifest, body.draft);
  }

  if (rest.length === 3 && rest[1] === "verify" && rest[2] === "batch" && method === "POST") {
    const drafts = Array.isArray(body.drafts) ? body.drafts : [];
    if (drafts.length > LIMITS.batchMax) {
      return err(413, "batch_too_large", `max ${LIMITS.batchMax} drafts per call`);
    }
    if (drafts.length === 0) return err(400, "invalid_body", "drafts must be a non-empty array");
    const partsBundle = await loadBundleParts(storage, hash);
    if (!partsBundle) return err(404, "unknown_bundle", "no such bundle");
    const manifest = partsBundle.manifest;
    const results = verifyBatch(drafts.map((draft) => ({
      checksWasm: partsBundle.checksWasm, draft, descriptions: manifest.checks.codes,
    })));
    return { status: results.status, body: { ok: results.ok, results: results.results, error: results.error } };
  }

  // ── token-scoped routes ────────────────────────────────────────────────────
  if (rest.length === 2 && rest[1] === "run" && method === "POST") {
    const auth = req.token ? await authenticate(q, req.token, "run") : { ok: false as const, reason: "invalid_token" as const };
    if (!auth.ok) return authFailure(auth.reason);
    if (!deps.model || !deps.kek) return err(503, "run_unavailable", "execution lane is not configured");
    const bundleRow = await getBundle(q, auth.bundleHash);
    if (!bundleRow) return err(404, "unknown_bundle", "no such bundle");
    const partsBundle = await loadBundleParts(storage, auth.bundleHash);
    if (!partsBundle) return err(404, "unknown_bundle", "bundle bytes missing");

    const reserved = await reserveRun(q, auth.license.id);
    if (!reserved.ok) return quotaFailure(reserved.reason);

    const opened = openSemantic(partsBundle, deps.kek);
    if (!opened.ok) return err(500, "semantic_unavailable", "recipe could not be opened");

    const rules = loadRules(partsBundle.checksWasm);
    const log = createSafeLogger(deps.logSink!, { level: "info", now: deps.now });
    const result = await runSealedRecipe({
      semantic: opened.semantic as SemanticHalf,
      inputs: (body.inputs ?? {}) as Record<string, unknown>,
      rules,
      model: deps.model,
      log,
      recipeHash: auth.bundleHash,
      licenseId: auth.license.id,
    });

    const idem = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    const run = await recordRun(q, {
      licenseId: auth.license.id, bundleHash: auth.bundleHash, idemKey: idem,
      inputsHash: sha256Hex(JSON.stringify(body.inputs ?? {})),
      outputHash: result.artifact ? sha256Hex(JSON.stringify(result.artifact)) : null,
      verdict: { ok: result.ok, codes: result.codes, warnings: result.verdict?.warnings ?? [] },
      costCents: Number((bundleRow.manifest as RecipeManifest | null)?.pricing?.amount_cents ?? 0),
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, lane: "api", ms: result.ms,
    });

    return { status: 200, body: {
      ok: result.ok, artifact: result.artifact, codes: result.codes,
      traceId: result.traceId, run: run.id, deduped: run.deduped,
    } };
  }

  if (rest.length === 3 && rest[1] === "license" && rest[2] === "usage" && method === "GET") {
    const auth = req.token ? await authenticate(q, req.token, "usage") : { ok: false as const, reason: "invalid_token" as const };
    if (!auth.ok) return authFailure(auth.reason);
    const usage = await getUsage(q, auth.license.id);
    return { status: 200, body: { ok: true, usage } };
  }

  // ── operator routes ────────────────────────────────────────────────────────
  if (rest.length === 2 && rest[1] === "license" && method === "POST") {
    if (!req.operatorId) return err(403, "signed_out", "operator session required");
    const bundleRow = await getBundle(q, hash);
    if (!bundleRow) return err(404, "unknown_bundle", "no such bundle");
    const licenseeId = typeof body.licenseeId === "string" ? body.licenseeId : null;
    if (!licenseeId) return err(400, "invalid_body", "licenseeId is required");
    const issued = await issueLicense(q, {
      bundleHash: hash,
      licenseeKind: (body.licenseeKind as "account" | "agent" | "org") ?? "account",
      licenseeId,
      quota: typeof body.quota === "number" ? body.quota : 500,
      scopes: Array.isArray(body.scopes)
        ? (body.scopes.filter((s) => typeof s === "string") as ("run" | "verify" | "usage")[])
        : undefined,
      expiresAt: typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null,
      priceCents: typeof body.priceCents === "number" ? body.priceCents : 0,
    });
    // The secret is returned exactly once.
    return { status: 201, body: { ok: true, licenseId: issued.licenseId, token: issued.tokenSecret } };
  }

  return err(404, "not_found", "unknown path");
}

function verifyResponse(checksWasm: Uint8Array, manifest: RecipeManifest, draft: unknown): RouteResponse {
  if (!draft || typeof draft !== "object") {
    return err(400, "invalid_body", "draft is required");
  }
  const result: VerifyResult = verifyDraft({
    checksWasm, draft, descriptions: manifest.checks.codes, engine: manifest.checks.engine,
  });
  return { status: 200, body: {
    ok: result.ok, codes: result.codes, warnings: result.warnings,
    descriptions: result.descriptions, engine: result.engine, ms_bucket: result.ms_bucket,
  } };
}

function authFailure(reason: "invalid_token" | "revoked" | "expired" | "bundle_revoked" | "scope_missing" | string): RouteResponse {
  const map: Record<string, [number, string]> = {
    invalid_token: [401, "invalid_token"],
    revoked: [403, "license_revoked"],
    expired: [403, "license_expired"],
    bundle_revoked: [403, "bundle_revoked"],
    scope_missing: [403, "scope_missing"],
  };
  const [status, code] = map[reason] ?? [401, "invalid_token"];
  return { status, body: { ok: false, error: code.replace(/_/g, " "), code } };
}

function quotaFailure(reason: string): RouteResponse {
  const map: Record<string, [number, string]> = {
    quota_exhausted: [402, "quota_exhausted"],
    revoked: [403, "license_revoked"],
    expired: [403, "license_expired"],
    unknown_license: [404, "unknown_license"],
  };
  const [status, code] = map[reason] ?? [402, "quota_exhausted"];
  return { status, body: { ok: false, error: code.replace(/_/g, " "), code } };
}

/** Split a licence's accrued cost for accounting. */
export function licenseSplit(license: LicenseRow, costCents: number): Record<string, number> {
  return splitCost(costCents, license.split_bp);
}

export { inspectBundle };
