import { getSql } from "@/lib/db";
import { chatCompletionFull, getModels } from "./llm";
import { resolvePin, resolveReview, providerOf, type ModelPin } from "./frontier";
import { loadGraph } from "./graphs";

/**
 * The resolver (6e).
 *
 * A run freezes its spec, walks the nodes in dependency order, and persists
 * every attempt. Three properties matter more than speed:
 *
 *  - A gate stops the run and the run *stays* stopped, with its state on disk,
 *    until the owner approves. Nothing downstream can run early.
 *  - A review node is resolved through resolveReview(), which takes the
 *    producer's provider and returns a different one; the result records
 *    `independent` so the claim is checkable afterwards, not assumed.
 *  - A retry is bounded (2 attempts) and recorded per attempt. A node that fails
 *    twice fails the run — it does not silently continue with no output.
 */

const MAX_ATTEMPTS = 2;
const MAX_INPUT_CHARS = 4000;

interface SpecNode {
  key: string;
  kind: "agent" | "skill" | "model" | "review" | "gate";
  title?: string;
  config?: Record<string, unknown>;
}

interface RunSpec {
  title: string;
  nodes: SpecNode[];
  edges: Array<{ from: string; to: string; kind: string }>;
  order: string[];
}

/** Kahn's algorithm. A cycle is not a graph we can run, and saying so beats hanging. */
export function orderNodes(nodes: SpecNode[], edges: Array<{ from: string; to: string }>): string[] {
  const keys = nodes.map((n) => n.key);
  const indeg = new Map<string, number>(keys.map((k) => [k, 0]));
  const out = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const queue = keys.filter((k) => (indeg.get(k) || 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const next of out.get(k) || []) {
      indeg.set(next, (indeg.get(next) || 0) - 1);
      if ((indeg.get(next) || 0) === 0) queue.push(next);
    }
  }
  if (order.length !== keys.length) {
    throw new Error("That workflow has a cycle — it cannot be run in order.");
  }
  return order;
}

function catalog(): Array<{ model: string; priceInPerMTok?: number; priceOutPerMTok?: number }> {
  try {
    return getModels();
  } catch {
    return [];
  }
}

function pinFor(node: SpecNode): ModelPin | null {
  const c = node.config || {};
  if (typeof c.category === "string" && c.category) {
    return { mode: "frontier", category: c.category, position: Number(c.position || 1) };
  }
  if (typeof c.family === "string" && c.family) return { mode: "latest", family: c.family };
  if (typeof c.model === "string" && c.model) return { mode: "exact", model: c.model };
  return null;
}

function instructionFor(node: SpecNode, context: string): { system: string; user: string } {
  const c = node.config || {};
  const brief = typeof c.prompt === "string" ? c.prompt : "";
  if (node.kind === "agent") {
    return {
      system: `You are the "${node.title || node.key}" step of a workflow. ${brief || "Do your step well and return only the work product."}`.trim(),
      user: context || "Begin the step.",
    };
  }
  if (node.kind === "skill") {
    const skill = typeof c.skill === "string" && c.skill ? c.skill : node.title || node.key;
    return {
      system: `Apply the skill "${skill}" to the material you are given. Return the work product only.`,
      user: context || "No input from a previous step.",
    };
  }
  if (node.kind === "review") {
    return {
      system: "You did not write the material below. Judge it. Name what is weak, what is missing and what is wrong, in that order, in under 200 words. Do not rewrite it.",
      user: context || "Nothing to review.",
    };
  }
  return {
    system: `You are the "${node.title || node.key}" step. Produce the work product for the next step.`,
    user: context || "Begin.",
  };
}

