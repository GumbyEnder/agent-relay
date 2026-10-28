/**
 * Local-runtime durability probe.
 *
 *   BZ_DATA_DIR=/tmp/x npx tsx scripts/local-durability-probe.ts write
 *   BZ_DATA_DIR=/tmp/x npx tsx scripts/local-durability-probe.ts read
 *
 * Proves BZ_DATA_DIR gives PGLite an on-disk store: `read` in a SECOND process
 * must see the row `write` inserted. Without BZ_DATA_DIR both runs are fresh
 * in-memory databases and `read` fails — that is the desktop blocker.
 */
import { getPglite, getSql, dbSource } from "../src/lib/db.ts";

const mode = process.argv[2] ?? "read";
const sql = await getSql();

try {
  if (mode === "write") {
    await sql`create table if not exists probe_local (k text primary key, v text not null)`;
    await sql`insert into probe_local (k, v) values ('p1', 'survived-restart')
             on conflict (k) do update set v = excluded.v`;
    const n = await sql<{ n: number }>`select count(*)::int as n from probe_local`;
    console.log(`write ok dbSource=${dbSource} rows=${JSON.stringify(n)}`);
  } else {
    const rows = await sql`select k, v from probe_local order by k`;
    console.log(`read ok dbSource=${dbSource} rows=${JSON.stringify(rows)}`);
  }
} catch (err) {
  console.log(`read FAILED dbSource=${dbSource}: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  // PGLite keeps a WAL open; close it so an on-disk run flushes before exit.
  const pg = await getPglite().catch(() => null);
  await pg?.close().catch(() => {});
}
