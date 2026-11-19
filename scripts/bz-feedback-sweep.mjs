#!/usr/bin/env node
/**
 * Feedback retention sweep — runs once at boot, right after the migration step.
 *
 * 7319: the sweep must be NON-FATAL. A retention job that can stop a boot is a
 * retention job that takes the product down on its first bad day, so this script
 * always exits 0 and says what it did (or why it did nothing) in one line. The
 * `start` script wraps it in `|| echo`, and this file also exits 0 on every
 * internal error — belt and braces, because the wrapper can be edited by mistake.
 *
 * No DATABASE_URL (local / preview) means nothing to sweep: the PGLite file is
 * per-developer and dies with the container.
 */
import pg from "pg";

const DAYS = Math.max(1, Number(process.env.BZ_FEEDBACK_RETENTION_DAYS || 90));

const done = (msg, code = 0) => {
  console.log(`[feedback-sweep] ${msg}`);
  process.exit(code);
};

const url = (process.env.DATABASE_URL || "").trim();
if (!url) done("no DATABASE_URL — nothing to sweep");

let client;
try {
  client = new pg.Client({ connectionString: url, ssl: url.includes("railway") || !url.includes("localhost") ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const res = await client.query(
    `DELETE FROM buzzy_feedback
      WHERE created_at < now() - ($1 || ' days')::interval
      RETURNING id`,
    [String(DAYS)],
  );
  done(`deleted ${res.rowCount} row(s) older than ${DAYS} day(s)`);
} catch (e) {
  // A missing table on a fresh database, or a lock at boot: say so and boot on.
  done(`skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
} finally {
  try {
    await client?.end();
  } catch {
    /* the process is about to exit anyway */
  }
}
