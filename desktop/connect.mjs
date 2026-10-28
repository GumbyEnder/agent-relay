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

export const CONNECT_PATH = "/connect";

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

export function cloudBaseUrl(raw = process.env.BZ_CLOUD_URL) {
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
    return { ok: false, error: `could not open the BeeZilla window: ${err instanceof Error ? err.message : err}` };
  }

  let outcome;
  try {
    outcome = interpretMintResult(await deps.evaluate(MINT_SCRIPT));

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
      } catch {
        break; // the window went away mid-poll
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
  return outcome;
}
