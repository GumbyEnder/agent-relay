import { getSql, type Sql } from "@/lib/db";
import { toGraphRows, validateOrchestration, type OrchSpec } from "./orchestration";

/**
 * Graphs are authored once and run many times. Saving replaces the node and
 * edge rows for that graph inside one transaction, because a half-written graph
 * (nodes without their edges) is not a valid graph and must never be visible.
 *
 * The authored `spec` on buzzy_graphs is the exact JSON the whiteboard sent; it
 * is what a run freezes into buzzy_graph_runs.spec, so it is the reproducibility
 * anchor and never derived from the node rows.
 */

export type NodeKind = "agent" | "skill" | "model" | "review" | "gate";
export type EdgeKind = "data" | "review" | "gate";

export interface GraphNodeInput {
  key: string;
  kind: string;
  title?: string;
  config?: Record<string, unknown>;
  x?: number;
  y?: number;
}

export interface GraphEdgeInput {
  from: string;
  to: string;
  kind?: string;
}

export interface GraphInput {
  id?: string;
  title: string;
  description?: string;
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
}

const NODE_KINDS: NodeKind[] = ["agent", "skill", "model", "review", "gate"];
const EDGE_KINDS: EdgeKind[] = ["data", "review", "gate"];
const MAX_NODES = 200;

function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Reject anything the schema would reject anyway, with a message a person can act on. */
export function validateGraph(input: unknown): { ok: true; graph: GraphInput } | { ok: false; error: string; code: string } {
  const g = input as GraphInput | null;
  if (!g || typeof g !== "object") return { ok: false, error: "Send a graph object.", code: "bad_graph" };
  const title = String(g.title || "").trim().slice(0, 160);
  if (!title) return { ok: false, error: "The graph needs a title.", code: "title_required" };
  if (!Array.isArray(g.nodes) || g.nodes.length === 0) return { ok: false, error: "A graph needs at least one node.", code: "no_nodes" };
  if (g.nodes.length > MAX_NODES) return { ok: false, error: `That is ${g.nodes.length} nodes — the limit is ${MAX_NODES}.`, code: "too_many_nodes" };

  const seen = new Set<string>();
  const nodes: GraphNodeInput[] = [];
  for (const raw of g.nodes) {
    const key = String(raw?.key || "").trim().slice(0, 60);
    if (!key) return { ok: false, error: "Every node needs a key.", code: "node_key_required" };
    if (seen.has(key)) return { ok: false, error: `Two nodes use the key "${key}".`, code: "duplicate_node" };
    seen.add(key);
    const kind = raw.kind as NodeKind;
    if (!NODE_KINDS.includes(kind)) {
      return { ok: false, error: `"${key}" is a ${String(raw.kind)} — node kinds are ${NODE_KINDS.join(", ")}.`, code: "bad_node_kind" };
    }
    nodes.push({
      key,
      kind,
      title: raw.title ? String(raw.title).slice(0, 160) : undefined,
      config: (raw.config && typeof raw.config === "object" ? raw.config : {}) as Record<string, unknown>,
      x: Number.isFinite(raw.x) ? Number(raw.x) : undefined,
      y: Number.isFinite(raw.y) ? Number(raw.y) : undefined,
    });
  }

  const edges: GraphEdgeInput[] = [];
  for (const raw of Array.isArray(g.edges) ? g.edges : []) {
    const kind = (raw?.kind || "data") as EdgeKind;
    if (!EDGE_KINDS.includes(kind)) {
      return { ok: false, error: `"${String(raw?.kind)}" is not an edge kind — use ${EDGE_KINDS.join(", ")}.`, code: "bad_edge_kind" };
    }
    const from = String(raw?.from || "");
    const to = String(raw?.to || "");
    // An edge to a node that does not exist is a silent dead end at run time.
    if (!seen.has(from) || !seen.has(to)) {
      return { ok: false, error: `Edge ${from || "?"} → ${to || "?"} points at a node that does not exist.`, code: "dangling_edge" };
    }
    edges.push({ from, to, kind });
  }

  return { ok: true, graph: { id: g.id, title, description: g.description ? String(g.description).slice(0, 2000) : undefined, nodes, edges } };
}

