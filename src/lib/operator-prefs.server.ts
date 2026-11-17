/**
 * The one door into `ar_operator_prefs` — the console's per-account operator
 * preferences row (JSONB `prefs` column).
 *
 * Why this module exists: BeeZilla's model controls live in that same row
 * (`modelPreference`, `provider`, `localOnly`, `budgetCapCents`), and until this
 * file existed `src/lib/buzzy/modelPrefs.ts` issued the SQL itself. That made the
 * product boundary leak — a consumer-side file naming a console table — and it is
 * exactly the kind of coupling that quietly turns two products into one again.
 *
 * The rule now, enforced by `scripts/check-buzzy-boundary.mjs`:
 *   - nothing under `src/lib/buzzy/` names an `ar_*` table;
 *   - `src/lib/buzzy/` may import only the modules on that script's allowlist,
 *     and this module is one of them.
 *
 * So the table name lives here, in console code, behind a function whose contract
 * is "the account's prefs object, or {} when there is no row". Callers keep their
 * own validation; this only reads.
 */

import type { Sql } from "@/lib/db";

/** The raw `prefs` object for one account. Empty object when there is no row. */
export async function readOperatorPrefsRow(
  sql: Sql,
  userId: string,
): Promise<Record<string, unknown>> {
  const rows = (await sql`
    select prefs from ar_operator_prefs where user_id = ${userId} limit 1
  `) as Array<{ prefs: unknown }>;

  const raw = rows[0]?.prefs;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
