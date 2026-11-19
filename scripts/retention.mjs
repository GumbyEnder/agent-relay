#!/usr/bin/env node
/**
 * CR-6 retention sweep — runs at boot, after migrations, before the server
 * binds. It is deliberately NON-FATAL: a failed DELETE on a 24-month-old row
 * must never stop the app from serving. One structured log line per run.
 *
 * The arms (room #7319, frodo's ruling):
 *   feedback_rows  hard DELETE of reports older than 24 months. No soft copy.
 *   diag_nulled    SET diag = NULL at 12 months; the words, ref and date survive.
 *   ip_nulled      SET ip_hash = NULL at 90 days; the limiter only reads the last
 *                  hour and the last day, so an older hash has no use left.
 *   asr_hits       DELETE throttle rows older than 2 days (anonymous voice notes;
 *                  no audio, no text, only the peppered hash and a timestamp).
 *
 * Two services can boot against one database, so "safe to double-run" is a
 * SERIAL claim, not something a single rerun proves. This takes the SAME
 * session-level advisory lock scripts/migrate.mjs uses: the second process
 * blocks, then finds nothing to do. `sweepFeedback()` is exported so the proof
 * harness runs this exact SQL rather than a copy of it.
 *
 * No DATABASE_URL (local / preview) -> skip; the PGLite fallback owns its own
 * database there.
 */
import pg from "pg";

/** Must equal ADVISORY_LOCK_KEY in scripts/migrate.mjs. */
export const ADVISORY_LOCK_KEY = 4_202_081_117;

export const RETENTION = {
  rowMonths: 24,
  diagMonths: 12,
  ipDays: 90,
  asrHitDays: 2,
};

/**
 * Run every arm once. `sql` is anything with `.query(text, params?)`.
 * Returns counts; throws only on a real SQL error (the CLI catches it).
 */
export async function sweepFeedback(sql) {
  // pg's client.query resolves a Result object ({rows,rowCount}); PGlite resolves
  // an array of rows. Count both, so this function is the one implementation for
  // the boot script and the proof harness.
  const n = (r) => (Array.isArray(r) ? r.length : r?.rows?.length ?? r?.rowCount ?? 0);
  const rows = await sql.query(
    "DELETE FROM buzzy_feedback WHERE created_at < now() - interval '24 months' RETURNING 1",
    [],
  );
  const diag = await sql.query(
    "UPDATE buzzy_feedback SET diag = NULL, updated_at = now() WHERE diag IS NOT NULL AND created_at < now() - interval '12 months' RETURNING 1",
    [],
  );
  const ip = await sql.query(
    "UPDATE buzzy_feedback SET ip_hash = NULL, updated_at = now() WHERE ip_hash IS NOT NULL AND created_at < now() - interval '90 days' RETURNING 1",
    [],
  );
  const hits = await sql.query(
    "DELETE FROM buzzy_feedback_asr_hits WHERE created_at < now() - interval '2 days' RETURNING 1",
    [],
  );
  return {
    feedback_rows: n(rows),
    diag_nulled: n(diag),
    ip_nulled: n(ip),
    asr_hits: n(hits),
  };
}

export function retentionLine(counts, extra = {}) {
  const parts = [
    `feedback_rows=${counts.feedback_rows}`,
    `diag_nulled=${counts.diag_nulled}`,
    `ip_nulled=${counts.ip_nulled}`,
    `asr_hits=${counts.asr_hits}`,
  ];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
  return `[retention] ${parts.join(" ")}`;
}

async function main() {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.log("[retention] DATABASE_URL not set — skipping (PGLite owns its own data).");
    return;
  }
  if ((process.env.BZ_SKIP_RETENTION ?? "").trim() === "1") {
    console.log("[retention] BZ_SKIP_RETENTION=1 — skipping this service's sweep.");
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const waited = Date.now();
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    const waitedMs = Date.now() - waited;
    const started = Date.now();
    const counts = await sweepFeedback(client);
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    console.log(
      retentionLine(counts, {
        ok: true,
        ms: Date.now() - started,
        ...(waitedMs > 250 ? { waited_ms: waitedMs } : {}),
      }),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith("retention.mjs");
if (isMain) {
  main().catch((err) => {
    // Non-fatal by contract: log loudly, exit 0. The app must still bind.
    console.error(
      retentionLine(
        { feedback_rows: 0, diag_nulled: 0, ip_nulled: 0, asr_hits: 0 },
        { ok: false, error: JSON.stringify(String(err?.message || err).slice(0, 300)) },
      ),
    );
    process.exit(0);
  });
}