export async function saveGraph(userId: string, input: GraphInput, sqlIn?: Sql): Promise<{ id: string; version: number }> {
  const sql = sqlIn ?? await getSql();
  const id = input.id || rid("graph");
  const spec = JSON.stringify({ title: input.title, description: input.description ?? null, nodes: input.nodes, edges: input.edges });

  // One statement bumps the version and writes the revision snapshot together:
  //   CTE bumped -> UPDATE ... RETURNING version
  //   INSERT revisions SELECT ... FROM bumped
  // If the UPDATE matches nothing, the INSERT inserts nothing, so a caller can
  // tell "not mine" from "saved". The previous shape (SELECT, UPDATE, INSERT in
  // three calls) could bump a version and lose its snapshot on a crash.
  const bumped = await sql<{ revision: number }>`
    WITH bumped AS (
      UPDATE buzzy_graphs
         SET title = ${input.title}, description = ${input.description ?? null},
             spec = ${spec}::jsonb, version = version + 1, updated_at = now()
       WHERE id = ${id} AND user_id = ${userId}
      RETURNING version
    ), rev AS (
      INSERT INTO buzzy_graph_revisions (graph_id, user_id, revision, spec)
      SELECT ${id}, ${userId}, version, ${spec}::jsonb FROM bumped
      RETURNING revision
    )
    SELECT revision FROM rev
  `;
  if (!bumped.length) {
    const made = await sql<{ revision: number }>`
      WITH g AS (
        INSERT INTO buzzy_graphs (id, user_id, title, description, spec)
        VALUES (${id}, ${userId}, ${input.title}, ${input.description ?? null}, ${spec}::jsonb)
        RETURNING version
      ), rev AS (
        INSERT INTO buzzy_graph_revisions (graph_id, user_id, revision, spec)
        SELECT ${id}, ${userId}, version, ${spec}::jsonb FROM g
        RETURNING revision
      )
      SELECT revision FROM rev
    `;
    if (!made.length) throw new Error("could not save the graph");
  }
  await replaceChildren(sql, id, input.nodes, input.edges);
  await trimRevisions(sql, id);
  return { id, version: Number(bumped[0]?.revision ?? 1) };
}

/** 50 retained snapshots per graph. Old ones are dropped, never the newest. */
async function trimRevisions(sql: Sql, graphId: string): Promise<void> {
  await sql`
    DELETE FROM buzzy_graph_revisions
     WHERE graph_id = ${graphId}
       AND revision <= (SELECT COALESCE(MAX(revision), 0) - 50 FROM buzzy_graph_revisions WHERE graph_id = ${graphId})
  `;
}

export async function listGraphRevisions(userId: string, graphId: string, sqlIn?: Sql): Promise<Array<{
  revision: number; created_at: string; thumb_asset_id: string | null;
}>> {
  const sql = sqlIn ?? await getSql();
  return sql`
    SELECT r.revision, r.created_at, r.thumb_asset_id
      FROM buzzy_graph_revisions r
      JOIN buzzy_graphs g ON g.id = r.graph_id
     WHERE r.graph_id = ${graphId} AND g.user_id = ${userId}
     ORDER BY r.revision DESC
     LIMIT 50
  `;
}

