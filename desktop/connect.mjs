/**
 * "Connect your BeeZilla account" — how a desktop install gets OUR inference.
 *
 * The cloud already issues the credential (POST /api/inference-token): a short-lived,
 * inference-scoped token minted for the signed-in owner. This module is the desktop
 * half: sign in on OUR site inside a window, then ask that window for the token and
 * hand it to the credential store.
 *
 * Two rules shape it:
 *
 *  1. The token is fetched INSIDE the cloud page, so the session cookie is never
 *     copied into our process. We ask the page for the result, not the cookie.
 *  2. Electron-free on purpose. `run()` takes the three things it needs — open a
 *     URL, evaluate JS in it, close it — so the whole contract is testable without a
 *     display, and main.mjs stays a thin shell over it.
 */

/**
 * Where the Connect window lands. It must be a page the DEPLOYMENT actually
 * serves: `${cloud}/connect` 404s on demo, beezilla-production and
 * app.devboards.ai, so the window rendered a blank 404 shell and then polled it
 * for 180 s — the "empty box" a user sees instead of a sign-in form.
 *
 * /login is same-origin and is the real sign-in UI on every deployment, which is
 * all the mint script needs (it fetches with credentials, so the cookie this page
 * sets is the one that mints). `scripts/test-desktop-connect.mjs --live` now proves
 * this path answers 200 instead of trusting a fake that served it.
 */
export const CONNECT_PATH = "/login";

/** What we ask the cloud page to do. Kept as one string so it is auditable. */
export const MINT_SCRIPT = `(async () => {
  try {
    const res = await fetch("/api/inference-token", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    return JSON.stringify({ status: res.status, body });
  } catch (err) {
    return JSON.stringify({ status: 0, body: { ok: false, error: String(err && err.message || err) } });
  }
})()`;

/**
 * Who signed in. The desktop's own identity is a synthetic single row
 * (`owner@beezilla.local`), which reads as "the app doesn't know me" right after a
 * user signed in with their real account. The account is right there in the page
 * we already have open, so read it and let the local owner adopt the name/email.
 * Best-effort: a failure here must never fail the connect.
 */
export const PROFILE_SCRIPT = `(async () => {
  try {
    const res = await fetch("/api/auth/get-session", { credentials: "include" });
    const body = await res.json().catch(() => ({}));
    const user = body && body.user ? body.user : null;
    return JSON.stringify({ status: res.status, user: user ? { name: user.name || "", email: user.email || "" } : null });
  } catch (err) {
    return JSON.stringify({ status: 0, user: null, error: String(err && err.message || err) });
  }
})()`;

/**
 * The search half. Separate call because our search quota is a different capability
 * and the deployment may not have it yet — a 503 here must not fail the sign-in.
 */
export const SEARCH_MINT_SCRIPT = `(async () => {
  try {
    const res = await fetch("/api/search-token", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    return JSON.stringify({ status: res.status, body });
  } catch (err) {
    return JSON.stringify({ status: 0, body: { ok: false, error: String(err && err.message || err) } });
  }
})()`;

/**
 * Where a shipped app looks for BeeZilla by default.
 *
 * It has to be a deployment that can mint AND spend a token, and that a real
 * account exists on:
 *
 *  - the demo host (beezilla-demo-production-c069) minted 401 for everyone and
 *    answered 503 `not_configured` for a signed-in owner — no signing key — and it
 *    has no /api/inference gateway at all (404). That is the "could not connect —
 *    not configured" popup a user hit.
 *  - beezilla-production is a stale build: /api/inference-token is 404 there.
 *  - app.devboards.ai has the mint, the gateway, and real accounts, which is where
 *    the owner actually signs in.
 *
 * A branded BeeZilla host is a one-line change here once one exists and is
 * configured (beezilla.ai still has no DNS record). BZ_CLOUD_URL overrides for
 * staging and tests.
 */
export const DEFAULT_CLOUD_URL = "https://app.devboards.ai";

/**
 * Network failures read very differently from credential failures, and the user-facing
 * answer is different too: "check your connection, or use your own key" — not an
 * Electron error string, and definitely not a 180-second wait on a blank window.
 */
const UNREACHABLE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i;

export function isUnreachable(error) {
  return UNREACHABLE.test(String(error?.message ?? error ?? ""));
}

const unreachableMessage = (base) =>
  `could not reach BeeZilla at ${base.replace(/^https?:\/\//, "")} — check your connection and try again, or use your own API key in the meantime`;

export function cloudBaseUrl(raw = process.env.BZ_CLOUD_URL || DEFAULT_CLOUD_URL) {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) throw new Error(`the BeeZilla URL must be http(s), got ${value.slice(0, 40)}`);
  return value;
}

/** Turn the page's answer into an outcome. Pure, so it is testable on its own. */
/**
 * @param {unknown} raw
 * @returns {{ok: boolean, token?: string, expiresAt?: string, baseUrl?: string, model?: string, error?: string, needsSignIn?: boolean}}
 */
/**
 * Search is optional: whatever goes wrong here, inference already works.
 * @param {unknown} raw
 * @returns {{ok: boolean, token?: string, expiresAt?: string, endpoint?: string, notDeployed?: boolean, error?: string}}
 */
