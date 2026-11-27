/**
 * draw_board — a sketch of the work, drawn into the project's own board.
 *
 * Why a tool and not a picture: the owner asked for "a diagram I can change", and an
 * image model cannot give one. So this writes the SAME document the Sketch page reads
 * (/api/buzzy/art GET → data.board), using the page's own marks — rectangles for boxes,
 * arrows and plain lines for connectors, text marks for the labels. Everything it draws
 * is selectable, draggable, deletable and undoable in Sketch, because to the page it is
 * just another board.
 *
 * Rules this file enforces, all of them in code rather than in prose to the model:
 *   - at most 40 boxes (a board that needs more is not a sketch, it is a diagram tool);
 *   - boxes are laid out in layers, left to right, so a flow reads in order;
 *   - connectors are orthogonal: horizontal, a short vertical jog, horizontal;
 *   - a follow-up APPENDS one box and one edge. The owner's board is never replaced:
 *     any board that already has content is added to, never overwritten;
 *   - no job, no drawing. The board belongs to a project, so there is something to
 *     come back to.
 *
 * The logical graph is not stored beside the marks; it is READ BACK from them
 * (`bzRole` on each mark). That way a person who drags a box in Sketch and saves has
 * not lost the graph: the geometry they chose is the geometry the next append uses.
 */

import type { Sql } from "@/lib/db";

export const MAX_BOARD_NODES = 40;

/** The page's own document, exactly as public/buzzy/sketch.html loads and saves it. */
export interface BoardDoc {
  version: number;
  w: number;
  h: number;
  bg: string;
  raster: string | null;
  strokes: Array<Record<string, unknown>>;
  images: Array<Record<string, unknown>>;
  order: Array<{ kind: string; id: string }>;
}

export const DRAW_BOARD_TOOL = {
  type: "function",
  function: {
    name: "draw_board",
    description:
      "Draw a diagram on this project's Sketch board: boxes joined by labelled arrows. " +
      "Use it ONLY when the owner explicitly asks for a diagram, flow chart, sketch, map " +
      "or funnel. Everything it draws is editable in Sketch afterwards. " +
      "First call: send every box and every connector. A follow-up call: send exactly one " +
      "box and one connector to add them to the board already there — never the whole " +
      "diagram again. At most 40 boxes. No images, no published file.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short name for the diagram (used in the project's source list)." },
        nodes: {
          type: "array",
          description: "The boxes, in reading order.",
          maxItems: MAX_BOARD_NODES,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short handle used by the connectors, e.g. visitors." },
              label: { type: "string", description: "The words in the box, e.g. visitors." },
              after: { type: "string", description: "Optional: the id of the box this one follows." },
            },
            required: ["label"],
          },
        },
        edges: {
          type: "array",
          description: "The connectors, as from/to pairs of box ids (or labels).",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              label: { type: "string", description: "Optional words on the arrow, e.g. 42%." },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["nodes"],
    },
  },
} as const;

// ── Geometry ─────────────────────────────────────────────────────────
// Big enough for three short lines of 15px text, close enough that a whole funnel fits
// one screen at 100%.
const BOX_W = 200;
const BOX_H = 76;
const GAP_X = 110;
const GAP_Y = 54;
const MARGIN = 40;
const STEP_X = BOX_W + GAP_X;
const STEP_Y = BOX_H + GAP_Y;
const BG = "#141414";
const BOX_STROKE = "#c9d1de";
const BOX_FILL = "#1d2635";
const LABEL = "#ffffff";
const LINK = "#8b95a7";
const LINK_LABEL = "#ffd40d";

type Stroke = Record<string, unknown>;
interface Node { key: string; label: string; boxId: string; x: number; y: number }
interface Edge { from: string; to: string; label?: string }

export interface DrawResult {
  ok: boolean;
  board?: BoardDoc;
  added?: { nodes: number; edges: number };
  total?: { nodes: number; edges: number };
  error?: string;
  errorCode?: string;
}

/** A stable, readable key from a label: "Email signup" → "email-signup". */
function slug(raw: unknown): string {
  const s = String(raw ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40) || "box";
}

