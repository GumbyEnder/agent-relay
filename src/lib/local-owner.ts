/**
 * Local (self-hosted) identity.
 *
 * The hosted product is multi-tenant: better-auth sessions, teams, delegations,
 * company scoping. A desktop install has exactly ONE owner and no cookie
 * jar worth trusting — but "it's on localhost" is not authentication. Any local
 * process can reach the port, and a web page can reach it by DNS rebinding.
 *
 * So local mode authenticates with two independent checks:
 *
 *   1. **Host allowlist** — the `Host` header must name loopback. This is what
 *      defeats DNS rebinding (the rebinding request carries the ATTACKER's
 *      hostname, not `127.0.0.1`).
 *   2. **Per-launch bearer token** — random per launch, handed to the child
 *      process and published in `runtime.json`; the window gets it through
 *      preload, the CLI reads it from the runtime file. It dies with the
 *      process, so a stale token on disk is useless.
 *
 * Identity itself is one row, provisioned idempotently on first use.
 */
import { timingSafeEqual } from "node:crypto";
import { getSql } from "./db";
import { isLocalRuntime } from "./runtime";
import type { VerifiedUser } from "./auth/verify.server";

/** Stable id: the whole local store belongs to this one account. */
export const LOCAL_OWNER_ID = "local_owner";
export const LOCAL_OWNER_EMAIL = "owner@beezilla.local";

const globalRef = globalThis as typeof globalThis & {
  __bzLocalOwner__?: Promise<VerifiedUser>;
};

/**
 * Provision (once per process) and return the single local owner.
 * Idempotent across restarts: `on conflict (email) do nothing`, then read back.
 */
export function ensureLocalOwner(): Promise<VerifiedUser> {
  globalRef.__bzLocalOwner__ ??= (async () => {
    const sql = await getSql();
    await sql`
      insert into "user" (id, name, email, "emailVerified")
      values (${LOCAL_OWNER_ID}, 'Owner', ${LOCAL_OWNER_EMAIL}, true)
      on conflict (email) do nothing
    `;
    const rows = await sql<{ id: string; email: string | null }>`
      select id, email from "user" where email = ${LOCAL_OWNER_EMAIL} limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("local owner row missing after insert");
    return { id: row.id, email: row.email };
  })().catch((err) => {
    globalRef.__bzLocalOwner__ = undefined;
    throw err;
  });
  return globalRef.__bzLocalOwner__;
}

/** Per-launch token injected by the launcher. Null in dev/manual runs. */
export function localToken(): string | null {
  const t = (process.env.BZ_LOCAL_TOKEN ?? "").trim();
  return t || null;
}

/**
 * True when the request's `Host` names loopback. A missing Host (non-browser
 * clients, curl with HTTP/1.0) is accepted — the token still gates it.
 */
export function isLoopbackHost(headers: Headers): boolean {
  const raw = (headers.get("host") ?? "").trim().toLowerCase();
  if (!raw) return true;
  const host = raw.replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Constant-time bearer comparison against the per-launch token. */
export function hasValidLocalToken(headers: Headers): boolean {
  const expected = localToken();
  // No token configured (manual `npm run dev`, tests) — Host allowlist is the
  // only gate. The launcher ALWAYS sets one, so a shipped install is strict.
  if (!expected) return true;

  const header = (headers.get("authorization") ?? "").trim();
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve the local owner for a request, or null when the request is not a
 * legitimate local client. Called from the single session chokepoint, so every
 * Nitro handler inherits it without its own auth code.
 */
export async function resolveLocalRequester(headers: Headers): Promise<VerifiedUser | null> {
  if (!isLocalRuntime()) return null;
  if (!isLoopbackHost(headers)) return null;
  if (!hasValidLocalToken(headers)) return null;
  return ensureLocalOwner();
}
