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
import { verifyBundle, partsOf, openSemantic, inspectBundle, manifestPublishErrors, sha256Hex, type RecipeManifest } from "./bundle";
import { validateRules } from "../recipe-checks/seal";
import {
  authenticate, getBundle, getUsage, issueLicense, listBundles, publishBundle, recordRun,
  findRunByKey, releaseRun, reserveRun, splitCost, type LicenseRow, type QueryFn,
} from "./registry";
import { LIMITS, RateLimiter, verifyBatch, verifyDraft, type VerifyResult } from "./verify";
import { gateCapability, type OperatorCapability, type OperatorRole } from "../auth/roles";
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
  /** Resolved operator role. Publish/licence gate on `manage_keys`, not on
   *  "somebody is signed in" — an independent review proved a `viewer` could
   *  otherwise mint a million-run licence at price 0. */
  operatorRole?: OperatorRole | null;
  /** False in local-open mode, where every operator capability is granted. */
  authRequired?: boolean;
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
  /** Local-open mode opt-in (RECIPE_SEAL_ALLOW_OPEN). Off unless explicitly enabled. */
  allowOpen?: boolean;
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

/**
 * Gate an operator capability. Truthiness of `operatorId` is NOT authorisation:
 * any signed-in viewer satisfies that, which let a viewer mint an unlimited
 * licence at price 0 in an independent review.
 */