/** A box's words, wrapped to fit 200px at 15px type. Three lines is the box. */
function lines(label: string): string[] {
  const words = String(label ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > 24 && line) { out.push(line); line = w; } else { line = next; }
  }
  if (line) out.push(line);
  const capped = out.slice(0, 3);
  if (out.length > 3) capped[2] = `${capped[2]!.slice(0, 21)}…`;
  return capped.length ? capped : ["box"];
}

function boxesFrom(strokes: Stroke[]): Node[] {
  const out: Node[] = [];
  for (const s of strokes) {
    if (s.bzRole !== "node" || typeof s.id !== "string") continue;
    const x = Number(s.x1);
    const y = Number(s.y1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ key: String(s.bzKey ?? ""), label: String(s.bzLabel ?? ""), boxId: s.id, x, y });
  }
  return out;
}

function edgesFrom(strokes: Stroke[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const s of strokes) {
    if (s.bzRole !== "edge") continue;
    const from = String(s.bzFrom ?? "");
    const to = String(s.bzTo ?? "");
    if (!from || !to || seen.has(`${from}->${to}`)) continue;
    seen.add(`${from}->${to}`);
    out.push({ from, to, ...(s.bzEdgeLabel ? { label: String(s.bzEdgeLabel) } : {}) });
  }
  return out;
}

function boxStrokes(n: Node): Stroke[] {
  const x1 = n.x, y1 = n.y, x2 = n.x + BOX_W, y2 = n.y + BOX_H;
  const text = lines(n.label);
  const size = 15;
  const lh = size * 1.3;
  const widest = text.reduce((m, l) => Math.max(m, l.length), 1);
  const textX = x1 + Math.max(12, (BOX_W - widest * size * 0.55) / 2);
  const textY = y1 + (BOX_H - text.length * lh) / 2 + 2;
  return [
    {
      id: n.boxId, bzRole: "node", bzKey: n.key, bzLabel: n.label,
      tool: "rect", x1, y1, x2, y2,
      width: 2, color: BOX_STROKE, fillColor: BOX_FILL, op: "both",
    },
    {
      id: `bz_t_${n.key}`, bzRole: "nodeLabel", bzFor: n.boxId,
      tool: "text", x1: textX, y1: textY,
      text: text.join("\n"), size, color: LABEL,
    },
  ];
}

/**
 * One connector. Orthogonal by construction: out of the right side of A, across, a
 * short vertical jog when the boxes are not level, and into the left side of B. The
 * label rides the longest segment (anchor=<mark id>), so dragging a box takes the
 * label with it instead of leaving it behind.
 */
function edgeStrokes(a: Node, b: Node, index: number, label?: string): Stroke[] {
  const id = `bz_e_${index}`;
  const common = { bzRole: "edge", bzFrom: a.key, bzTo: b.key, ...(label ? { bzEdgeLabel: label } : {}) };

  // Same column, different row: the connector goes down the page, not backwards
  // through a box (the layered layout puts a row of boxes in one column).
  const sameColumn = Math.abs(a.x - b.x) < 1;
  if (sameColumn) {
    const px = a.x + BOX_W / 2;
    const cx = b.x + BOX_W / 2;
    const py = a.y + BOX_H;
    const cy = b.y;
    if (Math.abs(px - cx) < 1) {
      const mark = { id, ...common, tool: "arrow", x1: px, y1: py, x2: cx, y2: cy, width: 2, color: LINK };
      return label ? [mark, labelStroke(`bz_l_${index}`, id, px + 8, (py + cy) / 2 - 8, label)] : [mark];
    }
    const midY = (py + cy) / 2;
    const run1 = { id: `${id}_a`, ...common, tool: "line", x1: px, y1: py, x2: px, y2: midY, width: 2, color: LINK };
    const run2 = { id: `${id}_b`, ...common, tool: "line", x1: px, y1: midY, x2: cx, y2: midY, width: 2, color: LINK };
    const head = { id: `${id}_c`, ...common, tool: "arrow", x1: cx, y1: midY, x2: cx, y2: cy, width: 2, color: LINK };
    const marks: Stroke[] = [run1, run2, head];
    if (label) marks.push(labelStroke(`bz_l_${index}`, run2.id, (px + cx) / 2 - label.length * 3.2, midY - 20, label));
    return marks;
  }

  // Left to right normally; right to left for a box a person dragged behind its parent.
  const toLeft = b.x + BOX_W <= a.x;
  const px = toLeft ? a.x : a.x + BOX_W;
  const cx = toLeft ? b.x + BOX_W : b.x;
  const py = a.y + BOX_H / 2;
  const cy = b.y + BOX_H / 2;

  if (Math.abs(py - cy) < 1) {
    const mark = { id, ...common, tool: "arrow", x1: px, y1: py, x2: cx, y2: cy, width: 2, color: LINK };
    return label ? [mark, labelStroke(`bz_l_${index}`, id, (px + cx) / 2 - label.length * 3.6, py - 20, label)] : [mark];
  }
  // Elbow: horizontal stub out of A, vertical run, horizontal arrow into B.
  const midX = (px + cx) / 2;
  const run1 = { id: `${id}_a`, ...common, tool: "line", x1: px, y1: py, x2: midX, y2: py, width: 2, color: LINK };
  const run2 = { id: `${id}_b`, ...common, tool: "line", x1: midX, y1: py, x2: midX, y2: cy, width: 2, color: LINK };
  const head = { id: `${id}_c`, ...common, tool: "arrow", x1: midX, y1: cy, x2: cx, y2: cy, width: 2, color: LINK };
  const marks: Stroke[] = [run1, run2, head];
  if (label) marks.push(labelStroke(`bz_l_${index}`, run2.id, midX + 8, (py + cy) / 2 - 8, label));
  return marks;
}

