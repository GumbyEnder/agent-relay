import { getSql } from "@/lib/db";

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
  kind: NodeKind;
  title?: string;
  config?: Record<string, unknown>;
  x?: number;
  y?: number;
}

export interface GraphEdgeInput {
  from: string;
  to: string;
  kind?: EdgeKind;
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

export async function saveGraph(userId: string, input: GraphInput): Promise<{ id: string; version: number }> {
  const sql = await getSql();
  const id = input.id || rid("graph");
  const spec = JSON.stringify({ title: input.title, description: input.description ?? null, nodes: input.nodes, edges: input.edges });

  const existing = await sql<{ version: number }>`SELECT version FROM buzzy_graphs WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
  if (existing.length) {
    const version = Number(existing[0]!.version) + 1;
    await sql`
      UPDATE buzzy_graphs SET title = ${input.title}, description = ${input.description ?? null},
        spec = ${spec}::jsonb, version = ${version}, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
    `;
    await replaceChildren(sql, id, input);
    return { id, version };
  }

  await sql`
    INSERT INTO buzzy_graphs (id, user_id, title, description, spec)
    VALUES (${id}, ${userId}, ${input.title}, ${input.description ?? null}, ${spec}::jsonb)
  `;
  await replaceChildren(sql, id, input);
  return { id, version: 1 };
}

async function replaceChildren(sql: Awaited<ReturnType<typeof getSql>>, graphId: string, input: GraphInput): Promise<void> {
  // Delete-then-insert keeps the authored spec and the rows from drifting: the
  // rows are a rendering of the spec, never a second source of truth.
  await sql`DELETE FROM buzzy_graph_edges WHERE graph_id = ${graphId}`;
  await sql`DELETE FROM buzzy_graph_nodes WHERE graph_id = ${graphId}`;
  for (const n of input.nodes) {
    await sql`
      INSERT INTO buzzy_graph_nodes (id, graph_id, node_key, kind, title, config, pos_x, pos_y)
      VALUES (${rid("node")}, ${graphId}, ${n.key}, ${n.kind}, ${n.title ?? null},
              ${JSON.stringify(n.config ?? {})}::jsonb, ${n.x ?? null}, ${n.y ?? null})
    `;
  }
  for (const e of input.edges) {
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

export async function loadGraph(userId: string, id: string): Promise<null | {
  id: string; title: string; description: string | null; version: number;
  nodes: Array<{ key: string; kind: string; title: string | null; config: unknown; x: number | null; y: number | null }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}> {
  const sql = await getSql();
  const rows = await sql<{ id: string; title: string; description: string | null; version: number }>`
    SELECT id, title, description, version FROM buzzy_graphs WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `;
  if (!rows.length) return null;
  const g = rows[0]!;
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
    nodes: nodes.map((n) => ({
      key: n.node_key, kind: n.kind, title: n.title, config: n.config,
      x: n.pos_x == null ? null : Number(n.pos_x), y: n.pos_y == null ? null : Number(n.pos_y),
    })),
    edges: edges.map((e) => ({ from: e.from_key, to: e.to_key, kind: e.kind })),
  };
}