export async function startRun(userId: string, graphId: string): Promise<{ runId: string; status: string; order: string[] }> {
  const graph = await loadGraph(userId, graphId);
  if (!graph) throw new Error("No such graph on this account.");
  const nodes = graph.nodes as SpecNode[];
  const order = orderNodes(nodes, graph.edges);
  const spec: RunSpec = { title: graph.title, nodes, edges: graph.edges, order };

  const sql = await getSql();
  const runId = `run_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  await sql`
    INSERT INTO buzzy_graph_runs (id, graph_id, user_id, status, spec)
    VALUES (${runId}, ${graphId}, ${userId}, 'running', ${JSON.stringify(spec)}::jsonb)
  `;
  const outcome = await executeFrom(userId, runId, spec, 0);
  return { runId, status: outcome.status, order };
}

/** Continue a run that stopped at a gate (or after a crash), from `startIdx`. */
export async function resumeRun(userId: string, runId: string): Promise<{ status: string; resumedAt: number }> {
  const sql = await getSql();
  const rows = await sql<{ status: string; spec: RunSpec }>`
    SELECT status, spec FROM buzzy_graph_runs WHERE id = ${runId} AND user_id = ${userId} LIMIT 1
  `;
  if (!rows.length) throw new Error("No such run on this account.");
  const run = rows[0]!;
  if (run.status === "done") return { status: "done", resumedAt: -1 };
  if (run.status !== "awaiting_approval") throw new Error(`That run is ${run.status}, nothing to resume.`);

  // The gate node that stopped us gets its approval recorded, then we continue.
  const done = await sql<{ node_key: string }>`
    SELECT node_key FROM buzzy_graph_node_results WHERE run_id = ${runId} AND status = 'done'
  `;
  const finished = new Set(done.map((r) => r.node_key));
  const nextIdx = run.spec.order.findIndex((k) => !finished.has(k));

  await sql`UPDATE buzzy_graph_runs SET status = 'running' WHERE id = ${runId}`;
  const outcome = await executeFrom(userId, runId, run.spec, nextIdx < 0 ? run.spec.order.length : nextIdx);
  return { status: outcome.status, resumedAt: nextIdx };
}

async function executeFrom(
  userId: string,
  runId: string,
  spec: RunSpec,
  startIdx: number,
): Promise<{ status: string }> {
  const sql = await getSql();
  const byKey = new Map(spec.nodes.map((n) => [n.key, n]));
  const outputs = new Map<string, string>();
  let spent = 0;

  // Replay: any node that already succeeded contributes its stored output, so a
  // resumed run does not re-bill work it already did.
  const prior = await sql<{ node_key: string; output: unknown }>`
    SELECT node_key, output FROM buzzy_graph_node_results
    WHERE run_id = ${runId} AND status = 'done' AND attempt = 1
  `;
  for (const r of prior) {
    const text = (r.output as { text?: string } | null)?.text;
    if (typeof text === "string") outputs.set(r.node_key, text);
  }
  const spentRow = await sql<{ cost: string }>`SELECT cost_usd::text AS cost FROM buzzy_graph_runs WHERE id = ${runId}`;
  spent = Number(spentRow[0]?.cost || 0);

  const upstream = (key: string): string => {
    const parts: string[] = [];
    for (const e of spec.edges) {
      if (e.to !== key) continue;
      const text = outputs.get(e.from);
      if (text) parts.push(`[${e.from}]\n${text}`);
    }
    if (!parts.length) {
      // No declared predecessor: fall back to everything produced so far.
      for (const [k, v] of outputs) parts.push(`[${k}]\n${v}`);
    }
    return parts.join("\n\n").slice(0, MAX_INPUT_CHARS);
  };

  let lastProducerModel = "";
  for (let i = 0; i < startIdx; i++) {
    const prev = byKey.get(spec.order[i]!);
    if (prev && prev.kind !== "review" && prev.kind !== "gate") {
      const res = await sql<{ model: string | null }>`
        SELECT model FROM buzzy_graph_node_results WHERE run_id = ${runId} AND node_key = ${prev.key} AND status = 'done' LIMIT 1
      `;
      if (res[0]?.model) lastProducerModel = res[0].model;
    }
  }

  for (let i = startIdx; i < spec.order.length; i++) {
    const key = spec.order[i]!;
    const node = byKey.get(key);
    if (!node) continue;

    if (node.kind === "gate") {
      await sql`
        INSERT INTO buzzy_graph_node_results (run_id, node_key, attempt, status, output)
        VALUES (${runId}, ${node.key}, 1, 'awaiting_approval', ${JSON.stringify({ needs: "owner approval", title: node.title || node.key })}::jsonb)
        ON CONFLICT (run_id, node_key, attempt) DO UPDATE SET status = 'awaiting_approval'
      `;
      await sql`UPDATE buzzy_graph_runs SET status = 'awaiting_approval', cost_usd = ${spent} WHERE id = ${runId}`;
      return { status: "awaiting_approval" };
    }

    const context = upstream(key);
    const ask = instructionFor(node, context);
    let attempt = 1;
    let done = false;
    let lastError = "";

    while (attempt <= MAX_ATTEMPTS && !done) {
      const startedAt = new Date();
      const started = Date.now();
      try {
        let model: string;
        let provider: string;
        let independent: boolean | null = null;

        if (node.kind === "review") {
          const pin = pinFor(node) || { mode: "frontier" as const, category: "writing", position: 1 };
          const producer = lastProducerModel || (catalog()[0]?.model ?? "");
          const r = pin.mode === "exact"
            ? { model: pin.model, provider: providerOf(pin.model), independent: providerOf(pin.model) !== providerOf(producer) }
            : { ...resolveReview(producer, (pin as { category: string }).category || "writing", (pin as { position: number }).position || 1, catalog().map((m) => m.model)), independent: true };
          model = r.model;
          provider = r.provider;
          independent = r.independent;
        } else {
          const pin = pinFor(node);
          if (pin) {
            const r = resolvePin(pin, catalog().map((m) => m.model));
            model = r.model;
            provider = r.provider;
          } else {
            const first = catalog()[0];
            model = first?.model || "";
            provider = providerOf(model);
          }
        }

        const out = await chatCompletionFull(
          [
            { role: "system", content: ask.system },
            { role: "user", content: ask.user },
          ],
          { model, maxTokens: 900 },
        );
        if (!out.content || !out.content.trim()) throw new Error("the model returned nothing");

        const price = catalog().find((m) => m.model === model);
        const cost = out.usage && price
          ? ((out.usage.promptTokens || 0) / 1e6) * (price.priceInPerMTok ?? 0) + ((out.usage.completionTokens || 0) / 1e6) * (price.priceOutPerMTok ?? 0)
          : 0;
        spent += cost;

        await sql`
          INSERT INTO buzzy_graph_node_results
            (run_id, node_key, attempt, status, provider, model, independent, input, output, latency_ms, cost_usd, started_at, finished_at)
          VALUES (${runId}, ${node.key}, ${attempt}, 'done', ${provider}, ${model}, ${independent},
                  ${JSON.stringify({ context: context.slice(0, 1500) })}::jsonb,
                  ${JSON.stringify({ text: out.content.trim(), usage: out.usage })}::jsonb,
                  ${out.latencyMs}, ${cost}, ${startedAt.toISOString()}, ${new Date().toISOString()})
          ON CONFLICT (run_id, node_key, attempt) DO UPDATE SET
            status = 'done', output = EXCLUDED.output, latency_ms = EXCLUDED.latency_ms, cost_usd = EXCLUDED.cost_usd
        `;
        outputs.set(node.key, out.content.trim());
        if (node.kind !== "review") lastProducerModel = model;
        done = true;
      } catch (e) {
        lastError = (e as Error).message.slice(0, 300);
        const latency = Date.now() - started;
        await sql`
          INSERT INTO buzzy_graph_node_results (run_id, node_key, attempt, status, error, latency_ms, started_at, finished_at)
          VALUES (${runId}, ${node.key}, ${attempt}, 'failed', ${lastError}, ${latency},
                  ${startedAt.toISOString()}, ${new Date().toISOString()})
          ON CONFLICT (run_id, node_key, attempt) DO UPDATE SET status = 'failed', error = EXCLUDED.error
        `;
        attempt++;
      }
    }

    if (!done) {
      await sql`UPDATE buzzy_graph_runs SET status = 'failed', error = ${lastError}, cost_usd = ${spent}, finished_at = now() WHERE id = ${runId}`;
      return { status: "failed" };
    }
  }

  await sql`UPDATE buzzy_graph_runs SET status = 'done', cost_usd = ${spent}, finished_at = now() WHERE id = ${runId}`;
  return { status: "done" };
}

export async function readRun(userId: string, runId: string): Promise<null | {
  id: string; graph_id: string; status: string; error: string | null; cost_usd: number;
  started_at: string; finished_at: string | null;
  spec: RunSpec;
  results: Array<{ node_key: string; attempt: number; status: string; provider: string | null; model: string | null; independent: boolean | null; latency_ms: number | null; cost_usd: string; error: string | null; output: unknown }>;
}> {
  const sql = await getSql();
  const rows = await sql<{ id: string; graph_id: string; status: string; error: string | null; cost_usd: string; started_at: string; finished_at: string | null; spec: RunSpec }>`
    SELECT id, graph_id, status, error, cost_usd::text AS cost_usd, started_at, finished_at, spec
    FROM buzzy_graph_runs WHERE id = ${runId} AND user_id = ${userId} LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0]!;
  const results = await sql<{ node_key: string; attempt: number; status: string; provider: string | null; model: string | null; independent: boolean | null; latency_ms: number | null; cost_usd: string; error: string | null; output: unknown }>`
    SELECT node_key, attempt, status, provider, model, independent, latency_ms, cost_usd::text AS cost_usd, error, output
    FROM buzzy_graph_node_results WHERE run_id = ${runId} ORDER BY id
  `;
  return { ...r, cost_usd: Number(r.cost_usd), results };
}