function requireOperator(req: RouteRequest, cap: OperatorCapability, deps: RouteDeps): RouteResponse | null {
  // `authRequired: false` is the app's local-open mode, and it is a master key:
  // humanAuthRequired() returns false whenever BETTER_AUTH_URL is unset, which
  // would hand publish/licence to anyone the moment that var goes missing. Only
  // honour open mode when the deployment explicitly opts in (RECIPE_SEAL_ALLOW_OPEN=1),
  // and never for an absent session.
  const openOptIn = req.authRequired === false && deps.allowOpen === true;
  const gate = gateCapability(req.operatorRole ?? null, cap, {
    // Anything short of an explicit opt-in must still demand a role. The earlier
    // expression let `authRequired:false` fall through to "no auth needed".
    authRequired: !openOptIn,
  });
  if (gate.ok) return null;
  return gate.reason === "signed_out"
    ? err(401, "signed_out", "sign in required")
    : err(403, "forbidden", `role '${req.operatorRole ?? "none"}' cannot ${cap}`);
}

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
    // The shelf, not the paperwork. A shopper needs to decide whether to buy, and
    // the full manifest is 1.5 KB of key material, hashes and pricing internals per
    // row. Everything here is published by definition; nothing here is the recipe.
    return { status: 200, body: { ok: true, recipes: rows.map((r) => {
      const m = r.manifest as Record<string, unknown> | null;
      const l = (m?.listing ?? {}) as Record<string, unknown>;
      const author = (m?.author ?? {}) as Record<string, unknown>;
      return {
        hash: r.hash,
        id: r.recipe_id,
        version: r.version,
        title: l.title ?? r.recipe_id,
        description: l.description ?? "",
        author: { id: author.id ?? r.author_id, name: author.name ?? null },
        created_at: m?.created_at ?? null,
        updated_at: l.updated_at ?? m?.created_at ?? null,
        published_at: (r as { created_at?: string }).created_at ?? null,
        // 0 is free. The client renders "Free" and never shows a price of zero.
        price_honey_drops: typeof l.price_honey_drops === "number" ? l.price_honey_drops : 0,
        is_free: (l.price_honey_drops ?? 0) === 0,
        // Kept so a client can show capability without a second request, and so the
        // existing tests that read it keep working.
        manifest: r.manifest,
      };
    }) } };
  }

  // ── POST /api/recipes (collection) — publish a sealed bundle ───────────────
  if (rest.length === 0 && method === "POST" && body.bundle) {
    const denied = requireOperator(req, "manage_keys", deps);
    if (denied) return denied;
    const bytes = new Uint8Array(Buffer.from(String(body.bundle), "base64"));
    const verified = verifyBundle(bytes);
    if (!verified.ok || !verified.manifest) {
      return err(400, verified.reason ?? "MANIFEST_SCHEMA", "bundle failed verification");
    }
    const manifest = verified.manifest;
    const bundleParts = partsOf(bytes)!;

    // Producer gate #2 — the one that actually holds. verifyBundle only proves a
    // bundle is internally consistent; a *hand-signed* manifest that sealBundle
    // refuses (prose copied into capability, codes or a split across fields) would
    // otherwise publish and be served verbatim. Publish decrypts the semantic half
    // it is about to store and refuses a manifest that reproduces it.
    if (!deps.kek) {
      return err(503, "publish_unavailable", "publishing requires the seal key (RECIPE_SEAL_KEK)");
    }
    const openedForPublish = openSemantic(bundleParts, deps.kek);
    if (!openedForPublish.ok) {
      return err(422, "sealed_unreadable", "the sealed semantic half cannot be opened with this key");
    }
    const publishErrors = manifestPublishErrors(manifest, openedForPublish.semantic);
    if (publishErrors.length > 0) {
      return err(422, "invalid_manifest",
        `refusing to publish: ${publishErrors.slice(0, 6).join("; ")}` +
        (publishErrors.length > 6 ? ` (+${publishErrors.length - 6} more)` : ""));
    }
    // A bundle whose checks module does not load would 500 the free tier and burn
    // a paid unit per attempt, so it is rejected at the door.
    try {
      // A module can load and still throw when evaluated (an invalid regex inside a
      // rule). Compiling every pattern here rejects it at the door instead of 500ing
      // verify, throwing in batch and burning a unit on run.
      validateRules(loadRules(bundleParts.checksWasm));
    } catch {
      return err(422, "invalid_checks", "checks.wasm does not evaluate as a sealed rule program");
    }

    try {
      await storage.put(bundleKey(verified.digest!), bytes);
      await storage.put(semanticKey(verified.digest!), bundleParts.semanticEnc);
      await storage.put(checksKey(verified.digest!), bundleParts.checksWasm);
    } catch (cause) {
      // Same digest but different bytes means the content-addressed store found a
      // collision. That is an integrity signal, not a server fault to 500 on.
      const msg = cause instanceof Error ? cause.message : String(cause);
      if (msg.includes("collision")) {
        return err(409, "bundle_collision", "a different bundle already occupies this hash");
      }
      return err(503, "storage_unavailable", "the bundle could not be stored");
    }
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
      const dbCode = (cause as { code?: string }).code;
      if (dbCode === "23505") {
        return err(409, "version_exists",
          `version ${manifest.version} of ${manifest.id} is already published with a different hash; ` +
          `publish a new version instead`);
      }
      // A constraint rejection is bad client input (a manifest shape the DB
      // refuses), not a server fault — and the Postgres message must not escape.
      if (dbCode === "23514") {
        return err(422, "invalid_manifest", "the manifest violates the protocol's structural constraints");
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
    // A withdrawn recipe must stop serving immediately — the manifest names the
    // codes and pricing, and a revoked bundle is no longer licensed at all.
    if (bundle.status === "revoked") return err(410, "bundle_revoked", "this recipe has been withdrawn");
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
    const bundleRow = await getBundle(q, hash);
    if (!bundleRow) return err(404, "unknown_bundle", "no such bundle");
    // Revocation must stop the free oracle too: verify reports exactly which
    // rules a draft violated, which is valuable to a competitor after withdrawal.
    if (bundleRow.status === "revoked") return err(410, "bundle_revoked", "this recipe has been withdrawn");
    const partsBundle = await loadBundleParts(storage, hash);
    if (!partsBundle) return err(404, "unknown_bundle", "no such bundle");
    const manifest = partsBundle.manifest;
    // Probing signal: distinct drafts per caller per hour. LIMITS.probingDraftsPerHour
    // was dead code because nothing ever called this.
    const probeCount = deps.anonymousLimiter?.noteDraftHash(req.callerKey ?? "unknown") ?? 0;
    const response = verifyResponse(partsBundle.checksWasm, manifest, body.draft);
    if (probeCount === LIMITS.probingDraftsPerHour || probeCount === LIMITS.probingDraftsPerHour * 2) {
      // Safe logger serialises an allow-list; nothing but counts and hashes here.
      deps.logSink?.write(JSON.stringify({ level: "warn", event: "draft_probing",
        drafts: probeCount, recipeHash: hash, caller: req.callerKey ?? "unknown" }));
    }
    return response;
  }

  if (rest.length === 3 && rest[1] === "verify" && rest[2] === "batch" && method === "POST") {
    const drafts = Array.isArray(body.drafts) ? body.drafts : [];
    if (drafts.length > LIMITS.batchMax) {
      return err(413, "batch_too_large", `max ${LIMITS.batchMax} drafts per call`);
    }
    if (drafts.length === 0) return err(400, "invalid_body", "drafts must be a non-empty array");
    // Single verify rejects a non-object draft with 400; batch used to score
    // null/42 as a draft and return C01/C02 verdicts, which is a different
    // contract for the same input.
    const badDraft = drafts.findIndex((d) => !d || typeof d !== "object" || Array.isArray(d));
    if (badDraft >= 0) return err(400, "invalid_body", `drafts[${badDraft}] is not an object`);
    // The batch route is a sibling door to the same oracle: without the same
    // limiter, a caller whose single-verify budget is exhausted could send
    // 50 drafts per call, forever. Counted per DRAFT, not per call.
    const batchLimiter = req.token ? deps.tokenLimiter! : deps.anonymousLimiter!;
    // Identical key derivation to single verify, or the two routes have independent
    // budgets and the batch becomes a way around an exhausted per-caller limit.
    const batchKey = req.token ? `tok:${sha256Hex(req.token)}` : `ip:${req.callerKey ?? "unknown"}`;
    for (let i = 0; i < drafts.length; i++) {
      const gate = batchLimiter.take(batchKey);
      if (!gate.allowed) {
        return { status: 429, body: { ok: false, error: "rate limited", code: "rate_limited" },
          headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } };
      }
    }
    if (deps.anonymousLimiter) {
      // Per DRAFT, not per request. Counting once per batch under-reported a
      // 50-draft prober by 50x and let it stay under the alert threshold.
      const caller = req.callerKey ?? "unknown";
      let draftsSeen = 0;
      for (let i = 0; i < drafts.length; i++) draftsSeen = deps.anonymousLimiter.noteDraftHash(caller);
      if (draftsSeen >= LIMITS.probingDraftsPerHour && draftsSeen < LIMITS.probingDraftsPerHour + drafts.length) {
        deps.logSink?.write(JSON.stringify({ level: "warn", event: "draft_probing",
          drafts: draftsSeen, recipeHash: hash, caller, route: "batch" }));
      }
    }
    const batchBundle = await getBundle(q, hash);
    if (!batchBundle) return err(404, "unknown_bundle", "no such bundle");
    if (batchBundle.status === "revoked") return err(410, "bundle_revoked", "this recipe has been withdrawn");
    const partsBundle = await loadBundleParts(storage, hash);
    if (!partsBundle) return err(404, "unknown_bundle", "no such bundle");
    const manifest = partsBundle.manifest;
    let batchResults: ReturnType<typeof verifyBatch>;
    try {
      batchResults = verifyBatch(drafts.map((draft) => ({
        checksWasm: partsBundle.checksWasm, draft, descriptions: manifest.checks.codes,
      })));
    } catch {
      // The same evaluator failure single verify answers 422 for. Without this the
      // batch route surfaced an uncaught SyntaxError as a 500.
      return err(422, "invalid_checks", "the checks module does not evaluate");
    }
    return { status: batchResults.status, body: { ok: batchResults.ok, results: batchResults.results, error: batchResults.error } };
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

    // Replay check BEFORE reserving or calling the model. Detecting the duplicate
    // only at INSERT meant a holder could loop the same idempotency key and get
    // free inference (charged, then refunded) — and a replay at exact exhaustion
    // returned 402 instead of the original result.
    const idem = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    if (idem) {
      const prior = await findRunByKey(q, auth.license.id, idem);
      if (prior) {
        const v = (prior.verdict ?? {}) as { ok?: boolean; codes?: string[]; warnings?: string[] };
        return { status: 200, body: {
          ok: v.ok ?? false, artifact: null, codes: v.codes ?? [], warnings: v.warnings ?? [],
          traceId: null, run: prior.id, deduped: true, replay: true,
          note: "replayed from the run ledger; no inference was performed and no quota was charged",
        } };
      }
    }

    const reserved = await reserveRun(q, auth.license.id);
    if (!reserved.ok) return quotaFailure(reserved.reason);

    const opened = openSemantic(partsBundle, deps.kek);
    if (!opened.ok) {
      await releaseRun(q, auth.license.id);   // never charge for a failed open
      return err(500, "semantic_unavailable", "recipe could not be opened");
    }

    let rules;
    try {
      rules = loadRules(partsBundle.checksWasm);
    } catch {
      await releaseRun(q, auth.license.id);   // no inference happened, no charge
      return err(502, "checks_unavailable", "the checks module does not load");
    }
    const log = createSafeLogger(deps.logSink!, { level: "info", now: deps.now });
    let result;
    try {
      result = await runSealedRecipe({
        semantic: opened.semantic as SemanticHalf,
        inputs: (body.inputs ?? {}) as Record<string, unknown>,
        rules,
        model: deps.model,
        log,
        recipeHash: auth.bundleHash,
        licenseId: auth.license.id,
      });
    } catch {
      // The pipeline threw after the unit was reserved. Releasing the unit while
      // the model has already been called gives a licensee unlimited free
      // inference (found by an independent review). Charge the attempt and write
      // the ledger row instead, so the spend is metered and visible; release only
      // if the row cannot be written.
      try {
        await recordRun(q, {
          licenseId: auth.license.id, bundleHash: auth.bundleHash,
          idemKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
          inputsHash: sha256Hex(JSON.stringify(body.inputs ?? {})),
          outputHash: null,
          verdict: { ok: false, codes: ["C93"], warnings: ["run_threw"] },
          costCents: Number((bundleRow.manifest as RecipeManifest | null)?.pricing?.amount_cents ?? 0),
          tokensIn: undefined, tokensOut: undefined, lane: "api", ms: undefined,
        });
      } catch {
        await releaseRun(q, auth.license.id);
      }
      return err(502, "run_failed", "the recipe could not be evaluated");
    }

    let run;
    try {
      run = await recordRun(q, {
        licenseId: auth.license.id, bundleHash: auth.bundleHash, idemKey: idem,
        inputsHash: sha256Hex(JSON.stringify(body.inputs ?? {})),
        outputHash: result.artifact ? sha256Hex(JSON.stringify(result.artifact)) : null,
        verdict: { ok: result.ok, codes: result.codes, warnings: result.verdict?.warnings ?? [] },
        costCents: Number((bundleRow.manifest as RecipeManifest | null)?.pricing?.amount_cents ?? 0),
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, lane: "api", ms: result.ms,
      });
    } catch {
      await releaseRun(q, auth.license.id);   // no ledger row, no charge
      return err(500, "run_not_recorded", "the run could not be recorded");
    }
    // An idempotent retry must not cost a second unit: refund the reservation it
    // made before we discovered the original run.
    if (run.deduped) await releaseRun(q, auth.license.id);

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
    const denied = requireOperator(req, "manage_keys", deps);
    if (denied) return denied;
    const bundleRow = await getBundle(q, hash);
    if (!bundleRow) return err(404, "unknown_bundle", "no such bundle");
    const licenseeId = typeof body.licenseeId === "string" ? body.licenseeId : null;
    if (!licenseeId) return err(400, "invalid_body", "licenseeId is required");
    if (bundleRow.status === "revoked") return err(409, "bundle_revoked", "this recipe has been withdrawn");
    const licenseeKind = (body.licenseeKind as string | undefined) ?? "account";
    if (!["account", "agent", "org"].includes(licenseeKind)) {
      return err(400, "invalid_licensee_kind", "licenseeKind must be account, agent or org");
    }

    // Validate operator input before it reaches SQL: quota=1.5, quota=1e20,
    // scopes=["root"] and expiresAt="garbage" all used to end as a 500, and an
    // operator (or anyone with the keys) could mint 1,000,000 runs at price 0
    // from a recipe priced otherwise.
    const manifest = bundleRow.manifest as RecipeManifest | null;
    const recipeQuota = manifest?.pricing?.quota_default ?? null;
    const recipePrice = manifest?.pricing?.amount_cents ?? 0;
    const quota = typeof body.quota === "number" ? body.quota : (recipeQuota ?? 500);
    if (!Number.isSafeInteger(quota) || quota < 0) return err(400, "invalid_quota", "quota must be a non-negative integer");
    if (recipeQuota !== null && quota > recipeQuota) {
      return err(400, "quota_exceeds_recipe", `this recipe licenses at most ${recipeQuota} runs`);
    }
    const priceCents = typeof body.priceCents === "number" ? body.priceCents : recipePrice;
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) return err(400, "invalid_price", "priceCents must be a non-negative integer");
    if (priceCents !== recipePrice) {
      return err(409, "price_mismatch", `this recipe is licensed at ${recipePrice} cents per run`);
    }
    if (body.scopes !== undefined && !Array.isArray(body.scopes)) {
      return err(400, "invalid_scope", "scopes must be an array");
    }
    const scopeList = Array.isArray(body.scopes)
      ? (body.scopes.filter((x) => typeof x === "string") as string[])
      : ["run", "verify", "usage"];
    const badScope = scopeList.find((x) => !["run", "verify", "usage"].includes(x));
    if (badScope) return err(400, "invalid_scope", `unknown scope '${badScope}'`);
    let expiresAt: Date | null = null;
    if (typeof body.expiresAt === "string") {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) return err(400, "invalid_expiry", "expiresAt is not a date");
    }
    let issued;
    try {
      issued = await issueLicense(q, {
        bundleHash: hash,
        licenseeKind: licenseeKind as "account" | "agent" | "org",
        licenseeId,
        quota,
        scopes: scopeList as ("run" | "verify" | "usage")[],
        expiresAt,
        priceCents,
      });
    } catch (cause) {
      // Never let a domain error escape as a 500 with a Postgres message in it.
      const code = (cause as Error).message;
      if (code === "bundle_revoked") return err(409, "bundle_revoked", "this recipe has been withdrawn");
      if (code === "unknown_bundle") return err(404, "unknown_bundle", "no such bundle");
      return err(500, "license_failed", "the licence could not be issued");
    }
    // The secret is returned exactly once.
    return { status: 201, body: { ok: true, licenseId: issued.licenseId, token: issued.tokenSecret } };
  }

  return err(404, "not_found", "unknown path");
}

function verifyResponse(checksWasm: Uint8Array, manifest: RecipeManifest, draft: unknown): RouteResponse {
  if (!draft || typeof draft !== "object") {
    return err(400, "invalid_body", "draft is required");
  }
  let result: VerifyResult;
  try {
    result = verifyDraft({
      checksWasm, draft, descriptions: manifest.checks.codes, engine: manifest.checks.engine,
    });
  } catch {
    // A bundle whose checks module will not load must not 500 the free tier.
    return err(422, "invalid_checks", "the checks module does not load");
  }
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
