/**
 * Nitro handler for /api/inference — OUR inference gateway.
 *
 * The other half of "connect your BeeZilla account". `/api/inference-token` mints a
 * short-lived, inference-scoped `bz1.*` token; this route is where that token is
 * spent. The shared provider key (BZ_CHAT_KEY) lives here, server-side, and never
 * travels to a desktop install.
 *
 * Without this route the minted token had nowhere to go: it was handed a provider
 * base URL that cannot verify our HMAC, so a desktop that "connected" successfully
 * then failed on its first message with a provider 401. Minting and spending are two
 * halves of one capability and belong in the same deployment.
 *
 *   200  the provider's own response, streamed through unchanged (JSON or SSE)
 *   401  no token, wrong scope, forged, or expired
 *   405  not a POST
 *   413  request body over the cap
 *   503  no provider key on this deployment (fail closed)
 *   502  upstream refused or was unreachable
 *
 * Tails:
 *   POST /chat/completions   → inference provider, streamed through unchanged
 *   GET  /models             → inference provider
 *   POST /music              → ElevenLabs /v1/music, audio streamed back
 *
 * Every request passes four gates before we spend money:
 *   1. token — HMAC, scope, expiry                     → 401
 *   2. revocation — claims.iat vs the account's epoch  → 401 token_revoked
 *   3. plan — scope allowance + model allowlist        → 402 / 403
 *   4. quota — ledger sum over a rolling 24 h window   → 429
 *
 * A music key and an inference key are separate env vars on purpose: one leaked key
 * must not be able to spend the other provider.
 *
 * Deliberate limits: the token is the only credential; the body is capped; the model
 * name is not rewritten (the caller asked for one, the provider decides if it exists);
 * nothing here logs a prompt or a key — counts, plan, status and timing only.
 */
import { defineEventHandler } from "h3";
import { verifyInferenceToken } from "./buzzy/inferenceToken";
import { checkQuota, getEntitlement, recordUsage } from "./buzzy/entitlements";

/**
 * Body cap.
 *
 * 256 KB was right for text and wrong for the thing that shares this route: the
 * ASR half posts a 16 kHz mono WAV as base64 inside one chat message. A 15 s clip
 * is ~480 KB of PCM and ~640 KB once base64-encoded, so every spoken sentence
 * longer than ~2 s came back 413 body_too_large — the desktop mic recorded, posted,
 * and the transcript never arrived (measured: 502 from /api/buzzy/transcribe with
 * "transcription failed (413)").
 *
 * 8 MB covers a ~60 s clip with headroom and is still a bounded allocation.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const providerBase = () =>
  (process.env.BZ_CHAT_BASE_URL || "https://inference-api.nousresearch.com/v1").replace(/\/+$/, "");
const providerKey = () => (process.env.BZ_CHAT_KEY ?? "").trim();

/** Music is a different provider with its own key: one leak cannot spend both. */
const musicKey = () => (process.env.BZ_ELEVEN_KEY ?? "").trim();
const MUSIC_BASE = "https://api.elevenlabs.io/v1";
const MUSIC_MODEL = process.env.BZ_MUSIC_MODEL || "music_v2_5";
/** One music request, hard ceiling regardless of plan (ElevenLabs accepts 3–600 s). */
const MUSIC_ABS_MAX_SECONDS = 600;

/**
 * The gateway is mounted at `/api/inference` and `/api/inference/**`, because the
 * mint hands clients `baseUrl = …/api/inference` and every client appends its own
 * OpenAI-style tail (`buzzy/llm.ts`, `voice.ts`, `asr.ts` → `/chat/completions`;
 * `pricing.ts` → `/models`). A wildcard that ignored the tail would answer a
 * /models request with a chat completion, so the tail is mapped explicitly and
 * anything else is refused by name.
 */
const GATEWAY_PREFIX = "/api/inference";
const ALLOWED: Record<string, readonly string[]> = {
  "/chat/completions": ["POST"],
  "/models": ["GET"],
  "/music": ["POST"],
};