function labelStroke(id: string, anchor: string, x: number, y: number, text: string): Stroke {
  return {
    id, bzRole: "edgeLabel", bzFor: anchor, anchor,
    tool: "text", x1: x, y1: y,
    text: String(text).slice(0, 60), size: 13, color: LINK_LABEL, bg: BG,
  };
}

/** Longest-path layering, cycle-safe: a loop cannot make the columns run away. */
function layersOf(keys: string[], edges: Edge[]): Map<string, number> {
  const layer = new Map<string, number>(keys.map((k) => [k, 0]));
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!layer.has(e.from) || !layer.has(e.to)) continue;
      const want = Math.min(keys.length - 1, (layer.get(e.from) ?? 0) + 1);
      if (want > (layer.get(e.to) ?? 0)) { layer.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  return layer;
}

function normaliseBoard(raw: unknown): BoardDoc {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    version: 3,
    w: Number.isFinite(Number(b.w)) && Number(b.w) > 0 ? Number(b.w) : 0,
    h: Number.isFinite(Number(b.h)) && Number(b.h) > 0 ? Number(b.h) : 0,
    bg: typeof b.bg === "string" && b.bg ? b.bg : BG,
    raster: typeof b.raster === "string" ? b.raster : null,
    strokes: Array.isArray(b.strokes) ? (b.strokes as Stroke[]).filter((s) => s && typeof s === "object") : [],
    images: Array.isArray(b.images) ? (b.images as Array<Record<string, unknown>>) : [],
    order: Array.isArray(b.order) ? (b.order as Array<{ kind: string; id: string }>) : [],
  };
}

/** Is there anything on this board at all? A blank board is the only one we may replace. */
function isEmptyBoard(b: BoardDoc): boolean {
  return b.strokes.length === 0 && b.images.length === 0 && !b.raster;
}

function readArgs(args: unknown): { title: string; nodes: Array<{ key: string; label: string; after?: string }>; edges: Edge[] } | { error: string; code: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(a.nodes) ? (a.nodes as unknown[]) : [];
  const nodes: Array<{ key: string; label: string; after?: string }> = [];
  const taken = new Set<string>();
  for (const raw of rawNodes) {
    const n = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = String(n.label ?? "").trim().slice(0, 120);
    if (!label) continue;
    const key = slug(n.id || label);
    if (taken.has(key)) continue;
    taken.add(key);
    nodes.push({ key, label, ...(n.after ? { after: slug(n.after) } : {}) });
  }
  const edges: Edge[] = [];
  const rawEdges = Array.isArray(a.edges) ? (a.edges as unknown[]) : [];
  for (const raw of rawEdges) {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const from = e.from ? slug(e.from) : "";
    const to = e.to ? slug(e.to) : "";
    if (!from || !to || from === to) continue;
    const label = e.label ? String(e.label).trim().slice(0, 60) : undefined;
    edges.push({ from, to, ...(label ? { label } : {}) });
  }
  return { title: String(a.title ?? "").trim().slice(0, 120), nodes, edges };
}

