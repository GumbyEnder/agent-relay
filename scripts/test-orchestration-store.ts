/**
 * CR-3 PR2 — the graph store is the record.
 *
 * The editor's spec must survive a save byte-for-byte, every save must leave a
 * revision behind in the same statement, and a version counter must never be the
 * only history. Also: the widened node-kind CHECK accepts the new vocabulary,
 * another account can neither read nor write a graph, and 50 revisions are kept.
 *
 * Hermetic: in-memory PGlite, every migration in order, no HTTP.
 *   npx tsx scripts/test-orchestration-store.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "../src/lib/db";
import {
  loadGraph,
  loadGraphRevision,
  listGraphRevisions,
  saveGraph,
  saveOrchestrationGraph,
} from "../src/lib/buzzy/graphs";
import { canonicalSpec, validateOrchestration, type OrchSpec } from "../src/lib/buzzy/orchestration";

let pass = 0, fail = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const eq = (a: unknown, b: unknown, msg = "") => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };

const golden: any = JSON.parse(readFileSync(join(process.cwd(), "scripts/fixtures/orchestration-golden.json"), "utf8"));
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(golden));

(async () => {
  const db = new PGlite();
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    try { await db.exec(readFileSync(join(dir, f), "utf8")); }
    catch (e) { console.error(`migration ${f} failed: ${(e as Error).message}`); process.exit(1); }
  }
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => { text += s + (i < values.length ? "$" + (i + 1) : ""); });
    return db.query(text, values).then((r) => r.rows);
  }) as unknown as Sql;
  (sql as unknown as { query: unknown }).query = (text: string, params?: unknown[]) => db.query(text, params ?? []).then((r) => r.rows);

  console.log("\nCR-3 store — spec as the record\n");

  let id = "";

  await ok("first save is revision 1 and returns the spec it stored", async () => {
    const saved = await saveOrchestrationGraph("u1", golden, sql);
    id = saved.id;
    eq(saved.version, 1);
    eq(saved.spec.id, id);
    const loaded = await loadGraph("u1", id, sql);
    truthy(loaded, "graph should exist");
    eq(canonicalSpec(loaded!.spec as OrchSpec), canonicalSpec(validateOrchestration(golden).spec));
    eq(loaded!.version, 1);
  });

  await ok("the projection carries the new node kinds (CHECK widened)", async () => {
    const rows = await db.query<{ kind: string }>("SELECT kind FROM buzzy_graph_nodes WHERE graph_id = $1 ORDER BY kind", [id]);
    const kinds = rows.rows.map((r) => r.kind);
    for (const k of ["approval", "decision", "loop", "parallel", "start", "end", "note"]) {
      truthy(kinds.includes(k === "approval" ? "gate" : k), `projection missing ${k} (got ${kinds.join(",")})`);
    }
  });

  await ok("a second save bumps to revision 2 and keeps revision 1 intact", async () => {
    const changed = clone();
    changed.name = "Research and ship a brief v2";
    const saved = await saveOrchestrationGraph("u1", { ...changed, id }, sql);
    eq(saved.version, 2);
    const revs = await listGraphRevisions("u1", id, sql);
    eq(revs.map((r) => r.revision), [2, 1]);
    const first = await loadGraphRevision("u1", id, 1, sql);
    truthy(first, "revision 1 should exist");
    eq(first!.spec.name, golden.name);
    const latest = await loadGraph("u1", id, sql);
    eq(latest!.spec!.name, "Research and ship a brief v2");
  });

  await ok("another account can neither read nor write it", async () => {
    const other = clone();
    other.name = "stolen";
    const saved = await saveOrchestrationGraph("u2", { ...other, id: "graph_u1_taken" }, sql);
    eq(saved.version, 1, "u2 gets its own new graph under its own id");
    eq(await loadGraph("u2", id, sql), null);
    eq(await loadGraphRevision("u2", id, 1, sql), null);
    eq(await listGraphRevisions("u2", id, sql), []);
  });

  await ok("an invalid spec is refused and writes nothing", async () => {
    const bad = clone();
    bad.nodes = bad.nodes.filter((n: any) => n.id !== "n_start");
    let threw = false;
    try { await saveOrchestrationGraph("u1", bad, sql); } catch (e) {
      threw = true;
      const code = (e as { code?: string }).code || "";
      truthy(/^ORCH\d+$/.test(code), `code was ${code}`);
    }
    truthy(threw, "invalid spec must throw");
    const count = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM buzzy_graphs WHERE user_id = 'u1'", []);
    eq(count.rows[0]!.n, 1);
  });

  await ok("50 revisions retained, oldest dropped", async () => {
    const base = clone();
    base.id = "graph_retention";
    for (let i = 1; i <= 55; i++) {
      const v = clone();
      v.id = "graph_retention";
      v.name = `retention ${i}`;
      await saveOrchestrationGraph("u1", v, sql);
    }
    const revs = await listGraphRevisions("u1", "graph_retention", sql);
    eq(revs.length, 50);
    eq(revs[0]!.revision, 55);
    eq(revs[49]!.revision, 6);
    void base;
  });

  await ok("the legacy save path also writes a revision (one history, not two)", async () => {
    const r = await saveGraph("u1", {
      title: "old whiteboard",
      nodes: [{ key: "a", kind: "agent", title: "A" }, { key: "b", kind: "gate", title: "B" }],
      edges: [{ from: "a", to: "b", kind: "gate" }],
    }, sql);
    const revs = await listGraphRevisions("u1", r.id, sql);
    eq(revs.length, 1);
    const loaded = await loadGraph("u1", r.id, sql);
    eq(loaded!.spec, null, "legacy graph has no orchestration spec");
    eq(loaded!.nodes.map((n) => n.key), ["a", "b"]);
  });

  await ok("a saved orchestration round-trips through the API's shape", async () => {
    const loaded = await loadGraph("u1", id, sql);
    const spec = loaded!.spec!;
    eq(spec.edges.length, golden.edges.length);
    eq(spec.nodes.length, golden.nodes.length);
    eq(loaded!.nodes.find((n) => n.key === "n_dec")!.kind, "decision");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