export function interpretSearchMintResult(raw) {
  let parsed = null;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: "the BeeZilla window returned something unreadable" };
  }
  const status = Number(parsed?.status ?? 0);
  const body = parsed?.body ?? {};
  if (status === 503 || body.code === "not_configured") {
    return { ok: false, notDeployed: true, error: "BeeZilla search is not enabled on this deployment yet" };
  }
  if (status >= 200 && status < 300 && body.ok !== false && body.token) {
    return { ok: true, token: body.token, expiresAt: body.expiresAt, endpoint: body.endpoint };
  }
  return { ok: false, error: body.error || `the BeeZilla window answered ${status || "nothing"}` };
}

export function interpretMintResult(raw) {
  let parsed = null;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: "the BeeZilla window returned something unreadable" };
  }
  const status = Number(parsed?.status ?? 0);
  const body = parsed?.body ?? {};

  if (status === 401 || body.code === "unauthenticated") {
    return { ok: false, needsSignIn: true, error: "sign in to your BeeZilla account to use BeeZilla inference" };
  }
  if (status === 503 || body.code === "not_configured") {
    // Configuration problem on our side — do not blame the user's account.
    return { ok: false, error: String(body.error ?? "BeeZilla inference is not available on this deployment yet") };
  }
  if (status !== 200 || body.ok !== true || typeof body.token !== "string" || !body.token) {
    return { ok: false, error: String(body.error ?? `BeeZilla answered ${status || "nothing"}`) };
  }
  return {
    ok: true,
    token: body.token,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
  };
}

/**
 * The whole flow: open our site, ask for a token, always close the window.
 * A failure to close must not swallow the result — the token matters more than a
 * leaked window, and main.mjs's process exit cleans up anyway.
 */
/**
 * @param {{open: (url: string) => Promise<void>, evaluate: (script: string) => Promise<unknown>, close: () => Promise<void>|void, isOpen?: () => boolean, baseUrl?: string, signInDeadlineMs?: number, pollMs?: number}} deps
 * @returns {Promise<{ok: boolean, token?: string, expiresAt?: string, baseUrl?: string, model?: string, error?: string, needsSignIn?: boolean}>}
 */
export async function connectAccount(deps) {
  let base;
  try {
    base = deps.baseUrl ?? cloudBaseUrl();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!base) {
    return { ok: false, error: "no BeeZilla account server is configured (set BZ_CLOUD_URL)" };
  }

  try {
    await deps.open(`${base}${CONNECT_PATH}`);
  } catch (err) {
    // The likely case for a shipped app: the host does not resolve yet, or the user is
    // offline. Say that in words a non-technical user can act on, and stop.
    if (isUnreachable(err)) return { ok: false, unreachable: true, error: unreachableMessage(base) };
    return { ok: false, error: `could not open the BeeZilla window: ${err instanceof Error ? err.message : err}` };
  }

  let outcome;
  let search = null;
  try {
    try {
      outcome = interpretMintResult(await deps.evaluate(MINT_SCRIPT));
    } catch (err) {
      if (isUnreachable(err)) return { ok: false, unreachable: true, error: unreachableMessage(base) };
      throw err;
    }

    // A first visit is usually signed OUT. Rather than making the user find the
    // "connect" menu item again, keep the window open and watch for the sign-in to
    // land. The user closes the window to give up.
    const deadline = Date.now() + (deps.signInDeadlineMs ?? 180_000);
    const pollMs = deps.pollMs ?? 2_000;
    while (!outcome.ok && outcome.needsSignIn && Date.now() < deadline) {
      if (deps.isOpen && !deps.isOpen()) break;
      await new Promise((r) => setTimeout(r, pollMs));
      if (deps.isOpen && !deps.isOpen()) break;
      try {
        outcome = interpretMintResult(await deps.evaluate(MINT_SCRIPT));
      } catch (err) {
        if (isUnreachable(err)) {
          return { ok: false, unreachable: true, error: unreachableMessage(base) };
        }
        break; // the window went away mid-poll
      }
    }

    // Inference is in hand; now the search half. It runs while the window is still
    // open (the session lives there), and its problems never undo the sign-in.
    if (outcome?.ok) {
      try {
        search = interpretSearchMintResult(await deps.evaluate(SEARCH_MINT_SCRIPT));
      } catch (err) {
        search = { ok: false, error: `search token: ${err instanceof Error ? err.message : err}` };
      }
      // Same window, same session: who is this? Adopted by the local owner row.
      try {
        const raw = await deps.evaluate(PROFILE_SCRIPT);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed?.user?.email) outcome.account = { name: parsed.user.name || "", email: parsed.user.email };
      } catch {
        /* identity is a nicety, not a requirement */
      }
    }
  } catch (err) {
    outcome = { ok: false, error: `could not reach BeeZilla: ${err instanceof Error ? err.message : err}` };
  } finally {
    try {
      await deps.close();
    } catch {
      /* window cleanup is best-effort */
    }
  }
  return { ...outcome, search };
}