/**
 * Build (or extend) the board for one draw_board call.
 *
 * `append` is not trusted: ANY board that already holds something is added to. A tool
 * call that forgot it was a follow-up must not wipe the owner's sketch.
 */
export function drawBoard(existing: unknown, args: unknown): DrawResult {
  const got = readArgs(args);
  if ("error" in got) return { ok: false, error: got.error, errorCode: got.code };

  const board = normaliseBoard(existing);
  const haveNodes = boxesFrom(board.strokes);
  const haveEdges = edgesFrom(board.strokes);
  const appending = !isEmptyBoard(board) || haveNodes.length > 0;

  if (!got.nodes.length && !(appending && got.edges.length)) {
    return { ok: false, errorCode: "nothing_to_add", error: "there is nothing to draw: send at least one box, with or without its connectors." };
  }

  if (appending) {
    if (got.nodes.length > 1) {
      return {
        ok: false,
        errorCode: "one_at_a_time",
        error: `a follow-up adds ONE box at a time and this asked for ${got.nodes.length}. Call draw_board again for the next box.`,
      };
    }
    if (got.edges.length > 1) {
      return {
        ok: false,
        errorCode: "one_at_a_time",
        error: `a follow-up adds ONE connector at a time and this asked for ${got.edges.length}. Call draw_board again for the next connector.`,
      };
    }
    if (!got.nodes.length && !got.edges.length) {
      return { ok: false, errorCode: "nothing_to_add", error: "this board already has a drawing, so a follow-up must add a box or a connector." };
    }
  }

  const keys = new Set<string>([...haveNodes.map((n) => n.key), ...got.nodes.map((n) => n.key)]);
  const totalNodes = keys.size;
  if (totalNodes > MAX_BOARD_NODES) {
    return {
      ok: false,
      errorCode: "too_many_boxes",
      error: `that is ${totalNodes} boxes and a sketch holds at most ${MAX_BOARD_NODES}. Split it into two boards.`,
    };
  }
  for (const e of [...haveEdges, ...got.edges]) {
    if (!keys.has(e.from) || !keys.has(e.to)) {
      return {
        ok: false,
        errorCode: "unknown_box",
        error: `a connector names "${!keys.has(e.from) ? e.from : e.to}", which is not one of the boxes: ${[...keys].join(", ")}.`,
      };
    }
  }

  // ── Appending: keep every existing mark, place the new box by the layout rule ──
  if (appending) {
    const originX = haveNodes.length ? Math.min(...haveNodes.map((n) => n.x)) : MARGIN;
    const originY = haveNodes.length ? Math.min(...haveNodes.map((n) => n.y)) : MARGIN;
    const layerOf = (n: Node) => Math.max(0, Math.round((n.x - originX) / STEP_X));
    const rowsAt = (layer: number) => haveNodes.filter((n) => layerOf(n) === layer).length;
    const strokes: Stroke[] = [...board.strokes];
    const added = { nodes: 0, edges: 0 };
    const newNodes: Node[] = [];

    for (const n of got.nodes) {
      const parent = n.after ? haveNodes.find((x) => x.key === n.after) : undefined;
      const layer = parent ? Math.min(MAX_BOARD_NODES - 1, layerOf(parent) + 1) : Math.max(0, ...haveNodes.map(layerOf)) + (haveNodes.length ? 1 : 0);
      const row = rowsAt(layer);
      const node: Node = { key: n.key, label: n.label, boxId: `bz_n_${n.key}`, x: originX + layer * STEP_X, y: originY + row * STEP_Y };
      strokes.push(...boxStrokes(node));
      newNodes.push(node);
      added.nodes += 1;
    }

    for (const e of got.edges) {
      if (haveEdges.some((x) => x.from === e.from && x.to === e.to)) continue;
      const a = [...haveNodes, ...newNodes].find((n) => n.key === e.from);
      const b = [...haveNodes, ...newNodes].find((n) => n.key === e.to);
      if (!a || !b) continue;
      // Number after every connector already on the board, so a deleted one cannot
      // leave a later append reusing its id (the page keys hit-testing on id).
      let next = 0;
      for (const s of strokes) {
        const m = /^bz_e_(\d+)$/.exec(String(s.id));
        if (m) next = Math.max(next, Number(m[1]) + 1);
      }
      strokes.push(...edgeStrokes(a, b, next, e.label));
      added.edges += 1;
    }

    const w = Math.max(board.w, ...strokes.flatMap((s) => [Number(s.x1) || 0, Number(s.x2) || 0]).map((x) => x + MARGIN));
    const h = Math.max(board.h, ...strokes.flatMap((s) => [Number(s.y1) || 0, Number(s.y2) || 0]).map((y) => y + MARGIN));
    return {
      ok: true,
      added,
      total: { nodes: [...haveNodes, ...newNodes].length, edges: haveEdges.length + added.edges },
      board: {
        ...board,
        w: Math.round(w),
        h: Math.round(h),
        strokes,
        order: [
          ...board.order.filter((o) => o && typeof o.id === "string"),
          ...strokes.slice(board.strokes.length).map((s) => ({ kind: "stroke", id: String(s.id) })),
        ],
      },
    };
  }

  // ── First drawing on a blank board: every box in its layer, connectors between ──
  const ordered = got.nodes;
  const layer = layersOf(ordered.map((n) => n.key), got.edges);
  const perLayer = new Map<number, number>();
  const placed: Node[] = ordered.map((n) => {
    const l = layer.get(n.key) ?? 0;
    const row = perLayer.get(l) ?? 0;
    perLayer.set(l, row + 1);
    return { key: n.key, label: n.label, boxId: `bz_n_${n.key}`, x: MARGIN + l * STEP_X, y: MARGIN + row * STEP_Y };
  });

  const strokes: Stroke[] = [];
  for (const n of placed) strokes.push(...boxStrokes(n));
  let drawn = 0;
  for (const e of got.edges) {
    const a = placed.find((n) => n.key === e.from);
    const b = placed.find((n) => n.key === e.to);
    if (!a || !b) continue;
    strokes.push(...edgeStrokes(a, b, drawn++, e.label));
  }

  const right = Math.max(...placed.map((n) => n.x + BOX_W));
  const bottom = Math.max(...placed.map((n) => n.y + BOX_H));
  return {
    ok: true,
    added: { nodes: placed.length, edges: drawn },
    total: { nodes: placed.length, edges: drawn },
    board: {
      version: 3,
      w: Math.round(right + MARGIN),
      h: Math.round(bottom + MARGIN),
      bg: board.bg || BG,
      raster: board.raster,
      strokes,
      images: board.images,
      order: strokes.map((s) => ({ kind: "stroke", id: String(s.id) })),
    },
  };
}