export async function loadGraphRevision(userId: string, graphId: string, revision: number, sqlIn?: Sql): Promise<null | { revision: number; spec: OrchSpec }> {
  const sql = sqlIn ?? await getSql();
  const rows = await sql<{ revision: number; spec: unknown }>`
    SELECT r.revision, r.spec
      FROM buzzy_graph_revisions r
      JOIN buzzy_graphs g ON g.id = r.graph_id
     WHERE r.graph_id = ${graphId} AND g.user_id = ${userId} AND r.revision = ${revision}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const v = validateOrchestration(rows[0]!.spec);
  return v.ok ? { revision: Number(rows[0]!.revision), spec: v.spec } : null;
}

/** Save an authored orchestration. The spec is canonicalised once, here, so the
 *  row, the revision and the caller all hold the same bytes. */
export async function saveOrchestrationGraph(
  userId: string,
  raw: unknown,
  sqlIn?: Sql,
): Promise<{ id: string; version: number; spec: OrchSpec }> {
  const checked = validateOrchestration(raw);
  if (!checked.ok) {
    const first = checked.issues.find((i) => i.severity === "error");
    throw Object.assign(new Error(first?.message || "The orchestration has blocking problems."), { code: first?.code || "invalid_spec", issues: checked.issues });
  }
  const spec = checked.spec;
  const id = spec.id || rid("graph");
  const sql = sqlIn ?? await getSql();
  const rows = toGraphRows(spec);

  const bumped = await sql<{ revision: number }>`
    WITH bumped AS (
      UPDATE buzzy_graphs
         SET title = ${spec.name}, description = ${spec.description ?? null},
             spec = ${JSON.stringify(spec)}::jsonb, version = version + 1, updated_at = now()
       WHERE id = ${id} AND user_id = ${userId}
      RETURNING version
    ), rev AS (
      INSERT INTO buzzy_graph_revisions (graph_id, user_id, revision, spec)
      SELECT ${id}, ${userId}, version, ${JSON.stringify(spec)}::jsonb FROM bumped
      RETURNING revision
    )
    SELECT revision FROM rev
  `;
  let version = Number(bumped[0]?.revision ?? 0);
  if (!version) {
    const made = await sql<{ revision: number }>`
      WITH g AS (
        INSERT INTO buzzy_graphs (id, user_id, title, description, spec)
        VALUES (${id}, ${userId}, ${spec.name}, ${spec.description ?? null}, ${JSON.stringify(spec)}::jsonb)
        RETURNING version
      ), rev AS (
        INSERT INTO buzzy_graph_revisions (graph_id, user_id, revision, spec)
        SELECT ${id}, ${userId}, version, ${JSON.stringify(spec)}::jsonb FROM g
        RETURNING revision
      )
      SELECT revision FROM rev
    `;
    version = Number(made[0]?.revision ?? 0);
    if (!version) throw new Error("could not save the orchestration");
  }
  await replaceChildren(sql, id, rows.nodes, rows.edges);
  await trimRevisions(sql, id);
  return { id, version, spec: { ...spec, id } };
}

async function replaceChildren(
  sql: Sql,
  graphId: string,
  nodes: GraphInput["nodes"],
  edges: GraphInput["edges"],
): Promise<void> {
  // Delete-then-insert keeps the authored spec and the rows from drifting: the
  // rows are a rendering of the spec, never a second source of truth.
  await sql`DELETE FROM buzzy_graph_edges WHERE graph_id = ${graphId}`;
  await sql`DELETE FROM buzzy_graph_nodes WHERE graph_id = ${graphId}`;
  for (const n of nodes) {
    await sql`
      INSERT INTO buzzy_graph_nodes (id, graph_id, node_key, kind, title, config, pos_x, pos_y)
      VALUES (${rid("node")}, ${graphId}, ${n.key}, ${n.kind}, ${n.title ?? null},
              ${JSON.stringify(n.config ?? {})}::jsonb, ${n.x ?? null}, ${n.y ?? null})
    `;
  }
  for (const e of edges) {
    await sql`
      INSERT INTO buzzy_graph_edges (graph_id, from_key, to_key, kind)
      VALUES (${graphId}, ${e.from}, ${e.to}, ${e.kind ?? "data"})
      ON CONFLICT (graph_id, from_key, to_key, kind) DO NOTHING
    `;
  }
}

export async function listGraphs(userId: string, limit = 50): Promise<Array<{
  id: string; title: string; version: number; updated_at: string; nodes: number;
}>> {
  const sql = await getSql();
  return sql`
    SELECT g.id, g.title, g.version, g.updated_at,
           (SELECT COUNT(*)::int FROM buzzy_graph_nodes n WHERE n.graph_id = g.id) AS nodes
    FROM buzzy_graphs g
    WHERE g.user_id = ${userId}
    ORDER BY g.updated_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `;
}

export async function loadGraph(userId: string, id: string, sqlIn?: Sql): Promise<null | {
  id: string; title: string; description: string | null; version: number;
  spec: OrchSpec | null; thumbAssetId: string | null;
  nodes: Array<{ key: string; kind: string; title: string | null; config: unknown; x: number | null; y: number | null }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}> {
  const sql = sqlIn ?? await getSql();
  const rows = await sql<{ id: string; title: string; description: string | null; version: number; spec: unknown; thumb_asset_id: string | null }>`
    SELECT id, title, description, version, spec, thumb_asset_id FROM buzzy_graphs WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `;
  if (!rows.length) return null;
  const g = rows[0]!;

  // The spec is the record (0049's own header says so; loadGraph used to ignore it).
  // An orchestration spec validates and is returned whole; a pre-CR-3 row has no
  // schema marker and still loads from its node/edge rows.
  const raw = g.spec as Record<string, unknown> | null;
  let spec: OrchSpec | null = null;
  if (raw && typeof raw === "object" && raw.schema === "beezilla/orchestration") {
    const v = validateOrchestration(raw);
    if (v.ok) spec = v.spec;
  }

  if (spec) {
    return {
      id: g.id,
      title: g.title,
      description: g.description,
      version: Number(g.version),
      spec,
      thumbAssetId: g.thumb_asset_id,
      nodes: spec.nodes.map((n) => ({
        key: n.id, kind: n.type, title: n.name, config: n.config, x: n.x, y: n.y,
      })),
      edges: spec.edges.map((e) => ({
        from: e.from.node,
        to: e.to.node,
        kind: e.to.port === "approved" || e.to.port === "rejected" ? "gate" : "data",
      })),
    };
  }

  const nodes = await sql<{ node_key: string; kind: string; title: string | null; config: unknown; pos_x: number | null; pos_y: number | null }>`
    SELECT node_key, kind, title, config, pos_x, pos_y FROM buzzy_graph_nodes WHERE graph_id = ${id} ORDER BY node_key
  `;
  const edges = await sql<{ from_key: string; to_key: string; kind: string }>`
    SELECT from_key, to_key, kind FROM buzzy_graph_edges WHERE graph_id = ${id} ORDER BY id
  `;
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    version: Number(g.version),
    spec: null,
    thumbAssetId: g.thumb_asset_id,
    nodes: nodes.map((n) => ({
      key: n.node_key, kind: n.kind, title: n.title, config: n.config,
      x: n.pos_x == null ? null : Number(n.pos_x), y: n.pos_y == null ? null : Number(n.pos_y),
    })),
    edges: edges.map((e) => ({ from: e.from_key, to: e.to_key, kind: e.kind })),
  };
}
