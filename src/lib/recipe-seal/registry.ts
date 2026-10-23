/**
 * Recipe Seal — Step 4: registry, licensing, metering.
 *
 * Every function takes a `QueryFn` so the same code runs against the app's
 * database handle and against a test pool. No ORM, no hidden state.
 *
 * The two properties that matter:
 *   1. quota is spent with ONE atomic UPDATE — never read-then-write
 *   2. a licence grants execution rights against one bundle hash, never the text
 */
import { createHash, randomBytes } from "node:crypto";

export type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

export interface BundleRow {
  hash: string;
  recipe_id: string;
  version: string;
  author_id: string;
  manifest: unknown;
  bundle_ref: string;
  semantic_ref: string;
  checks_ref: string;
  status: "draft" | "published" | "revoked";
  created_at: string;
}

export interface LicenseRow {
  id: string;
  bundle_hash: string;
  licensee_kind: "account" | "agent" | "org";
  licensee_id: string;
  scopes: string[];
  quota: number | null;
  used: number;
  expires_at: string | null;
  revoked_at: string | null;
  price_cents: number;
  split_bp: Record<string, number>;
}

export interface AuthContext {
  ok: true;
  license: LicenseRow;
  bundleHash: string;
  scopes: string[];
}

export type AuthFailure =
  | { ok: false; reason: "invalid_token" }
  | { ok: false; reason: "revoked" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "bundle_revoked" }
  | { ok: false; reason: "scope_missing"; scope: string };

// ── ids and secrets ───────────────────────────────────────────────────────────
const b64url = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");

export function newId(prefix: string): string {
  return `${prefix}_${b64url(randomBytes(12))}`;
}

/** Returns the secret (shown once) and the hash that is stored. */
export function mintToken(): { secret: string; hash: string } {
  const secret = `rcp_${b64url(randomBytes(32))}`;
  return { secret, hash: hashToken(secret) };
}

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

// ── publish ───────────────────────────────────────────────────────────────────
export interface PublishInput {
  hash: string;
  recipeId: string;
  version: string;
  authorId: string;
  manifest: unknown;
  bundleRef: string;
  semanticRef: string;
  checksRef: string;
}

/** Idempotent: re-publishing the same hash returns the existing row. */
export async function publishBundle(q: QueryFn, input: PublishInput): Promise<BundleRow> {
  const rows = await q<BundleRow>(
    `INSERT INTO ar_recipe_bundle
       (hash, recipe_id, version, author_id, manifest, bundle_ref, semantic_ref, checks_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (hash) DO UPDATE SET status = ar_recipe_bundle.status
     RETURNING *`,
    [input.hash, input.recipeId, input.version, input.authorId, JSON.stringify(input.manifest),
     input.bundleRef, input.semanticRef, input.checksRef],
  );
  return rows[0];
}

export async function getBundle(q: QueryFn, hash: string): Promise<BundleRow | null> {
  const rows = await q<BundleRow>(`SELECT * FROM ar_recipe_bundle WHERE hash = $1`, [hash]);
  return rows[0] ?? null;
}