// ── Storage ──────────────────────────────────────────────────────────
// The board lives in the project row beside its brief (buzzy_jobs.data.board), which is
// where /api/buzzy/art reads and writes it. No new table: the sketch page is the owner's
// board, and this is that board.

export async function loadJobBoard(sql: Sql, userId: string, jobId: string): Promise<{ found: boolean; title: string; board: unknown }> {
  const rows = await sql`
    SELECT title, data FROM buzzy_jobs
    WHERE id = ${jobId} AND user_id = ${userId} LIMIT 1`;
  if (!rows.length) return { found: false, title: "", board: null };
  const row = rows[0] as { title: string | null; data: Record<string, unknown> | null };
  return { found: true, title: String(row.title ?? ""), board: row.data?.board ?? null };
}

export async function saveJobBoard(sql: Sql, userId: string, jobId: string, board: BoardDoc, label: string): Promise<boolean> {
  const source = {
    kind: "board",
    label,
    url: `/buzzy/sketch?job=${jobId}`,
    updatedAt: new Date().toISOString(),
  };
  const rows = await sql`
    UPDATE buzzy_jobs SET
      data = jsonb_set(
        jsonb_set(COALESCE(data, '{}'::jsonb), '{board}', ${JSON.stringify(board)}::jsonb, true),
        '{sources}',
        COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(COALESCE(data->'sources', '[]'::jsonb)) x
                  WHERE x->>'kind' <> 'board'), '[]'::jsonb) || ${JSON.stringify([source])}::jsonb,
        true),
      updated_at = now()
    WHERE id = ${jobId} AND user_id = ${userId}
    RETURNING id`;
  return rows.length > 0;
}
