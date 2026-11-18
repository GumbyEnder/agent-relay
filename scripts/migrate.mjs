#!/usr/bin/env node
/**
 * Deploy-time database migrator (node-postgres, `pg`).
 *
 * Runs during `npm run start` — i.e. in the container, before the server binds —
 * applying pending files in ../migrations to DATABASE_URL. Each file is applied in
 * one transaction and recorded in a `_migrations` table, so it runs once and is
 * safe to re-run.
 *
 * Since the split (stage 2, 2026-11-17) TWO services can boot against the same
 * database. Two migrators starting together would read an empty `_migrations` and
 * both try to apply the same file: one wins, the other dies on a duplicate table
 * and the platform rolls the deploy back. The fix is a session-level advisory lock
 * — the second process blocks until the first finishes, then finds everything
 * already applied and exits. `BZ_SKIP_MIGRATIONS=1` is the explicit opt-out for a
 * service that must never touch schema (it logs loudly, because "which service
 * owns migrations" must be answerable from the logs alone).
 *
 * No DATABASE_URL (local / preview builds) -> skip; the PGLite fallback applies
 * the same files at startup instead (see src/lib/db.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

/**
 * Any constant works as long as every migrator uses the same one. Chosen to be
 * recognisable in `pg_locks` output rather than random.
 */
const ADVISORY_LOCK_KEY = 4_202_081_117;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log(
    "[migrate] DATABASE_URL not set — skipping (the PGLite fallback migrates itself).",
  );
  process.exit(0);
}

if ((process.env.BZ_SKIP_MIGRATIONS ?? "").trim() === "1") {
  console.log("[migrate] BZ_SKIP_MIGRATIONS=1 — this service does not own schema; skipping.");
  process.exit(0);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // Session-level lock: held on this connection until release/exit. Waiting here
    // is correct — the alternative is two transactions racing on the same file.
    const waited = Date.now();
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    const waitedMs = Date.now() - waited;
    if (waitedMs > 250) {
      console.log(`[migrate] waited ${waitedMs}ms for another service's migrator to finish`);
    }

    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query("SELECT name FROM _migrations")).rows.map((r) => r.name),
    );

    let files;
    try {
      files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      console.log("[migrate] no migrations/ directory — nothing to do.");
      return;
    }

    let count = 0;
    for (const name of files) {
      if (applied.has(name)) continue;
      const text = await readFile(join(migrationsDir, name), "utf8");
      try {
        await client.query("BEGIN");
        // pg's simple-query protocol runs a whole multi-statement file at once.
        await client.query(text);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK fails when the connection died — keep the original error.
        }
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.");
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err?.message || err);
  // pg errors carry the context needed to debug a bad SQL file.
  for (const key of ["code", "detail", "hint", "position", "where"]) {
    if (err?.[key] != null) console.error(`[migrate]   ${key}: ${err[key]}`);
  }
  process.exit(1);
});
