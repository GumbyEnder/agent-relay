/**
 * Nitro handler for /api/wallet/**
 *
 *   GET  /api/wallet            — your balance and recent movements
 *   POST /api/wallet/purchase   — buy a recipe by hash
 *   GET  /api/wallet/owned      — hashes you can open
 *   GET  /api/wallet/sales      — the aggregate only: how many sold, what you earned
 *   POST /api/wallet/grant      — admin: issue Drops to an account
 *
 * Sold by whom and bought by whom are different questions, and only the first one
 * leaves the server. `sales` returns counts and totals; `buyer_id` is never selected.
 */
import { defineEventHandler, getMethod, readBody, setResponseStatus } from "h3";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { getBundle } from "@/lib/recipe-seal/registry";
import type { RecipeManifest } from "@/lib/recipe-seal/bundle";
import { grant, ledger, ownedHashes, purchase, salesSummary, walletSummary } from "./wallet";

function headersFromEvent(event: { node?: { req?: { headers?: Record<string, string | string[] | undefined> } } }): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(event.node?.req?.headers ?? {})) {
    if (typeof v === "string") h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(","));
  }
  return h;
}

async function roleOf(userId: string, email: string | null): Promise<string | null> {
  const sql = await getSql();
  const rows = await sql.query<{ role: string }>(
    `select role from ar_operator_roles
      where user_id = $1 or (lower(email) = lower($2) and $2 is not null) limit 1`,
    [userId, email ?? null],
  );
  return rows[0]?.role ?? null;
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  const path = (event.path ?? "").split("?")[0];
  if (!path.startsWith("/api/wallet")) {
    setResponseStatus(event, 404);
    return { ok: false, error: "Not found", code: "not_found" };
  }

  const user = await getSessionUserFromHeaders(headersFromEvent(event)).catch(() => null);
  if (!user) {
    setResponseStatus(event, 401);
    return { ok: false, error: "Sign in first", code: "signed_out" };
  }
  const sql = await getSql();
  const q = <T = Record<string, unknown>>(text: string, params?: unknown[]) => sql.query<T>(text, params ?? []);
  const rest = path.replace(/^\/api\/wallet\/?/, "").split("/").filter(Boolean);

  // ── GET /api/wallet ─────────────────────────────────────────────────────────
  if (rest.length === 0 && method === "GET") {
    const [summary, entries, owned] = await Promise.all([
      walletSummary(q, user.id),
      ledger(q, user.id, 25),
      ownedHashes(q, user.id),
    ]);
    return { ok: true, ...summary, entries, owned_count: owned.length, currency: "honey_drops" };
  }

  // ── GET /api/wallet/owned ───────────────────────────────────────────────────
  if (rest[0] === "owned" && method === "GET") {
    return { ok: true, hashes: await ownedHashes(q, user.id) };
  }

  // ── GET /api/wallet/sales ───────────────────────────────────────────────────
  if (rest[0] === "sales" && method === "GET") {
    const data = await salesSummary(q, user.id);
    // No buyer names, no buyer ids, no timestamps precise enough to correlate a
    // purchase back to a person. Sales are a business fact, not a customer list.
    return { ok: true, ...data, note: "Buyers are never identified to sellers." };
  }

  // ── POST /api/wallet/purchase ───────────────────────────────────────────────
  if (rest[0] === "purchase" && method === "POST") {
    const body = (await readBody(event).catch(() => ({}))) as { hash?: string };
    const hash = typeof body.hash === "string" ? body.hash.trim() : "";
    if (!hash) {
      setResponseStatus(event, 400);
      return { ok: false, error: "hash is required", code: "invalid_body" };
    }
    const bundle = await getBundle(q, hash);
    if (!bundle) {
      setResponseStatus(event, 404);
      return { ok: false, error: "No such recipe", code: "unknown_recipe" };
    }
    const manifest = bundle.manifest as RecipeManifest | null;
    if (!manifest?.listing) {
      setResponseStatus(event, 409);
      return { ok: false, error: "This recipe is not for sale", code: "not_listed" };
    }
    const sellerId = String(manifest.author?.id ?? "");
    if (sellerId === user.id) {
      setResponseStatus(event, 409);
      return { ok: false, error: "You already own this — you wrote it", code: "own_recipe" };
    }
    const price = Number(manifest.listing.price_honey_drops ?? 0);
    const splitBp = Number(manifest.pricing?.split_bp?.platform ?? NaN);

    const outcome = await purchase(q, {
      buyerId: user.id,
      sellerId,
      hash,
      recipeId: manifest.id,
      version: manifest.version,
      price,
      splitBp: Number.isFinite(splitBp) ? splitBp : undefined,
    });

    if (!outcome.ok) {
      setResponseStatus(event, outcome.reason === "insufficient_funds" ? 402 : 409);
      const message =
        outcome.reason === "free_recipe" ? "Claimed — this one is free"
        : outcome.reason === "already_owned" ? "You already own this"
        : "Not enough Honey Drops";
      return { ok: false, error: message, code: outcome.reason, balance: outcome.balance };
    }
    return { ok: true, hash, paid: outcome.price, balance: outcome.balanceAfter, currency: "honey_drops" };
  }

  // ── POST /api/wallet/grant (admin) ──────────────────────────────────────────
  if (rest[0] === "grant" && method === "POST") {
    const role = await roleOf(user.id, user.email ?? null);
    if (role !== "admin") {
      setResponseStatus(event, 403);
      return { ok: false, error: "Admins only", code: "forbidden" };
    }
    const body = (await readBody(event).catch(() => ({}))) as
      { email?: string; userId?: string; amount?: number; reason?: string; key?: string };
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      setResponseStatus(event, 400);
      return { ok: false, error: "amount must be a non-zero integer", code: "invalid_amount" };
    }
    let targetId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!targetId && typeof body.email === "string" && body.email.trim()) {
      const rows = await sql.query<{ id: string }>(
        `select id from "user" where lower(email) = lower($1) limit 1`,
        [body.email.trim()],
      );
      targetId = rows[0]?.id ?? "";
    }
    if (!targetId) {
      setResponseStatus(event, 404);
      return { ok: false, error: "No such account", code: "unknown_account" };
    }
    const res = await grant(q, {
      userId: targetId,
      amount,
      reason: "grant",
      ref: typeof body.reason === "string" ? body.reason : "ops grant",
      idempotencyKey: typeof body.key === "string" ? body.key : undefined,
    });
    return { ok: true, applied: res.applied, balance: res.balance };
  }

  setResponseStatus(event, 404);
  return { ok: false, error: "Not found", code: "not_found" };
});
