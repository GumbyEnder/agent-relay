/**
 * Buzzy — account-scoped business profile (BZ-F001).
 *
 * Decision (recorded): REUSE `buzzy_user_memory` — no new table. The topology
 * map (§1i, §2) defaults to reuse; the profile is a set of confirmed
 * preferences keyed to the verified user id, exactly what the slot store is
 * for. Profile rows are stored with `job_id = NULL` (account-scoped, not
 * job-scoped) and a `profile_` key prefix so they never collide with the
 * question/statement slots (which are job-scoped).
 *
 * Ownership: every read/write is scoped to the server-resolved `userId`
 * (Better Auth `"user"."id"`). A different account can never see or mutate
 * another business's profile/defaults.
 *
 * Deliberately NOT inferred: tax jurisdiction, licenses, or customer consent.
 * The field set is fixed and closed; the save path rejects any key outside it,
 * so nothing auto-populates those from an address or a chat hint.
 *
 * Reuse semantics: "defaults" ARE the profile. When starting a project the
 * owner picks which saved defaults to copy into that job; the copy is a
 * snapshot written to the job's memory rows. Editing the profile later does
 * NOT rewrite values already copied into a job (and never touches approved
 * documents).
 */

import type { Sql } from "@/lib/db";

/** A single editable profile field, in plain business language (no jargon). */
export interface ProfileField {
  id: string;
  label: string;
  hint: string;
}

/** The closed set of profile fields. No tax/license/consent fields exist. */
export const PROFILE_FIELDS: ProfileField[] = [
  {
    id: "business_name",
    label: "Business name",
    hint: "What your business is called.",
  },
  {
    id: "primary_activity",
    label: "What your business does",
    hint: "One or two lines on the main work you take on.",
  },
  {
    id: "audience",
    label: "Who you serve",
    hint: "The customers or clients you work with.",
  },
  {
    id: "tone",
    label: "How you like to sound",
    hint: "Friendly, formal, direct — however you want BeeZilla to write.",
  },
  {
    id: "brand_notes",
    label: "Brand notes",
    hint: "Anything that should always be true about how your business is presented.",
  },
  {
    id: "constraints",
    label: "Recurring constraints",
    hint: "Rules that come up again and again — things you always want included or avoided.",
  },
];

/** Storage key prefix for account-scoped profile rows (job_id = NULL). */
export const PROFILE_PREFIX = "profile_";

export const PROFILE_KEYS: ReadonlySet<string> = new Set(
  PROFILE_FIELDS.map((f) => f.id),
);

/** A profile value plus its origin (who/when it was set). */
export interface ProfileValue {
  value: string;
  /** Always "you set this" — only the account owner can set their profile. */
  origin: string;
  updatedAt: string | null;
}

export interface Profile {
  /** field id -> value + origin. Only fields the owner has set are present. */
  fields: Record<string, ProfileValue>;
  hasProfile: boolean;
}

function profileKey(id: string): string {
  return `${PROFILE_PREFIX}${id}`;
}

/**
 * Read the account-scoped profile for `userId`. Rows are stored with
 * `job_id = NULL`; the NULL-safe match keeps them distinct from job slots.
 */
export async function getProfile(sql: Sql, userId: string): Promise<Profile> {
  const rows = await sql.query<{ key: string; value: string; updated_at: string | null }>(
    `SELECT key, value, updated_at FROM buzzy_user_memory
     WHERE user_id = $1 AND job_id IS NULL AND key LIKE $2
     ORDER BY key`,
    [userId, `${PROFILE_PREFIX}%`],
  );
  const fields: Record<string, ProfileValue> = {};
  for (const r of rows) {
    const id = r.key.slice(PROFILE_PREFIX.length);
    if (!PROFILE_KEYS.has(id)) continue; // never surface unknown/foreign keys
    fields[id] = { value: r.value, origin: "you set this", updatedAt: r.updated_at };
  }
  return { fields, hasProfile: Object.keys(fields).length > 0 };
}

/**
 * Save profile fields for `userId`. Only keys in the closed PROFILE_KEYS set
 * are persisted; anything else (e.g. tax/license/consent) is rejected and
 * returned in `rejected` — never stored, never inferred.
 */
export async function saveProfile(
  sql: Sql,
  userId: string,
  values: Record<string, unknown>,
): Promise<{ saved: string[]; rejected: string[] }> {
  const saved: string[] = [];
  const rejected: string[] = [];
  for (const [id, raw] of Object.entries(values)) {
    if (!PROFILE_KEYS.has(id)) {
      rejected.push(id);
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue; // empty = leave as-is / don't create blank rows
    // NOTE: profile rows store job_id = NULL. Postgres treats NULLs as distinct
    // under a plain UNIQUE constraint, so ON CONFLICT (user_id, job_id, key)
    // never matches for a NULL job_id. Delete-then-insert guarantees one row
    // per profile key (account-scoped) instead of accumulating duplicates.
    await sql.query(
      `DELETE FROM buzzy_user_memory WHERE user_id = $1 AND job_id IS NULL AND key = $2`,
      [userId, profileKey(id)],
    );
    await sql.query(
      `INSERT INTO buzzy_user_memory (user_id, job_id, key, value)
       VALUES ($1, NULL, $2, $3)`,
      [userId, profileKey(id), value],
    );
    saved.push(id);
  }
  return { saved, rejected };
}

/**
 * Copy selected saved defaults (profile fields) into a job's memory rows so
 * they become part of that job's context. This is a snapshot: the job's copy
 * is independent of later profile edits.
 */
export async function reuseDefaults(
  sql: Sql,
  userId: string,
  jobId: string,
  keys: string[],
): Promise<{ reused: string[]; skipped: string[] }> {
  const profile = await getProfile(sql, userId);
  const reused: string[] = [];
  const skipped: string[] = [];
  for (const id of keys) {
    if (!PROFILE_KEYS.has(id)) {
      skipped.push(id);
      continue;
    }
    const pv = profile.fields[id];
    if (!pv) {
      skipped.push(id); // no saved default to reuse
      continue;
    }
    await sql.query(
      `INSERT INTO buzzy_user_memory (user_id, job_id, key, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, job_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, jobId, profileKey(id), pv.value],
    );
    reused.push(id);
  }
  return { reused, skipped };
}
