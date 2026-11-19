/**
 * Recipes drawn on the whiteboard.
 *
 * Owner, 2026-11-18: "I need to be able to design my own orchestrations. So I need to
 * be able to have like the agent.md … and a bunch of skills and how they connect, and
 * the output and what we define as the output on the board. And I need to be able to
 * select a bunch of those things, like an area within the board, and say create
 * recipe."
 *
 * The board sends the cards and lines inside the selection; this file checks the
 * shape, keeps it per account, and turns it back into plain instructions
 * (recipeInstructions) when the recipe is run — the same "board instructions" a turn
 * gets from an edited board. A recipe is the person's own text for their own turns:
 * it can steer the work, never grant a tool or lift a privacy rule (chatLoop appends
 * it after the rules, and the tool list does not read it).
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";

export type RecipeNodeKind = "agent" | "skill" | "output" | "note" | "memory";

export interface RecipeNode {
  id: string;
  kind: RecipeNodeKind;
  title: string;
  /** The instructions written on the card (agent.md text, a skill's steps, the output spec). */
  body: string;
  x: number;
  y: number;
}
export interface RecipeLink { from: string; to: string }
export interface RecipeGraph { nodes: RecipeNode[]; links: RecipeLink[] }

export interface BoardRecipe {
  id: string;
  name: string;
  graph: RecipeGraph;
  createdAt: string;
  updatedAt: string;
}

const MAX_NODES = 40;
const MAX_LINKS = 80;
const MAX_TEXT = 2000;
const KINDS: RecipeNodeKind[] = ["agent", "skill", "output", "note", "memory"];

function text(v: unknown, max: number): string {
  return String(v ?? "").split(String.fromCharCode(0)).join("").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

/** A graph the board may store, or the reason it can't. */
export function cleanGraph(raw: unknown): { ok: true; graph: RecipeGraph } | { ok: false; error: string } {
  const g = raw as { nodes?: unknown; links?: unknown } | null;
  if (!g || !Array.isArray(g.nodes)) return { ok: false, error: "Select some cards on the board first." };
  if (g.nodes.length === 0) return { ok: false, error: "Select some cards on the board first." };
  if (g.nodes.length > MAX_NODES) return { ok: false, error: `A recipe can hold up to ${MAX_NODES} cards.` };
  const nodes: RecipeNode[] = [];
  const seen = new Set<string>();
  for (const n of g.nodes as Array<Record<string, unknown>>) {
    const id = text(n?.id, 60);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = (KINDS as string[]).includes(String(n?.kind)) ? (String(n.kind) as RecipeNodeKind) : "note";
    nodes.push({
      id,
      kind,
      title: text(n?.title, 120) || (kind === "agent" ? "agent.md" : "Untitled"),
      body: text(n?.body, MAX_TEXT),
      x: Math.round(Number(n?.x) || 0),
      y: Math.round(Number(n?.y) || 0),
    });
  }
  if (!nodes.length) return { ok: false, error: "Select some cards on the board first." };
  const links: RecipeLink[] = [];
  for (const l of (Array.isArray(g.links) ? g.links : []).slice(0, MAX_LINKS) as Array<Record<string, unknown>>) {
    const from = text(l?.from, 60);
    const to = text(l?.to, 60);
    if (from && to && from !== to && seen.has(from) && seen.has(to)) links.push({ from, to });
  }
  return { ok: true, graph: { nodes, links } };
}

/**
 * The recipe as instructions, in the order the lines run: agent.md first, then each
 * skill reached from it (left to right when nothing connects them), then the output.
 */
export function recipeInstructions(name: string, g: RecipeGraph): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const outs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of g.nodes) indeg.set(n.id, 0);
  for (const l of g.links) {
    outs.set(l.from, [...(outs.get(l.from) ?? []), l.to]);
    indeg.set(l.to, (indeg.get(l.to) ?? 0) + 1);
  }
  // Kahn's order, ties broken by position on the board (left, then top).
  const pos = (id: string) => { const n = byId.get(id)!; return n.x * 10000 + n.y; };
  const ready = g.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id).sort((a, b) => pos(a) - pos(b));
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of (outs.get(id) ?? []).sort((a, b) => pos(a) - pos(b))) {
      indeg.set(to, (indeg.get(to) ?? 1) - 1);
      if (indeg.get(to) === 0) ready.push(to);
    }
    ready.sort((a, b) => pos(a) - pos(b));
  }
  for (const n of g.nodes) if (!order.includes(n.id)) order.push(n.id); // a loop: keep every card
  const lines: string[] = [`RECIPE: ${name}`];
  const agent = order.map((id) => byId.get(id)!).filter((n) => n.kind === "agent");
  for (const a of agent) if (a.body) lines.push(`agent.md (how to work): ${a.body}`);
  let step = 0;
  for (const id of order) {
    const n = byId.get(id)!;
    if (n.kind === "skill") lines.push(`Step ${++step} — ${n.title}${n.body ? ": " + n.body : ""}`);
  }
  for (const id of order) {
    const n = byId.get(id)!;
    if (n.kind === "output") lines.push(`Output — ${n.title}${n.body ? ": " + n.body : ""}`);
    else if (n.kind === "note" && n.body) lines.push(`Note — ${n.body}`);
  }
  return lines.join("\n").slice(0, 4000);
}

function row(r: Record<string, unknown>): BoardRecipe {
  const g = typeof r.graph === "string" ? JSON.parse(r.graph) : r.graph;
  return {
    id: String(r.id),
    name: String(r.name),
    graph: g as RecipeGraph,
    createdAt: r.created_at ? new Date(String(r.created_at)).toISOString() : "",
    updatedAt: r.updated_at ? new Date(String(r.updated_at)).toISOString() : "",
  };
}

export async function listBoardRecipes(sql: Sql, userId: string): Promise<Array<BoardRecipe & { instructions: string }>> {
  const rows = await sql`
    SELECT id, name, graph, created_at, updated_at FROM buzzy_board_recipes
    WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`;
  return rows.map((r) => {
    const rec = row(r);
    return { ...rec, instructions: recipeInstructions(rec.name, rec.graph) };
  });
}

export async function saveBoardRecipe(
  sql: Sql,
  userId: string,
  input: { name?: unknown; graph?: unknown },
): Promise<{ ok: true; recipe: BoardRecipe & { instructions: string } } | { ok: false; error: string }> {
  const name = text(input.name, 80) || "My recipe";
  const checked = cleanGraph(input.graph);
  if (!checked.ok) return checked;
  const count = await sql`SELECT count(*)::int AS n FROM buzzy_board_recipes WHERE user_id = ${userId}`;
  if (Number(count[0]?.n ?? 0) >= 100) return { ok: false, error: "You have 100 recipes — delete one to make room." };
  const id = "brc_" + randomBytes(9).toString("base64url");
  const rows = await sql`
    INSERT INTO buzzy_board_recipes (id, user_id, name, graph)
    VALUES (${id}, ${userId}, ${name}, ${JSON.stringify(checked.graph)}::jsonb)
    RETURNING id, name, graph, created_at, updated_at`;
  const rec = row(rows[0]!);
  return { ok: true, recipe: { ...rec, instructions: recipeInstructions(rec.name, rec.graph) } };
}

export async function deleteBoardRecipe(sql: Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM buzzy_board_recipes WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}