export default defineEventHandler(async (event) => {
  const pathname = new URL(event.req.url).pathname;
  const rest = pathname.startsWith(GATEWAY_PREFIX) ? pathname.slice(GATEWAY_PREFIX.length) : "";
  // Exact mount (no tail) keeps its original meaning: a chat completion body posted
  // straight at the gateway.
  const tail = rest === "" || rest === "/" ? "/chat/completions" : rest.replace(/\/+$/, "");
  const methods = ALLOWED[tail];
  if (!methods) {
    return json(404, {
      ok: false,
      code: "unknown_path",
      error: `BeeZilla inference has no ${tail || "/"} — use /chat/completions, /models or /music`,
    });
  }
  if (!methods.includes(event.method)) {
    return json(405, { ok: false, code: "method_not_allowed", error: `use ${methods.join(" or ")} for ${tail}` });
  }

  // Fail closed per upstream, before touching the token: telling a correctly-signed-in
  // user their credential is wrong when the deployment has no key is a lie.
  const isMusic = tail === "/music";
  if (isMusic && !musicKey()) {
    return json(503, { ok: false, code: "not_configured", error: "BeeZilla music has no provider key on this deployment" });
  }
  if (!isMusic && !providerKey()) {
    return json(503, { ok: false, code: "not_configured", error: "BeeZilla inference has no provider key on this deployment" });
  }
  const key = isMusic ? musicKey() : providerKey();

  const auth = String(event.headers.get("authorization") ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return json(401, { ok: false, code: "unauthenticated", error: "a BeeZilla token is required" });
  }

  const verified = verifyInferenceToken(token, { scope: isMusic ? "music" : "inference" });
  if (!verified.ok || !verified.claims) {
    // One answer for every failure mode: callers do not get to probe which part of
    // the token was wrong.
    return json(401, { ok: false, code: "invalid_token", error: "this token is not valid for this endpoint" });
  }
  const sub = verified.claims.sub;
  const jti = verified.claims.jti ?? null;

  // Gate 2 — instant revocation. A per-account epoch beats a deny list: everything
  // minted before it is stale, and a fresh sign-in mints past it.
  const ent = await getEntitlement(sub);
  if (verified.claims.iat * 1000 < ent.tokensValidAfter.getTime()) {
    return json(401, {
      ok: false,
      code: "token_revoked",
      error: "this token was revoked — sign in again to mint a fresh one",
    });
  }

  // Only a POST carries a body. /models is a plain GET.
  let body: string | undefined;
  let parsed: Record<string, unknown> = {};
  if (event.method === "POST") {
    try {
      body = await event.req.text();
    } catch {
      return json(400, { ok: false, code: "bad_request", error: "request body could not be read" });
    }
    if (body.length > MAX_BODY_BYTES) {
      return json(413, { ok: false, code: "body_too_large", error: "request body is too large" });
    }
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return json(400, { ok: false, code: "bad_request", error: "request body must be JSON" });
    }
  }

  const started = Date.now();

  // ── music ─────────────────────────────────────────────────────────────────────
  // Same gates, different provider. The clip's length IS the unit we are billed in,
  // so quota is checked in seconds before a single byte of audio is requested.
  if (isMusic) {
    const prompt = String(parsed.prompt ?? "").trim().slice(0, 2000);
    if (!prompt) {
      return json(400, { ok: false, code: "no_prompt", error: "describe the music you want" });
    }
    const raw = Number(parsed.seconds ?? 20);
    const seconds = Math.min(
      MUSIC_ABS_MAX_SECONDS,
      Math.max(3, Number.isFinite(raw) ? Math.round(raw) : 20),
    );

    const verdict = await checkQuota({ userId: sub, scope: "music", units: seconds });
    if (!verdict.ok) {
      await recordUsage({
        userId: sub,
        scope: "music",
        units: 0,
        ms: Date.now() - started,
        status: "refused",
        code: verdict.code ?? "quota",
        model: MUSIC_MODEL,
        jti,
      });
      return json(verdict.code === "plan_required" ? 402 : 429, {
        ok: false,
        code: verdict.code,
        plan: verdict.plan,
        limit: verdict.limit,
        used: verdict.used,
        error: verdict.error,
      });
    }

    try {
      const upstream = await fetch(`${MUSIC_BASE}/music`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ prompt, music_length_ms: seconds * 1000, model_id: MUSIC_MODEL }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        await recordUsage({
          userId: sub,
          scope: "music",
          units: 0,
          ms: Date.now() - started,
          status: "failed",
          code: `upstream_${upstream.status}`,
          model: MUSIC_MODEL,
          jti,
        });
        console.warn(`[buzzy/music] upstream=${upstream.status} plan=${verdict.plan}`);
        return json(upstream.status === 402 ? 402 : 502, {
          ok: false,
          code: upstream.status === 402 ? "provider_plan_required" : "provider_error",
          plan: verdict.plan,
          error:
            upstream.status === 402
              ? "the music provider account cannot use its Music API (paid plan required)"
              : `music provider answered ${upstream.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
        });
      }
      const audio = Buffer.from(await upstream.arrayBuffer());
      if (!audio.length) {
        await recordUsage({ userId: sub, scope: "music", units: 0, ms: Date.now() - started, status: "failed", code: "empty_audio", model: MUSIC_MODEL, jti });
        return json(502, { ok: false, code: "empty_audio", error: "music provider returned no audio" });
      }
      await recordUsage({
        userId: sub,
        scope: "music",
        units: seconds,
        ms: Date.now() - started,
        status: "ok",
        model: MUSIC_MODEL,
        jti,
      });
      console.log(
        `[buzzy/music] ${sub} plan=${verdict.plan} ok model=${MUSIC_MODEL} s=${seconds} bytes=${audio.length} ms=${Date.now() - started}`,
      );
      return new Response(audio, {
        status: 200,
        headers: {
          "content-type": upstream.headers.get("content-type") || "audio/mpeg",
          "cache-control": "no-store",
          "x-bz-plan": verdict.plan,
          "x-bz-used-seconds": String((verdict.used ?? 0) + seconds),
          "x-bz-limit-seconds": String(verdict.limit ?? ""),
        },
      });
    } catch (err) {
      await recordUsage({ userId: sub, scope: "music", units: 0, ms: Date.now() - started, status: "failed", code: "unreachable", model: MUSIC_MODEL, jti });
      return json(502, {
        ok: false,
        code: "provider_unreachable",
        error: `could not reach the music provider: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── inference ─────────────────────────────────────────────────────────────────
  const model = typeof parsed.model === "string" ? parsed.model : "";
  const verdict = await checkQuota({ userId: sub, scope: "inference", units: 1, model });
  if (!verdict.ok) {
    await recordUsage({
      userId: sub,
      scope: "inference",
      units: 0,
      ms: Date.now() - started,
      status: "refused",
      code: verdict.code ?? "quota",
      model: model || null,
      jti,
    });
    return json(
      verdict.code === "model_not_allowed" ? 403 : verdict.code === "plan_required" ? 402 : 429,
      {
        ok: false,
        code: verdict.code,
        plan: verdict.plan,
        limit: verdict.limit,
        used: verdict.used,
        error: verdict.error,
      },
    );
  }

  try {
    const upstream = await fetch(`${providerBase()}${tail}`, {
      method: event.method,
      headers: {
        authorization: ["Bearer", key].join(" "),
        ...(body === undefined ? {} : { "content-type": String(event.headers.get("content-type") ?? "application/json") }),
        accept: String(event.headers.get("accept") ?? "application/json"),
      },
      body,
      // A turn can legitimately run long; the client's own timeout governs patience.
      signal: AbortSignal.timeout(120_000),
    });

    if (upstream.status === 401 || upstream.status === 403) {
      // Our key was refused. That is our problem, not the caller's, and the wording
      // must not invite the user to "reconnect" for something only we can fix.
      console.warn("[buzzy/inference] upstream refused our provider key");
      await recordUsage({ userId: sub, scope: "inference", units: 0, ms: Date.now() - started, status: "failed", code: "provider_auth", model: model || null, jti });
      return json(502, { ok: false, code: "provider_auth", error: "BeeZilla inference is misconfigured upstream" });
    }
    if (upstream.status === 429) {
      await recordUsage({ userId: sub, scope: "inference", units: 0, ms: Date.now() - started, status: "failed", code: "rate_limited", model: model || null, jti });
      return json(429, { ok: false, code: "rate_limited", error: "inference is rate limited right now" });
    }
    if (!upstream.ok) {
      await recordUsage({ userId: sub, scope: "inference", units: 0, ms: Date.now() - started, status: "failed", code: `provider_${upstream.status}`, model: model || null, jti });
      return json(502, {
        ok: false,
        code: "provider_error",
        error: `inference provider answered ${upstream.status}`,
      });
    }

    // Charge on success only: a request the provider refused cost us nothing, and the
    // ledger must say so.
    await recordUsage({
      userId: sub,
      scope: "inference",
      units: 1,
      ms: Date.now() - started,
      status: "ok",
      model: model || null,
      jti,
    });

    // Stream the provider's body through unchanged: one shape for the client, and no
    // place for us to accidentally rewrite a token or a tool call.
    console.log(
      `[buzzy/inference] ${verified.claims?.sub ?? "?"} plan=${verdict.plan} ok=${upstream.status} model=${model || "-"} used=${(verdict.used ?? 0) + 1}/${verdict.limit ?? "?"} ms=${Date.now() - started}`,
    );
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": String(upstream.headers.get("content-type") ?? "application/json"),
        "cache-control": "no-store",
        "x-bz-plan": verdict.plan,
        "x-bz-used": String((verdict.used ?? 0) + 1),
        "x-bz-limit": String(verdict.limit ?? ""),
      },
    });
  } catch (err) {
    await recordUsage({ userId: sub, scope: "inference", units: 0, ms: Date.now() - started, status: "failed", code: "unreachable", model: model || null, jti });
    return json(502, {
      ok: false,
      code: "provider_unreachable",
      error: `could not reach the inference provider: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});
