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
 * Deliberate limits: the token is the only credential; the body is capped; the model
 * name is not rewritten (the caller asked for one, the provider decides if it exists);
 * nothing here logs a prompt or a key — counts and status only.
 */
import { defineEventHandler } from "h3";
import { verifyInferenceToken } from "./buzzy/inferenceToken";

/** A chat body is small. 256 KB is generous for text and still bounded. */
const MAX_BODY_BYTES = 256 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const providerBase = () =>
  (process.env.BZ_CHAT_BASE_URL || "https://inference-api.nousresearch.com/v1").replace(/\/+$/, "");
const providerKey = () => (process.env.BZ_CHAT_KEY ?? "").trim();

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
};

export default defineEventHandler(async (event) => {
  const key = providerKey();
  if (!key) {
    // Fail closed before touching the token: telling a correctly-signed-in user their
    // credential is invalid when the deployment simply has no provider key is a lie.
    return json(503, {
      ok: false,
      code: "not_configured",
      error: "BeeZilla inference has no provider key on this deployment",
    });
  }

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
      error: `BeeZilla inference has no ${tail || "/"} — use /chat/completions or /models`,
    });
  }
  if (!methods.includes(event.method)) {
    return json(405, { ok: false, code: "method_not_allowed", error: `use ${methods.join(" or ")} for ${tail}` });
  }

  const auth = String(event.headers.get("authorization") ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return json(401, { ok: false, code: "unauthenticated", error: "a BeeZilla inference token is required" });
  }

  const verified = verifyInferenceToken(token, { scope: "inference" });
  if (!verified.ok) {
    // One answer for every failure mode: callers do not get to probe which part of
    // the token was wrong.
    return json(401, { ok: false, code: "invalid_token", error: "this inference token is not valid" });
  }

  // Only a chat completion carries a body. /models is a plain GET.
  let body: string | undefined;
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
      JSON.parse(body);
    } catch {
      return json(400, { ok: false, code: "bad_request", error: "request body must be JSON" });
    }
  }

  const started = Date.now();
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
      return json(502, { ok: false, code: "provider_auth", error: "BeeZilla inference is misconfigured upstream" });
    }
    if (upstream.status === 429) {
      return json(429, { ok: false, code: "rate_limited", error: "inference is rate limited right now" });
    }
    if (!upstream.ok) {
      return json(502, {
        ok: false,
        code: "provider_error",
        error: `inference provider answered ${upstream.status}`,
      });
    }

    // Stream the provider's body through unchanged: one shape for the client, and no
    // place for us to accidentally rewrite a token or a tool call.
    console.log(
      `[buzzy/inference] ${verified.claims?.sub ?? "?"} ok=${upstream.status} ms=${Date.now() - started}`,
    );
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": String(upstream.headers.get("content-type") ?? "application/json"),
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return json(502, {
      ok: false,
      code: "provider_unreachable",
      error: `could not reach the inference provider: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});