export async function listBundles(q: QueryFn, limit = 50): Promise<BundleRow[]> {
  return q<BundleRow>(
    `SELECT * FROM ar_recipe_bundle WHERE status = 'published' ORDER BY created_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
}

export async function revokeBundle(q: QueryFn, hash: string): Promise<boolean> {
  const rows = await q(
    `UPDATE ar_recipe_bundle SET status = 'revoked' WHERE hash = $1 AND status <> 'revoked' RETURNING hash`,
    [hash],
  );
  return rows.length > 0;
}

// ── licensing ─────────────────────────────────────────────────────────────────
export interface IssueLicenseInput {
  bundleHash: string;
  licenseeKind: "account" | "agent" | "org";
  licenseeId: string;
  quota?: number | null;
  scopes?: ("run" | "verify" | "usage")[];
  expiresAt?: Date | null;
  priceCents?: number;
  splitBp?: Record<string, number>;
  tokenLabel?: string;
}

export interface IssuedLicense {
  licenseId: string;
  tokenSecret: string;
  license: LicenseRow;
}

export async function issueLicense(q: QueryFn, input: IssueLicenseInput): Promise<IssuedLicense> {
  const bundle = await getBundle(q, input.bundleHash);
  if (!bundle) throw new Error("unknown_bundle");
  if (bundle.status === "revoked") throw new Error("bundle_revoked");

  const licenseId = newId("lic");
  const { secret, hash } = mintToken();
  const scopes = input.scopes ?? ["run", "verify"];

  const rows = await q<LicenseRow>(
    `INSERT INTO ar_recipe_license
       (id, bundle_hash, licensee_kind, licensee_id, scopes, quota, expires_at, price_cents, split_bp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [licenseId, input.bundleHash, input.licenseeKind, input.licenseeId, scopes,
     input.quota ?? null, input.expiresAt ?? null, input.priceCents ?? 0,
     JSON.stringify(input.splitBp ?? { author: 7000, platform: 3000 })],
  );
  await q(
    `INSERT INTO ar_recipe_token (id, license_id, token_hash, label) VALUES ($1,$2,$3,$4)`,
    [newId("tok"), licenseId, hash, input.tokenLabel ?? null],
  );
  return { licenseId, tokenSecret: secret, license: rows[0] };
}

export async function revokeLicense(q: QueryFn, licenseId: string, by: string): Promise<boolean> {
  const rows = await q(
    `UPDATE ar_recipe_license SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [licenseId, by],
  );
  return rows.length > 0;
}

export async function getLicense(q: QueryFn, licenseId: string): Promise<LicenseRow | null> {
  const rows = await q<LicenseRow>(`SELECT * FROM ar_recipe_license WHERE id = $1`, [licenseId]);
  return rows[0] ?? null;
}

// ── token auth ────────────────────────────────────────────────────────────────
export async function authenticate(
  q: QueryFn,
  secret: string,
  needScope?: "run" | "verify" | "usage",
): Promise<AuthContext | AuthFailure> {
  const rows = await q<LicenseRow & { bundle_status: string; token_revoked_at: string | null }>(
    `SELECT l.*, b.status AS bundle_status, t.revoked_at AS token_revoked_at
       FROM ar_recipe_token t
       JOIN ar_recipe_license l ON l.id = t.license_id
       JOIN ar_recipe_bundle  b ON b.hash = l.bundle_hash
      WHERE t.token_hash = $1`,
    [hashToken(secret)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid_token" };
  if (row.revoked_at || row.token_revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.bundle_status === "revoked") return { ok: false, reason: "bundle_revoked" };
  if (needScope && !row.scopes.includes(needScope)) {
    return { ok: false, reason: "scope_missing", scope: needScope };
  }
  await q(`UPDATE ar_recipe_token SET last_used_at = now() WHERE token_hash = $1`, [hashToken(secret)]);
  return { ok: true, license: row, bundleHash: row.bundle_hash, scopes: row.scopes };
}

// ── quota (the atomic part) ───────────────────────────────────────────────────
export type ReserveResult =
  | { ok: true; used: number; quota: number | null }
  | { ok: false; reason: "quota_exhausted" | "revoked" | "expired" | "unknown_license" };

/**
 * Spend one unit of quota. A single statement: no window between the check and
 * the increment, so concurrent callers cannot over-issue.
 */
export async function reserveRun(q: QueryFn, licenseId: string): Promise<ReserveResult> {
  const rows = await q<{ used: number; quota: number | null }>(
    `UPDATE ar_recipe_license
        SET used = used + 1
      WHERE id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND (quota IS NULL OR used < quota)
      RETURNING used, quota`,
    [licenseId],
  );
  if (rows.length > 0) return { ok: true, used: rows[0].used, quota: rows[0].quota };

  // Nothing updated: read back to explain why (never guess from the first query).
  const lic = await getLicense(q, licenseId);
  if (!lic) return { ok: false, reason: "unknown_license" };
  if (lic.revoked_at) return { ok: false, reason: "revoked" };
  if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: false, reason: "quota_exhausted" };
}

/**
 * Return a reserved unit. Called when the request fails after reserving (bad
 * KEK, storage miss, ledger write error) or when an idempotent retry is
 * deduped — otherwise quota is burned for work that produced no ledger row.
 */
export async function releaseRun(q: QueryFn, licenseId: string): Promise<boolean> {
  const rows = await q(
    `UPDATE ar_recipe_license SET used = GREATEST(used - 1, 0)
      WHERE id = $1 RETURNING used`,
    [licenseId],
  );
  return rows.length > 0;
}

// ── run ledger ────────────────────────────────────────────────────────────────
export interface RecordRunInput {
  licenseId: string;
  bundleHash: string;
  idemKey?: string | null;
  inputsHash: string;
  outputHash?: string | null;
  verdict: { ok: boolean; codes: string[]; warnings: string[] };
  costCents?: number;
  tokensIn?: number;
  tokensOut?: number;
  lane?: "api" | "local";
  ms?: number;
}

export async function recordRun(q: QueryFn, input: RecordRunInput): Promise<{ id: string; deduped: boolean }> {
  const id = newId("run");
  try {
    const rows = await q<{ id: string }>(
      `INSERT INTO ar_recipe_run
         (id, license_id, bundle_hash, idem_key, inputs_hash, output_hash, verdict,
          cost_cents, tokens_in, tokens_out, lane, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [id, input.licenseId, input.bundleHash, input.idemKey ?? null, input.inputsHash,
       input.outputHash ?? null, JSON.stringify(input.verdict), input.costCents ?? 0,
       input.tokensIn ?? null, input.tokensOut ?? null, input.lane ?? null, input.ms ?? null],
    );
    return { id: rows[0].id, deduped: false };
  } catch (err) {
    // Unique violation on (license_id, idem_key): the caller retried. Return the
    // original run so the response is identical and nothing is charged twice.
    const code = (err as { code?: string }).code;
    if (code === "23505" && input.idemKey) {
      const rows = await q<{ id: string }>(
        `SELECT id FROM ar_recipe_run WHERE license_id = $1 AND idem_key = $2`,
        [input.licenseId, input.idemKey],
      );
      if (rows[0]) return { id: rows[0].id, deduped: true };
    }
    throw err;
  }
}

export interface UsageSummary {
  licenseId: string;
  runs: number;
  used: number;
  quota: number | null;
  costCents: number;
}

export async function getUsage(q: QueryFn, licenseId: string): Promise<UsageSummary> {
  const rows = await q<{ runs: string; cost: string }>(
    `SELECT count(*)::text AS runs, coalesce(sum(cost_cents),0)::text AS cost
       FROM ar_recipe_run WHERE license_id = $1`,
    [licenseId],
  );
  const lic = await getLicense(q, licenseId);
  return {
    licenseId,
    runs: Number(rows[0]?.runs ?? 0),
    used: lic?.used ?? 0,
    quota: lic?.quota ?? null,
    costCents: Number(rows[0]?.cost ?? 0),
  };
}

/** Split a run's cost into author/platform accrual, in cents. */
export function splitCost(costCents: number, splitBp: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  let allocated = 0;
  const parts = Object.entries(splitBp).filter(([, bp]) => bp > 0);
  for (const [party, bp] of parts) {
    const cents = Math.floor((costCents * bp) / 10000);
    out[party] = cents;
    allocated += cents;
  }
  const platform = "platform";
  out[platform] = (out[platform] ?? 0) + (costCents - allocated);
  return out;
}
