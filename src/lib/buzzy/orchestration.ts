/**
 * Orchestration Builder — the authored spec and its one validator.
 *
 * CR-3. A flow-chart page at /buzzy/orchestrate whose output is text an agent
 * runs: Mermaid, this JSON spec, and a plain-English run sheet.
 *
 * The spec is the record. The buzzy_graph_nodes / buzzy_graph_edges rows are a
 * projection of it for the existing engine (graphs.ts), so anything the editor
 * knows lives here and nowhere else. `canonicalSpec` is what the server stores
 * and what the Mermaid comment carries; comparing two specs means comparing
 * their canonical JSON, never their objects (key order and float formatting
 * would make two identical graphs look different).
 *
 * Rules that came out of review (buzzygrok, 2026-11-17) and are enforced here:
 *   - ONE expression grammar for conditions, bindings and {{…}} in prompts.
 *   - A decision carries no config.condition: the condition is on its edges.
 *   - needsApproval is a runtime flag on agent/tool, never on start.
 *   - An approval node is a node type that projects to row kind "gate".
 *   - x/y are snapped to the grid on the way in, so the same drag is the same
 *     spec on every screen density.
 *   - Only the BLOCK codes stop a save. Warnings exist so a half-drawn flow is
 *     still savable and its problems are visible in the sidebar.
 *
 * The validator runs in the page (live) and on the server (POST) — the server
 * never trusts the client's copy.
 */

export const ORCH_SCHEMA = "beezilla/orchestration";
export const ORCH_SCHEMA_VERSION = 1;

export const NODE_TYPES = [
  "start",
  "agent",
  "tool",
  "decision",
  "parallel",
  "loop",
  "approval",
  "trigger",
  "subflow",
  "end",
  "note",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Legacy kinds in 0049's CHECK. New graphs never write these, old rows still load. */
export const LEGACY_NODE_TYPES = ["skill", "model", "review", "gate"] as const;

export type Port = "in" | "out" | "yes" | "no" | "body" | "back" | "exit" | "approved" | "rejected";

export interface OrchParam {
  name: string;
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface OrchNode {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  notes?: string;
  config: Record<string, unknown>;
}

export interface OrchEdgeEnd {
  node: string;
  port: Port;
}

export interface OrchEdge {
  id: string;
  from: OrchEdgeEnd;
  to: OrchEdgeEnd;
  label?: string;
  condition?: string | null;
}

export interface OrchPolicy {
  maxConcurrency?: number;
  budgetSec?: number;
  onError?: "stop" | "continue";
}

export interface OrchSpec {
  schema: typeof ORCH_SCHEMA;
  schemaVersion: number;
  id?: string;
  name: string;
  description?: string;
  direction: "TD" | "LR";
  grid: number;
  entry: string;
  params: OrchParam[];
  policy: OrchPolicy;
  nodes: OrchNode[];
  edges: OrchEdge[];
  meta: {
    createdAt?: string;
    updatedAt?: string;
    generator?: "human" | "talk" | "sketch" | "import";
    [key: string]: unknown;
  };
}

export type Severity = "error" | "warn";

export interface OrchIssue {
  code: string;
  severity: Severity;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidateResult {
  ok: boolean;
  spec: OrchSpec;
  issues: OrchIssue[];
}

const BLOCKING = new Set([
  "ORCH001", "ORCH002", "ORCH006", "ORCH007", "ORCH008", "ORCH009",
  "ORCH010", "ORCH011", "ORCH012", "ORCH013", "ORCH015", "ORCH017", "ORCH020",
]);

/** Direction-aware port contract. A port that is not here is not a port. */
export const PORTS: Record<NodeType, Port[]> = {
  start: ["out"],
  agent: ["in", "out"],
  tool: ["in", "out"],
  decision: ["in", "out"],
  parallel: ["in", "out"],
  loop: ["in", "body", "back", "exit"],
  approval: ["in", "approved", "rejected"],
  trigger: ["out"],
  subflow: ["in", "out"],
  end: ["in"],
  note: [],
};

const CONFIG_KEYS: Record<NodeType, string[]> = {
  start: [],
  agent: ["prompt", "agent", "model", "tools", "inputs", "output", "timeoutSec", "retries", "onError", "needsApproval"],
  tool: ["tool", "args", "inputs", "output", "timeoutSec", "retries", "onError", "needsApproval"],
  decision: [],
  parallel: ["mode", "join", "maxConcurrency", "output"],
  loop: ["until", "maxIterations"],
  approval: ["prompt", "approver", "timeoutSec", "onTimeout"],
  trigger: ["mode", "trigger"],
  subflow: ["ref", "inputs", "output"],
  end: ["outputs"],
  note: ["text"],
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};

export const snap = (value: number, grid: number): number => Math.round(value / grid) * grid;

/** Deep-sorted JSON. x/y rounded to 0.1 is only needed because a browser drag can
 *  carry 16.000000000000004; it must not round a score of 0.85 in a condition. */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined) continue;
      out[k] = k === "x" || k === "y"
        ? Math.round(Number(value[k]) * 10) / 10
        : canonicalise(value[k]);
    }
    return out;
  }
  return value;
}

export function canonicalSpec(spec: OrchSpec): string {
  return JSON.stringify(canonicalise(spec));
}

// ── expression grammar ────────────────────────────────────────────────
// binding := "$" path ("." key)* | "\$" literal dollar
// expr    := or ; or := and ("||" and)* ; and := cmp ("&&" cmp)*
// cmp     := unary (("=="|"!="|">"|">="|"<"|"<="|"in") unary)?
// unary   := "!" unary | primary ; primary := literal | binding | "(" expr ")"

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "ref"; v: string }
  | { t: "op"; v: string }
  | { t: "eof" };

function tokenise(src: string): Tok[] | { error: string } {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== q) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) return { error: `unterminated string at ${i}` };
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (c === "$") {
      let j = i + 1, s = "";
      while (j < src.length && /[A-Za-z0-9_.[\]]/.test(src[j]!)) s += src[j++];
      const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+|\[\d+\])+)$/.exec(s);
      if (!m) return { error: `bad binding "$${s}"` };
      out.push({ t: "ref", v: s });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] || ""))) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(three)) {
      out.push({ t: "op", v: three }); i += 2; continue;
    }
    if (["!", ">", "<", "(", ")"].includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    return { error: `unexpected character "${c}" at ${i}` };
  }
  out.push({ t: "eof" });
  return out;
}

export interface ParsedExpr {
  ok: boolean;
  error?: string;
  refs: string[];
}

export function parseExpression(src: string): ParsedExpr {
  const toks = tokenise(src);
  if ("error" in toks) return { ok: false, error: toks.error, refs: [] };
  let p = 0;
  const refs: string[] = [];
  const peek = (): Tok => toks[Math.min(p, toks.length - 1)]!;
  const eat = (v: string) => {
    const t = peek();
    if ((t.t === "op" && t.v === v) || (t.t === "id" && t.v === v)) { p++; return true; }
    return false;
  };
  let error: string | undefined;

  const primary = (): void => {
    const t = peek();
    if (t.t === "num" || t.t === "str") { p++; return; }
    if (t.t === "ref") { refs.push(t.v); p++; return; }
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false" || t.v === "null") { p++; return; }
      error = error || `unknown word "${t.v}" — bindings start with $`;
      p++;
      return;
    }
    if (eat("(")) {
      expr();
      if (!eat(")")) error = error || "missing )";
      return;
    }
    error = error || `expected a value at token ${p}`;
    p++;
  };
  const unary = (): void => {
    if (eat("!")) { unary(); return; }
    primary();
  };
  const cmp = (): void => {
    unary();
    const t = peek();
    if ((t.t === "op" && [">", ">=", "<", "<=", "==", "!="].includes(t.v)) || (t.t === "id" && t.v === "in")) {
      p++; unary();
    }
  };
  const and = (): void => { cmp(); while (eat("&&")) cmp(); };
  const expr = (): void => { and(); while (eat("||")) and(); };

  expr();
  if (!error && peek().t !== "eof") error = `unexpected token at ${p}`;
  return { ok: !error, error, refs };
}

/** Every "." path in a binding is allowed as property access; the root is what
 *  must exist (a declared param or a node's declared output). */
function rootOf(ref: string): { kind: "input"; name: string } | { kind: "node"; node: string; out: string } | { kind: "loop" } | null {
  const parts = ref.split(".");
  if (parts[0] === "input" && parts.length >= 2) return { kind: "input", name: parts[1]! };
  if (parts[0] === "loop") return { kind: "loop" };
  if (parts.length >= 2) {
    // $n_x.items[0].name — the declared output is the first segment, without an index.
    const out = parts[1]!.replace(/\[\d+\]$/, "");
    return { kind: "node", node: parts[0]!, out };
  }
  return null;
}

function interpolations(s: string): string[] {
  const out: string[] = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1]!.trim());
  return out;
}

// ── validator ─────────────────────────────────────────────────────────

function emptySpec(): OrchSpec {
  return {
    schema: ORCH_SCHEMA,
    schemaVersion: ORCH_SCHEMA_VERSION,
    name: "Untitled orchestration",
    direction: "TD",
    grid: 16,
    entry: "",
    params: [],
    policy: { maxConcurrency: 4, budgetSec: 900, onError: "stop" },
    nodes: [],
    edges: [],
    meta: {},
  };
}

export function validateOrchestration(input: unknown): ValidateResult {
  const issues: OrchIssue[] = [];
  const add = (code: string, severity: Severity, message: string, nodeId?: string, edgeId?: string) =>
    issues.push({ code, severity, message, nodeId, edgeId });

  if (!isObj(input)) {
    add("ORCH015", "error", "Send a spec object.");
    return { ok: false, spec: emptySpec(), issues };
  }

  if (input.schema !== ORCH_SCHEMA) add("ORCH015", "error", `schema must be "${ORCH_SCHEMA}".`);
  if (input.schemaVersion !== ORCH_SCHEMA_VERSION) {
    add("ORCH015", "error", `schemaVersion must be ${ORCH_SCHEMA_VERSION}.`);
  }

  const name = str(input.name).trim().slice(0, 160);
  if (!name) add("ORCH015", "error", "The orchestration needs a name.");

  const direction = input.direction === "LR" ? "LR" : "TD";
  const grid = int(input.grid, 4, 64) ?? 16;

  // params
  const params: OrchParam[] = [];
  const paramNames = new Set<string>();
  for (const raw of Array.isArray(input.params) ? input.params : []) {
    if (!isObj(raw)) { add("ORCH015", "error", "Every param must be an object."); continue; }
    const pname = str(raw.name).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pname)) {
      add("ORCH015", "error", `Param name "${pname}" is not an identifier.`);
      continue;
    }
    if (paramNames.has(pname)) add("ORCH007", "error", `Two params are named "${pname}".`);
    paramNames.add(pname);
    const type = ["string", "number", "boolean", "object", "array"].includes(str(raw.type))
      ? (str(raw.type) as OrchParam["type"])
      : "string";
    params.push({
      name: pname,
      type,
      required: raw.required === true,
      default: raw.default ?? null,
      ...(str(raw.description) ? { description: str(raw.description).slice(0, 300) } : {}),
    });
  }

  // nodes — normalise first, validate second, so an issue can name the id it saw
  const nodes: OrchNode[] = [];
  const byId = new Map<string, OrchNode>();
  const declared = new Map<string, Set<string>>();
  // Binding resolution needs every node's declared output, so calls made while the
  // nodes are being normalised are collected and replayed after the loop.
  const pending: Array<{ ref: string; at: string }> = [];
  function checkBinding(ref: string, at: string): void {
    // Callers pass the written form ("$n_res.findings"); the parser's refs are bare.
    pending.push({ ref: ref.replace(/^\$/, ""), at });
  }
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (rawNodes.length === 0) add("ORCH015", "error", "A spec needs at least one node.");
  if (rawNodes.length > 200) add("ORCH015", "error", "The node limit is 200.");

  for (const raw of rawNodes) {
    if (!isObj(raw)) { add("ORCH015", "error", "Every node must be an object."); continue; }
    const id = str(raw.id).trim();
    const type = raw.type as NodeType;
    if (!/^n_[A-Za-z0-9_]+$/.test(id)) {
      add("ORCH015", "error", `Node id "${id}" must match n_[A-Za-z0-9_]+.`);
      continue;
    }
    if (byId.has(id)) { add("ORCH007", "error", `Two nodes use the id "${id}".`, id); continue; }
    if (!NODE_TYPES.includes(type)) {
      add("ORCH015", "error", `"${id}" has unknown type "${String(raw.type)}".`, id);
      continue;
    }
    const config = isObj(raw.config) ? raw.config : {};
    const allowed = new Set(CONFIG_KEYS[type]);
    for (const k of Object.keys(config)) {
      if (!allowed.has(k)) add("ORCH015", "error", `"${id}" (${type}) has unknown config key "${k}".`, id);
    }
    // Keep the keys the type owns, so an unknown key is reported rather than silently
    // dropped, and a known one survives the save (validateGraph used to lose ports).
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if (k in config) clean[k] = config[k];
    const node: OrchNode = {
      id,
      type,
      name: str(raw.name).trim().slice(0, 160) || type,
      x: snap(num(raw.x) ?? 0, grid),
      y: snap(num(raw.y) ?? 0, grid),
      notes: str(raw.notes).slice(0, 2000),
      config: clean,
    };

    // per-type required fields
    const c = config;
    const needText = (key: string, code = "ORCH010") => {
      const v = str(c[key]).trim();
      if (!v) add(code, "error", `"${id}" needs ${key}.`, id);
      return v;
    };
    switch (type) {
      case "agent":
        needText("prompt");
        break;
      case "tool":
        needText("tool");
        break;
      case "decision":
        if ("condition" in c) add("ORCH015", "error", `"${id}" is a decision: put the condition on its edges, not in config.`, id);
        break;
      case "parallel": {
        const mode = str(c.mode);
        if (mode !== "fan-out" && mode !== "join") add("ORCH017", "error", `"${id}" needs mode "fan-out" or "join".`, id);
        if (mode === "join" && !["all", "any", "first"].includes(str(c.join) || "all")) {
          add("ORCH017", "error", `"${id}" join must be all, any or first.`, id);
        }
        break;
      }
      case "loop": {
        const until = needText("until");
        if (until) {
          const parsed = parseExpression(until);
          if (!parsed.ok) add("ORCH016", "warn", `"${id}" until does not parse: ${parsed.error}`, id);
        }
        const max = int(c.maxIterations, 1, 50);
        if (max === undefined) add("ORCH017", "error", `"${id}" needs maxIterations 1..50.`, id);
        break;
      }
      case "approval":
        needText("prompt");
        if (str(c.approver) && !["owner", "ops"].includes(str(c.approver))) {
          add("ORCH017", "error", `"${id}" approver must be owner or ops.`, id);
        }
        if (str(c.onTimeout) && !["stop", "reject"].includes(str(c.onTimeout))) {
          add("ORCH017", "error", `"${id}" onTimeout must be stop or reject.`, id);
        }
        break;
      case "trigger": {
        const mode = str(c.mode) || "wait";
        if (!["entry", "wait"].includes(mode)) add("ORCH017", "error", `"${id}" trigger mode must be entry or wait.`, id);
        const trig = isObj(c.trigger) ? c.trigger : null;
        if (!trig) add("ORCH017", "error", `"${id}" needs a trigger object.`, id);
        else {
          const kind = str(trig.kind);
          if (!["schedule", "webhook", "event"].includes(kind)) {
            add("ORCH017", "error", `"${id}" trigger.kind must be schedule, webhook or event.`, id);
          }
          if (kind === "schedule" && !str(trig.schedule)) add("ORCH017", "error", `"${id}" needs a cron schedule.`, id);
          if (kind === "webhook" && !str(trig.webhook)) add("ORCH017", "error", `"${id}" needs a webhook path.`, id);
          if (kind === "event" && !str(trig.event)) add("ORCH017", "error", `"${id}" needs an event name.`, id);
        }
        break;
      }
      case "subflow": {
        const ref = isObj(c.ref) ? c.ref : null;
        if (!ref || !str(ref.graphId)) {
          add("ORCH014", "warn", `"${id}" has no subflow ref.`, id);
        }
        break;
      }
      case "end": {
        const outs = isObj(c.outputs) ? c.outputs : null;
        if (!outs) add("ORCH017", "error", `"${id}" needs outputs (an object, possibly empty).`, id);
        break;
      }
      case "note":
        needText("text", "ORCH017");
        break;
    }

    // output declaration (a fan-out has none; a join produces the combined result)
    if (type === "agent" || type === "tool" || type === "subflow" || (type === "parallel" && str(c.mode) === "join")) {
      const out = isObj(c.output) ? c.output : null;
      const oname = out ? str(out.name).trim() : "";
      if (out && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(oname)) {
        add("ORCH013", "error", `"${id}" output name "${oname}" is not an identifier.`, id);
      } else if (out && oname) {
        if (declared.has(id)) add("ORCH013", "error", `"${id}" declares more than one output.`, id);
        declared.set(id, new Set([oname]));
      }
    }
    // binding fields
    for (const key of ["inputs", "args"] as const) {
      if (!isObj(c[key])) continue;
      for (const [k, v] of Object.entries(c[key] as Record<string, unknown>)) {
        if (typeof v !== "string") { add("ORCH015", "error", `"${id}" ${key}.${k} must be a string binding.`, id); continue; }
        if (v.startsWith("$")) checkBinding(v, id);
      }
    }
    // end outputs are bindings, not declarations; their keys must be unique by JSON.
    if (type === "end" && isObj(c.outputs)) {
      for (const [k, v] of Object.entries(c.outputs)) {
        if (typeof v !== "string" || !v.startsWith("$")) {
          add("ORCH015", "error", `"${id}" outputs.${k} must be a $binding.`, id);
        } else checkBinding(v, id);
      }
    }
    // prompts and other prose: {{ expr }} is an expression
    for (const key of ["prompt", "until"] as const) {
      const text = str(c[key]);
      for (const inner of interpolations(text)) {
        const parsed = parseExpression(inner);
        if (!parsed.ok) add("ORCH016", "warn", `"${id}" ${key} expression "${inner}" does not parse: ${parsed.error}`, id);
        for (const ref of parsed.refs) checkBinding(ref, id);
      }
    }

    nodes.push(node);
    byId.set(id, node);
  }

  // edges
  const edges: OrchEdge[] = [];
  const edgeIds = new Set<string>();
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  for (const raw of rawEdges) {
    if (!isObj(raw)) { add("ORCH015", "error", "Every edge must be an object."); continue; }
    const from = isObj(raw.from) ? raw.from : null;
    const to = isObj(raw.to) ? raw.to : null;
    const fromNode = from ? str(from.node) : "";
    const toNode = to ? str(to.node) : "";
    const fromPort = (from ? str(from.port) : "out") as Port;
    const toPort = (to ? str(to.port) : "in") as Port;
    const id = str(raw.id).trim() || `e_${edges.length + 1}`;
    if (edgeIds.has(id)) { add("ORCH008", "error", `Two edges use the id "${id}".`, undefined, id); continue; }
    edgeIds.add(id);
    const a = byId.get(fromNode), b = byId.get(toNode);
    if (!a || !b) {
      add("ORCH008", "error", `Edge ${fromNode || "?"} -> ${toNode || "?"} points at a node that does not exist.`, undefined, id);
      continue;
    }
    // An unknown port is not a warning: the edge cannot be routed at all, so it
    // blocks the save (one rule, one severity). Direction comes from PORTS.
    if (!PORTS[a.type].includes(fromPort)) {
      add("ORCH009", "error", `Edge from "${a.id}" uses port "${fromPort}", which a ${a.type} does not have.`, a.id, id);
    }
    if (!PORTS[b.type].includes(toPort)) {
      add("ORCH009", "error", `Edge into "${b.id}" uses port "${toPort}", which a ${b.type} does not have.`, b.id, id);
    }
    if (a.type === "note" || b.type === "note") {
      add("ORCH012", "error", `A note is a comment and cannot be connected ("${a.type === "note" ? a.id : b.id}").`, a.type === "note" ? a.id : b.id, id);
    }
    if (a.type === "end") add("ORCH018", "warn", `"${a.id}" is an end but has an outgoing edge.`, a.id, id);
    if (b.type === "start") add("ORCH018", "warn", `"${b.id}" is a start but has an incoming edge.`, b.id, id);
    const condition = raw.condition === null || raw.condition === undefined ? null : str(raw.condition).trim();
    if (condition) {
      const parsed = parseExpression(condition);
      if (!parsed.ok) add("ORCH016", "warn", `Condition on ${id} does not parse: ${parsed.error}`, undefined, id);
      for (const ref of parsed.refs) pending.push({ ref, at: `edge ${id}` });
    }
    if ((raw.label ?? "") !== "" && typeof raw.label !== "string") {
      add("ORCH015", "error", `Edge ${id} label must be text.`, undefined, id);
    }
    edges.push({
      id,
      from: { node: fromNode, port: fromPort },
      to: { node: toNode, port: toPort },
      label: str(raw.label).slice(0, 160),
      condition,
    });
  }

  // bindings
  for (const { ref, at } of pending) {
    const root = rootOf(ref);
    if (!root) {
      add("ORCH006", "error", `"${ref}" in ${at} is not a binding.`, undefined);
      continue;
    }
    if (root.kind === "input") {
      if (!paramNames.has(root.name)) add("ORCH006", "error", `${at} reads $input.${root.name}, which is not a param.`);
    } else if (root.kind === "node") {
      if (!byId.has(root.node)) add("ORCH006", "error", `${at} reads $${root.node}.${root.out}, but there is no node "${root.node}".`);
      else if (!declared.get(root.node)?.has(root.out)) {
        add("ORCH006", "error", `${at} reads $${root.node}.${root.out}, but "${root.node}" declares no output "${root.out}".`);
      }
    }
    // loop.index / loop.item are only meaningful in a loop body; enforce lightly
    if (root.kind === "loop" && !nodes.some((n) => n.type === "loop")) {
      add("ORCH006", "error", `${at} reads $loop.* but the graph has no loop node.`);
    }
  }

  // start / end
  const starts = nodes.filter((n) => n.type === "start");
  const entryTriggers = nodes.filter((n) => n.type === "trigger" && str(n.config.mode) === "entry");
  if (starts.length + entryTriggers.length === 0) add("ORCH001", "error", "No start node (or trigger in entry mode).");
  if (starts.length > 1) add("ORCH001", "error", "More than one start node.");
  const ends = nodes.filter((n) => n.type === "end");
  if (ends.length === 0) add("ORCH002", "error", "No end node.");

  const entry = str(input.entry).trim() || starts[0]?.id || entryTriggers[0]?.id || "";
  if (entry && !byId.has(entry)) add("ORCH001", "error", `entry "${entry}" is not a node.`, entry);
  if (!entry && (starts.length || entryTriggers.length)) add("ORCH001", "error", "Choose an entry node.");

  // adjacency + reachability (a loop back edge is not a forward step)
  const forward = new Map<string, string[]>();
  for (const n of nodes) forward.set(n.id, []);
  for (const e of edges) {
    if (e.to.port === "back") continue;
    forward.get(e.from.node)?.push(e.to.node);
  }
  if (entry) {
    const seen = new Set<string>([entry]);
    const q = [entry];
    while (q.length) {
      const at = q.shift()!;
      for (const to of forward.get(at) || []) if (!seen.has(to)) { seen.add(to); q.push(to); }
    }
    for (const n of nodes) {
      if (n.type === "note") continue;
      if (!seen.has(n.id)) add("ORCH003", "warn", `"${n.name}" (${n.id}) cannot be reached from the entry.`, n.id);
    }
  }

  // decision: exactly one else edge, at the end, at least two outgoing
  for (const n of nodes.filter((x) => x.type === "decision")) {
    const outs = edges.filter((e) => e.from.node === n.id);
    if (outs.length < 2) add("ORCH004", "warn", `Decision "${n.name}" has ${outs.length} outgoing edge(s); it needs a branch and an else.`, n.id);
    const elseEdges = outs.filter((e) => !e.condition);
    if (elseEdges.length === 0) add("ORCH004", "warn", `Decision "${n.name}" has no else edge (one outgoing edge with no condition).`, n.id);
    if (elseEdges.length > 1) add("ORCH004", "warn", `Decision "${n.name}" has ${elseEdges.length} else edges; only one may have no condition.`, n.id);
  }

  // loop: body in, exit out
  for (const n of nodes.filter((x) => x.type === "loop")) {
    const outs = edges.filter((e) => e.from.node === n.id);
    if (!outs.some((e) => e.from.port === "body")) add("ORCH005", "warn", `Loop "${n.name}" has no body edge.`, n.id);
    if (!outs.some((e) => e.from.port === "exit")) add("ORCH005", "warn", `Loop "${n.name}" has no exit edge, so it never leaves.`, n.id);
  }

  // fan-out should meet a join (warn, not block)
  for (const n of nodes.filter((x) => x.type === "parallel" && str(x.config.mode) === "fan-out")) {
    const outs = edges.filter((e) => e.from.node === n.id);
    if (outs.length < 2) add("ORCH019", "warn", `Fan-out "${n.name}" has ${outs.length} outgoing edge(s); fan-out needs at least two.`, n.id);
  }

  // cycles: only a loop's back port may close one. Remove those edges and any
  // cycle that remains is illegal, which is stronger (and simpler) than asking
  // whether a cycle happens to contain a back edge.
  const cycles = findCycles(nodes.map((n) => n.id), edges.filter((e) => e.to.port !== "back"));
  for (const cyc of cycles) {
    add("ORCH011", "error", `Cycle ${cyc.join(" -> ")} does not return through a loop's back port.`, cyc[0]);
  }

  // subflow refs pointing at this orchestration (self-reference)
  for (const n of nodes.filter((x) => x.type === "subflow")) {
    const ref = isObj(n.config.ref) ? n.config.ref : null;
    if (ref && str(ref.graphId) === name) add("ORCH020", "error", `"${n.name}" references this orchestration.`, n.id);
  }

  const spec: OrchSpec = {
    schema: ORCH_SCHEMA,
    schemaVersion: ORCH_SCHEMA_VERSION,
    ...(input.id ? { id: str(input.id).slice(0, 80) } : {}),
    name,
    description: str(input.description).slice(0, 2000),
    direction,
    grid,
    entry,
    params,
    policy: {
      maxConcurrency: int(isObj(input.policy) ? input.policy.maxConcurrency : undefined, 1, 16) ?? 4,
      budgetSec: int(isObj(input.policy) ? input.policy.budgetSec : undefined, 1, 86400) ?? 900,
      onError: isObj(input.policy) && input.policy.onError === "continue" ? "continue" : "stop",
    },
    nodes,
    edges,
    meta: (isObj(input.meta) ? { ...input.meta } : {}) as OrchSpec["meta"],
  };

  const ok = !issues.some((i) => i.severity === "error" && BLOCKING.has(i.code));
  return { ok, spec, issues };
}

/** Tarjan SCCs, ignoring the loop back port at the caller. Returns components of size >1
 *  plus self-loops, which is exactly the definition a "cycle" check needs. */
function findCycles(ids: string[], edges: OrchEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) adj.get(e.from.node)?.push(e.to.node);
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], out: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp);
      else if ((adj.get(v) || []).includes(v)) out.push(comp);
    }
  };
  for (const id of ids) if (!idx.has(id)) strong(id);
  return out;
}

// ── projections: Mermaid, run sheet ──────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** base64url for the browser and Node, without Buffer or btoa assumptions. */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? "" : B64[(n >> 6) & 63]!) + (c === undefined ? "" : B64[n & 63]!);
  }
  return out;
}

export function fromBase64Url(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9_-]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 0, 0, 0].map((_, k) => B64.indexOf(clean[i + k] ?? ""));
    const n = ((c[0]! << 18) | (c[1]! << 12) | ((c[2]! & 63) << 6) | (c[3]! & 63)) >>> 0;
    bytes.push((n >> 16) & 255);
    if (i + 2 < clean.length) bytes.push((n >> 8) & 255);
    if (i + 3 < clean.length) bytes.push(n & 255);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function mermaidText(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/\n/g, "<br/>").replace(/\|/g, "#124;");
}

function shapeFor(n: OrchNode): [string, string] {
  const label = mermaidText(n.name || n.id);
  switch (n.type) {
    case "start":
    case "end": return ["([", "])"];
    case "agent": return ["[", "]"];
    case "tool": return ["[[", "]]"];
    case "decision": return ["{", "}"];
    case "parallel": return str(n.config.mode) === "join" ? ["(((", ")))"] : ["((", "))"];
    case "loop": return [">", "]"];
    case "approval": return ["{{", "}}"];
    case "trigger": return ["[/", "/]"];
    case "subflow": return ["[(", ")]"];
    case "note": return ["[", "]"];
  }
}

export function toMermaid(spec: OrchSpec): string {
  const dir = spec.direction === "LR" ? "LR" : "TD";
  const canon = canonicalSpec(spec);
  const b64 = toBase64Url(canon);
  const wrapped: string[] = [];
  for (let i = 0; i < b64.length; i += 120) wrapped.push(`%% spec: ${b64.slice(i, i + 120)}`);
  const lines: string[] = [
    "%% beezilla-orchestration v1",
    ...wrapped,
    `flowchart ${dir}`,
  ];
  for (const n of spec.nodes) {
    if (n.type === "note") {
      lines.push(`  %% note ${n.id}: ${mermaidText(str(n.config.text)).replace(/\n/g, " ")}`);
      continue;
    }
    const [open, close] = shapeFor(n);
    lines.push(`  ${n.id}${open}"${mermaidText(n.name || n.id)}"${close}`);
  }
  for (const e of spec.edges) {
    const label = e.label || e.condition || "";
    lines.push(`  ${e.from.node} -->${label ? `|${mermaidText(label)}|` : ""} ${e.to.node}`);
  }
  return lines.join("\n") + "\n";
}

export function fromMermaid(text: string): { ok: true; spec: OrchSpec } | { ok: false; error: string } {
  const specLines = text.split(/\r?\n/).filter((l) => /^%%\s*spec:/.test(l));
  if (specLines.length) {
    const b64 = specLines.map((l) => l.replace(/^%%\s*spec:\s*/, "")).join("");
    try {
      const parsed = JSON.parse(fromBase64Url(b64));
      const v = validateOrchestration(parsed);
      return v.ok ? { ok: true, spec: v.spec } : { ok: false, error: "The embedded spec does not validate." };
    } catch {
      return { ok: false, error: "The embedded spec is not readable base64 JSON." };
    }
  }
  return { ok: false, error: "No %% spec: line. Topology-only import lands in PR2, per the plan." };
}

export function toYaml(spec: OrchSpec): string {
  // JSON is valid YAML; a real pretty-printer is PR2. Keeping the exact canonical
  // bytes means pasting the YAML back cannot lose a field.
  return canonicalSpec(spec);
}

export interface RunStep {
  n: number;
  nodeId: string;
  text: string;
}

export function toRunSheet(spec: OrchSpec): string {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const outs = new Map<string, OrchEdge[]>();
  for (const n of spec.nodes) outs.set(n.id, []);
  for (const e of spec.edges) {
    if (e.to.port === "back") continue;
    outs.get(e.from.node)?.push(e);
  }
  const steps: RunStep[] = [];
  const seen = new Map<string, number>();
  const visit = (id: string): void => {
    const n = byId.get(id);
    if (!n || steps.length > 200) return;
    if (seen.has(id)) {
      steps.push({ n: steps.length + 1, nodeId: id, text: `Go back to step ${seen.get(id)} ("${n.name}").` });
      return;
    }
    const stepNo = steps.length + 1;
    seen.set(id, stepNo);
    steps.push({ n: stepNo, nodeId: id, text: describe(n, outs.get(id) || [], byId) });
    const next = outs.get(id) || [];
    if (n.type === "decision") {
      const branches = next.filter((e) => e.condition);
      const els = next.find((e) => !e.condition);
      // All the branch lines first, then walk them: reading "if yes… otherwise…"
      // together is what makes the sheet a decision and not two unrelated steps.
      for (const b of branches) {
        steps.push({
          n: steps.length + 1, nodeId: b.to.node,
          text: `If ${b.condition}, go to ${label(b.to.node, byId)}${b.label ? ` (${b.label})` : ""}.`,
        });
      }
      if (els) steps.push({ n: steps.length + 1, nodeId: els.to.node, text: `Otherwise go to ${label(els.to.node, byId)}.` });
      for (const b of branches) if (byId.get(b.to.node)?.type !== "end") visit(b.to.node);
      if (els && byId.get(els.to.node)?.type !== "end") visit(els.to.node);
      return;
    }
    if (n.type === "parallel" && str(n.config.mode) === "fan-out") {
      for (const e of next) visit(e.to.node);
      return;
    }
    for (const e of next) visit(e.to.node);
  };
  if (spec.entry) visit(spec.entry);
  return [
    `RUN SHEET — ${spec.name}`,
    spec.description ? spec.description : "",
    spec.params.length
      ? `Inputs: ${spec.params.map((p) => `${p.name}${p.required ? " (required)" : ""}: ${p.type || "string"}`).join("; ")}`
      : "Inputs: none.",
    "",
    ...steps.map((s) => `${s.n}. ${s.text}`),
  ].filter(Boolean).join("\n");
}

function label(id: string, byId: Map<string, OrchNode>): string {
  const n = byId.get(id);
  return n ? `"${n.name}"` : id;
}

function describe(n: OrchNode, outs: OrchEdge[], byId: Map<string, OrchNode>): string {
  const c = n.config;
  switch (n.type) {
    case "start":
      return `Start${outs.length ? `, then go to ${label(outs[0]!.to.node, byId)}` : ""}.`;
    case "agent": {
      const tools = Array.isArray(c.tools) && c.tools.length ? ` Tools: ${(c.tools as unknown[]).join(", ")}.` : "";
      const model = str(c.model) ? ` Model: ${str(c.model)}.` : "";
      return `Agent "${n.name}"${model}: ${str(c.prompt)}${tools}`;
    }
    case "tool":
      return `Call tool "${str(c.tool)}"${isObj(c.args) && Object.keys(c.args).length ? ` with ${JSON.stringify(c.args)}` : ""}, then go to ${outs.map((e) => label(e.to.node, byId)).join(" or ") || "end"}.`;
    case "parallel":
      return str(c.mode) === "join"
        ? `Wait for ${str(c.join) || "all"} of the parallel branches to finish (${n.name}).`
        : `Run in parallel${int(c.maxConcurrency, 1, 16) ? ` (max ${int(c.maxConcurrency, 1, 16)})` : ""}: ${outs.map((e) => label(e.to.node, byId)).join(", ")}.`;
    case "loop":
      return `Loop "${n.name}": run the body, then repeat until ${str(c.until)}; max ${int(c.maxIterations, 1, 50) ?? 1} iteration(s).`;
    case "approval":
      return `Stop for approval from ${str(c.approver) || "the owner"}: ${str(c.prompt)}`;
    case "trigger": {
      const t = isObj(c.trigger) ? c.trigger : {};
      return `Trigger (${str(c.mode) || "wait"}) on ${str(t.kind)}${str(t.schedule) ? ` ${str(t.schedule)}` : ""}${str(t.webhook) ? ` ${str(t.webhook)}` : ""}${str(t.event) ? ` ${str(t.event)}` : ""}.`;
    }
    case "subflow":
      return `Run sub-orchestration ${str(isObj(c.ref) ? c.ref.graphId : "")} ("${n.name}").`;
    case "end":
      return `End. Return ${isObj(c.outputs) && Object.keys(c.outputs).length ? JSON.stringify(c.outputs) : "no outputs"}.`;
    case "decision":
      return `Decide "${n.name}".`;
    case "note":
      return `Note: ${str(c.text)}`;
  }
}

/** Project a spec into the legacy row shapes graphs.ts writes. The spec stays the
 *  record; this exists only so an authored graph is visible to the old engine. */
export function toGraphRows(spec: OrchSpec): {
  nodes: Array<{ key: string; kind: string; title: string; config: Record<string, unknown>; x: number; y: number }>;
  edges: Array<{ from: string; to: string; kind: string }>;
} {
  return {
    nodes: spec.nodes.map((n) => ({
      key: n.id,
      // The approval node is the product's gate (buzzygrok 6675); everything else
      // keeps its own type now that 0063 widened the CHECK.
      kind: n.type === "approval" ? "gate" : n.type,
      title: n.name,
      config: { ...n.config, orchType: n.type, orchConfig: n.config },
      x: n.x,
      y: n.y,
    })),
    edges: spec.edges.map((e) => ({
      from: e.from.node,
      to: e.to.node,
      kind: e.to.port === "approved" || e.to.port === "rejected" ? "gate" : "data",
    })),
  };
}

/** Parse the graph detail routes the API exposes. One helper, because a route that
 *  parses its own path by index is how CR-3 shipped a revisions list nobody could
 *  reach (the branch tested the literal "revisions" segment instead of the number
 *  after it). Returns null when the path is not a graph detail route.
 *
 *  "/api/buzzy/graphs/g1"             -> { graphId: "g1", revision: null }
 *  "/api/buzzy/graphs/g1/revisions"   -> { graphId: "g1", revision: null }
 *  "/api/buzzy/graphs/g1/revisions/2" -> { graphId: "g1", revision: 2 }
 *
 *  A non-numeric or zero revision is not silently coerced: it yields revision: null
 *  with the raw segment in `bad`, so the caller can answer 400 rather than list.
 */
export function parseGraphDetailPath(
  path: string,
): { graphId: string; revision: number | null; bad?: string } | null {
  const m = /^\/api\/buzzy\/graphs\/([A-Za-z0-9_-]+)(?:\/revisions(?:\/([^/]+))?)?$/.exec(path);
  if (!m) return null;
  const graphId = m[1]!;
  const raw = m[2];
  if (raw === undefined) return { graphId, revision: null };
  if (!/^[0-9]+$/.test(raw)) return { graphId, revision: null, bad: raw };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { graphId, revision: null, bad: raw };
  return { graphId, revision: n };
}

// ── The Idea Board ⇄ the spec ─────────────────────────────────────────
//
// Owner, 2026-11-24: "we can actually just use it on the normal whiteboard and tell
// the AI what we want to orchestrate, and it can put the pieces together live in
// front of us." The Idea Board (public/buzzy/whiteboard.js) holds an orchestration as
// ordinary cards joined by lines; these functions turn that into this spec and back,
// so a flow built by talking opens in the Orchestrate editor (validator, Mermaid, run
// sheet, save, versions) and a flow drawn there can be put on the board. The board's
// own card kinds are the vocabulary: a skill is an agent step, an end result (a
// document card with no file yet) is the end, and the rest are named for their type.

/** Board card kinds that stand for an orchestration node (whiteboard.js kindOf). */
export const BOARD_FLOW_KINDS = ["start", "tool", "decision", "parallel", "loop", "approval", "trigger", "subflow"] as const;
/** The board card kind each node type becomes. */
export const BOARD_KIND_OF_TYPE: Record<NodeType, string> = {
  start: "start", agent: "skill", tool: "tool", decision: "decision", parallel: "parallel", loop: "loop",
  approval: "approval", trigger: "trigger", subflow: "subflow", end: "document", note: "note",
};

export interface BoardCard {
  id: string;
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
  contentType?: string;
  x?: number;
  y?: number;
  /**
   * What the Orchestrate editor knew about this node, as JSON text, so a round trip loses
   * nothing: `{ "node": "n_research", "config": {…} }`, and on the first card the
   * orchestration's own settings too (`"spec": { params, policy, description }`).
   */
  orch?: string;
}
export interface BoardLink {
  id?: string;
  from: string;
  to: string;
  label?: string;
  /** The ports and condition from the Orchestrate editor, kept so a round trip loses nothing. */
  fp?: string;
  tp?: string;
  cond?: string;
}
export interface BoardOrchestration { name?: string; cards: BoardCard[]; links: BoardLink[] }

/** The node type a board card stands for, or null when it is not part of a flow. */
export function boardCardType(c: BoardCard | null | undefined): NodeType | null {
  if (!c) return null;
  const k = String(c.kind || "").toLowerCase();
  if ((BOARD_FLOW_KINDS as readonly string[]).includes(k)) return k as NodeType;
  if (k === "skill" || k === "memory") return "agent";
  if (k === "note") return "note";
  // An end result is a document card that is still a description (no file yet).
  if ((k === "document" || k === "output") && !c.url && !c.contentType) return "end";
  return null;
}

const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function slug(s: string, fallback: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return /^[a-z_]/.test(out) ? out : out ? "t_" + out : fallback;
}
const SCHEDULE_WORDS = /\b(?:every|each|daily|weekly|monthly|hourly|weekdays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mornings?|evenings?|nights?|noon|midnight|cron|schedule[ds]?|at \d{1,2}(?::\d\d)?|\d{1,2}(?::\d\d)?\s*(?:am|pm))\b/i;

function savedOrch(c: BoardCard): { node: string; config: Record<string, unknown>; spec: Record<string, unknown> | null } {
  const none = { node: "", config: {}, spec: null };
  if (!c.orch) return none;
  try {
    const j = JSON.parse(c.orch) as unknown;
    if (!isObj(j)) return none;
    // The wrapped form (node + config + spec), or a bare config from before it existed.
    if (isObj(j.config) || typeof j.node === "string") {
      return { node: /^n_[A-Za-z0-9_]{1,60}$/.test(str(j.node)) ? str(j.node) : "", config: isObj(j.config) ? j.config : {}, spec: isObj(j.spec) ? j.spec : null };
    }
    return { node: "", config: j, spec: null };
  } catch {
    return none;
  }
}
function savedConfig(c: BoardCard): Record<string, unknown> {
  return savedOrch(c).config;
}
/** A saved output name, if it is one the validator takes; else "output". */
function outputOf(saved: Record<string, unknown>): { name: string } {
  const name = isObj(saved.output) ? str(saved.output.name) : "";
  return { name: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "output" };
}

/** A node's config from what the card says, keeping whatever it carried before. */
function configFor(type: NodeType, title: string, body: string, saved: Record<string, unknown>, outs: number, ins: number): Record<string, unknown> {
  const text = body || title;
  const keep = (key: string, fallback: unknown) => (saved[key] !== undefined ? saved[key] : fallback);
  switch (type) {
    case "agent":
      return {
        prompt: str(saved.prompt) || text,
        ...(str(saved.agent) ? { agent: str(saved.agent) } : {}),
        model: keep("model", null),
        tools: Array.isArray(saved.tools) ? saved.tools : [],
        inputs: isObj(saved.inputs) ? saved.inputs : {},
        output: outputOf(saved),
        timeoutSec: int(saved.timeoutSec, 1, 86400) ?? 180,
        retries: int(saved.retries, 0, 10) ?? 1,
        onError: isObj(saved.onError) ? saved.onError : { policy: "stop" },
        needsApproval: saved.needsApproval === true,
      };
    case "tool":
      return {
        tool: str(saved.tool) || slug(text.split(/[\n.:]/)[0] || "", slug(title, "tool")),
        args: isObj(saved.args) ? saved.args : {},
        inputs: isObj(saved.inputs) ? saved.inputs : {},
        output: outputOf(saved),
        timeoutSec: int(saved.timeoutSec, 1, 86400) ?? 120,
        retries: int(saved.retries, 0, 10) ?? 0,
        onError: isObj(saved.onError) ? saved.onError : { policy: "stop" },
        needsApproval: saved.needsApproval === true,
      };
    case "parallel": {
      const mode = str(saved.mode) === "join" || str(saved.mode) === "fan-out" ? str(saved.mode) : ins >= 2 && outs <= 1 ? "join" : "fan-out";
      return mode === "join"
        ? { mode, join: ["all", "any", "first"].includes(str(saved.join)) ? str(saved.join) : "all", maxConcurrency: int(saved.maxConcurrency, 1, 16) ?? 2, output: outputOf(saved) }
        : { mode, maxConcurrency: int(saved.maxConcurrency, 1, 16) ?? 2 };
    }
    case "loop": {
      // "at most 3 times", "up to 5 tries", "max 4": the cap, not any number in the words.
      const n = /(?:at most|max(?:imum)?|up to|no more than)\s*(\d{1,2})|(\d{1,2})\s*(?:times|tries|rounds|attempts|passes|goes)\b/i.exec(text);
      const cap = n ? Number(n[1] || n[2]) : 3;
      return {
        until: str(saved.until) || text,
        maxIterations: int(saved.maxIterations, 1, 50) ?? Math.min(50, Math.max(1, cap)),
      };
    }
    case "approval":
      return {
        prompt: str(saved.prompt) || text,
        approver: str(saved.approver) === "ops" ? "ops" : "owner",
        timeoutSec: int(saved.timeoutSec, 1, 2592000) ?? 86400,
        onTimeout: str(saved.onTimeout) === "reject" ? "reject" : "stop",
      };
    case "trigger": {
      const old = isObj(saved.trigger) ? saved.trigger : null;
      if (old && ["schedule", "webhook", "event"].includes(str(old.kind))) {
        return { mode: str(saved.mode) === "wait" || str(saved.mode) === "entry" ? str(saved.mode) : ins ? "wait" : "entry", trigger: old };
      }
      const kind = /\bweb ?hook\b/i.test(text) ? "webhook" : SCHEDULE_WORDS.test(text) ? "schedule" : "event";
      const trigger =
        kind === "schedule" ? { kind, schedule: text.slice(0, 200) }
          : kind === "webhook" ? { kind, webhook: "/hooks/" + slug(title, "hook") }
            : { kind, event: slug(text, "event") };
      return { mode: ins ? "wait" : "entry", trigger };
    }
    case "subflow": {
      const ref = isObj(saved.ref) ? saved.ref : {};
      return { ref: { graphId: str(ref.graphId), revision: ref.revision ?? null }, inputs: isObj(saved.inputs) ? saved.inputs : {}, output: outputOf(saved) };
    }
    case "end":
      return { outputs: isObj(saved.outputs) ? saved.outputs : {} };
    case "note":
      return { text };
    default:
      return {};
  }
}

const DEFAULT_NAME: Record<NodeType, string> = {
  start: "Start", agent: "Step", tool: "Tool", decision: "Decision", parallel: "At the same time", loop: "Repeat",
  approval: "Your approval", trigger: "When", subflow: "Another orchestration", end: "End result", note: "Note",
};

/**
 * An orchestration spec from cards and lines on the Idea Board. Only the cards that
 * are part of a flow count (steps, decisions, approvals… and end results); pictures,
 * files and the conversation are left out. Lines get their port from what they say:
 * "approved"/"rejected" out of an approval, "repeat"/"done" out of a loop, and a line
 * back into a loop from a step it repeats is the loop's back port. A board with no
 * Start gets one in front of the steps nothing leads into, and one with no end
 * result gets an End after the steps that lead nowhere, so the spec is runnable.
 */
export function boardToSpec(board: BoardOrchestration): OrchSpec {
  const cards = (Array.isArray(board?.cards) ? board.cards : []).filter((c) => c && c.id && boardCardType(c));
  const idOf = new Map<string, string>();
  const used = new Set<string>();
  // A node keeps the id it had in the editor (bindings like $n_research.findings name it);
  // a card made on the board gets one from its own id.
  for (const c of cards) {
    const kept = savedOrch(c).node;
    if (kept && !used.has(kept)) { used.add(kept); idOf.set(String(c.id), kept); }
  }
  for (const c of cards) {
    if (idOf.has(String(c.id))) continue;
    let nid = "n_" + String(c.id).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
    while (used.has(nid)) nid += "_";
    used.add(nid);
    idOf.set(String(c.id), nid);
  }
  const typeOf = new Map<string, NodeType>();
  for (const c of cards) typeOf.set(String(c.id), boardCardType(c)!);
  const seenPair = new Set<string>();
  const links = (Array.isArray(board?.links) ? board.links : []).filter((l) => {
    if (!l || !idOf.has(String(l.from)) || !idOf.has(String(l.to)) || l.from === l.to) return false;
    // A note is a comment: it cannot be connected (ORCH012), so its lines stay on the board only.
    if (typeOf.get(String(l.from)) === "note" || typeOf.get(String(l.to)) === "note") return false;
    const k = l.from + ">" + l.to + ">" + oneLine(l.label, 40);
    if (seenPair.has(k)) return false;
    seenPair.add(k);
    return true;
  });

  const nodes: OrchNode[] = [];
  let minX = Infinity, minY = Infinity;
  for (const c of cards) { minX = Math.min(minX, num(c.x) ?? 0); minY = Math.min(minY, num(c.y) ?? 0); }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; }
  for (const c of cards) {
    const id = String(c.id);
    const type = typeOf.get(id)!;
    const title = oneLine(c.title, 160) || DEFAULT_NAME[type];
    const body = String(c.body ?? "").trim().slice(0, 4000);
    const outs = links.filter((l) => l.from === id).length;
    const ins = links.filter((l) => l.to === id).length;
    const config = configFor(type, title, body, savedConfig(c), outs, ins);
    // The card's own words stay with the node, except where its settings already hold them
    // (an agent's prompt, an approval's ask, a note's text): they come back on the board.
    const prose = type !== "agent" && type !== "approval" && type !== "note";
    nodes.push({
      id: idOf.get(id)!,
      type,
      name: title,
      x: snap(64 + ((num(c.x) ?? 0) - minX) * 0.8, 16),
      y: snap(64 + ((num(c.y) ?? 0) - minY) * 0.6, 16),
      notes: prose ? body.slice(0, 2000) : "",
      config,
    });
  }
  const byNode = new Map(nodes.map((n) => [n.id, n]));

  // Forward reach (for back edges into a loop): which cards a card leads to.
  const next = new Map<string, string[]>();
  for (const l of links) (next.get(String(l.from)) ?? next.set(String(l.from), []).get(String(l.from))!).push(String(l.to));
  function reaches(from: string, target: string, skip: string): boolean {
    const seen = new Set<string>([from]);
    const q = [from];
    while (q.length) {
      const at = q.shift()!;
      for (const to of next.get(at) || []) {
        if (to === target) return true;
        if (to === skip || seen.has(to)) continue;
        seen.add(to);
        q.push(to);
      }
    }
    return false;
  }

  const edges: OrchEdge[] = [];
  const outCount = new Map<string, number>();
  for (const l of links) {
    const from = String(l.from), to = String(l.to);
    const a = byNode.get(idOf.get(from)!)!, b = byNode.get(idOf.get(to)!)!;
    const label = oneLine(l.label, 60);
    const nth = outCount.get(from) ?? 0;
    outCount.set(from, nth + 1);
    let fromPort: Port = "out";
    const keptFrom = str(l.fp) as Port, keptTo = str(l.tp) as Port;
    if (keptFrom && PORTS[a.type].includes(keptFrom)) {
      fromPort = keptFrom;
    } else if (a.type === "approval") {
      fromPort = /\b(?:reject\w*|no|denied|declin\w*|not ok|refus\w*)\b/i.test(label) ? "rejected"
        : /\b(?:approv\w*|yes|ok|okay|accept\w*)\b/i.test(label) ? "approved" : nth === 0 ? "approved" : "rejected";
    } else if (a.type === "loop") {
      fromPort = /\b(?:done|exit|finish\w*|after|then|next|end|stop|leave)\b/i.test(label) ? "exit"
        : /\b(?:repeat|body|each|again|loop|try|do|run)\b/i.test(label) ? "body" : nth === 0 ? "body" : "exit";
    } else if (!PORTS[a.type].includes("out")) {
      continue;
    }
    let toPort: Port = "in";
    if (keptTo && PORTS[b.type].includes(keptTo)) toPort = keptTo;
    else if (b.type === "loop" && (/\b(?:again|back|repeat|retry|loop)\b/i.test(label) || reaches(to, from, ""))) toPort = "back";
    if (!PORTS[b.type].includes(toPort)) continue;
    const condition = str(l.cond).trim().slice(0, 500) || null;
    edges.push({ id: "e_" + (edges.length + 1), from: { node: a.id, port: fromPort }, to: { node: b.id, port: toPort }, label, condition });
  }

  // A Start in front, an End after, when the board has none.
  const hasStart = nodes.some((n) => n.type === "start") || nodes.some((n) => n.type === "trigger" && (n.config as { mode?: string }).mode === "entry");
  const flowNodes = nodes.filter((n) => n.type !== "note");
  if (!hasStart && flowNodes.length) {
    const firsts = flowNodes.filter((n) => !edges.some((e) => e.to.node === n.id && e.to.port !== "back"));
    const x0 = Math.min(...flowNodes.map((n) => n.x));
    let sid = "n_start";
    while (byNode.has(sid)) sid += "_";
    const s: OrchNode = { id: sid, type: "start", name: "Start", x: snap(x0 - 240, 16), y: snap(Math.min(...flowNodes.map((n) => n.y)), 16), notes: "", config: {} };
    nodes.unshift(s);
    byNode.set(sid, s);
    for (const f of firsts.length ? firsts : [flowNodes[0]!]) {
      edges.push({ id: "e_" + (edges.length + 1), from: { node: sid, port: "out" }, to: { node: f.id, port: "in" }, label: "", condition: null });
    }
  }
  if (!nodes.some((n) => n.type === "end")) {
    const lasts = nodes.filter((n) => n.type !== "note" && n.type !== "end" && PORTS[n.type].includes("out") && !edges.some((e) => e.from.node === n.id));
    const x1 = Math.max(64, ...nodes.map((n) => n.x));
    let eid = "n_end";
    while (byNode.has(eid)) eid += "_";
    const e: OrchNode = { id: eid, type: "end", name: "End", x: snap(x1 + 240, 16), y: snap(Math.min(...nodes.map((n) => n.y), 64), 16), notes: "", config: { outputs: {} } };
    nodes.push(e);
    byNode.set(eid, e);
    for (const l of lasts) edges.push({ id: "e_" + (edges.length + 1), from: { node: l.id, port: "out" }, to: { node: eid, port: "in" }, label: "", condition: null });
  }

  const start = nodes.find((n) => n.type === "start") || nodes.find((n) => n.type === "trigger" && (n.config as { mode?: string }).mode === "entry");
  // The orchestration's own settings, when the flow came from the editor (kept on a card).
  const kept = cards.map((c) => savedOrch(c).spec).find((x) => !!x) || null;
  const spec = {
    schema: ORCH_SCHEMA,
    schemaVersion: ORCH_SCHEMA_VERSION,
    name: oneLine(board?.name, 160) || "Orchestration from the Idea Board",
    description: kept ? str(kept.description).slice(0, 2000) : "",
    direction: "LR" as const,
    grid: 16,
    entry: start ? start.id : "",
    params: kept && Array.isArray(kept.params) ? kept.params : [{ name: "goal", type: "string" as const, required: true, default: null, description: "What this run is for" }],
    policy: kept && isObj(kept.policy) ? kept.policy : { maxConcurrency: 4, budgetSec: 900, onError: "stop" as const },
    nodes,
    edges,
    meta: { generator: "import" as const, from: "idea-board" },
  };
  return validateOrchestration(spec).spec;
}

/** What a node's card says on the board. */
function boardBody(n: OrchNode): string {
  const c = n.config || {};
  switch (n.type) {
    case "agent": return str(c.prompt);
    case "approval": return str(c.prompt);
    case "note": return str(c.text);
    case "tool": return n.notes || (str(c.tool) ? "Tool: " + str(c.tool) : "");
    case "loop": return n.notes || (str(c.until) ? "Until " + str(c.until) : "Repeat") + (int(c.maxIterations, 1, 50) ? " · at most " + c.maxIterations + " times" : "");
    case "trigger": {
      const t = isObj(c.trigger) ? c.trigger : {};
      return n.notes || str(t.schedule) || (str(t.webhook) ? "Webhook " + str(t.webhook) : "") || (str(t.event) ? "When " + str(t.event) + " happens" : "");
    }
    case "subflow": {
      const ref = isObj(c.ref) ? c.ref : {};
      return n.notes || (str(ref.graphId) ? "Runs " + str(ref.graphId) : "");
    }
    default: return n.notes || "";
  }
}

/** Cards and lines for the Idea Board from a spec (the Orchestrate editor's "Put on the Idea Board"). */
export function specToBoard(spec: OrchSpec): BoardOrchestration {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const first = nodes.find((n) => n.id === spec?.entry) || nodes[0];
  const cards: BoardCard[] = nodes.map((n) => {
    const card: BoardCard = {
      id: n.id,
      kind: BOARD_KIND_OF_TYPE[n.type] || "note",
      title: oneLine(n.name, 140) || DEFAULT_NAME[n.type],
      body: boardBody(n).slice(0, 4000),
      x: Math.round(n.x),
      y: Math.round(n.y),
    };
    const keep: Record<string, unknown> = { node: n.id, config: n.config || {} };
    if (n === first) keep.spec = { params: spec.params || [], policy: spec.policy || {}, description: spec.description || "" };
    let orch = JSON.stringify(keep);
    // Too long to keep whole: the id and the settings, then the id alone.
    if (orch.length > 4000) orch = JSON.stringify({ node: n.id, config: n.config || {} });
    if (orch.length > 4000) orch = JSON.stringify({ node: n.id });
    card.orch = orch;
    return card;
  });
  const links: BoardLink[] = [];
  for (const e of Array.isArray(spec?.edges) ? spec.edges : []) {
    const a = byId.get(e.from.node), b = byId.get(e.to.node);
    if (!a || !b || a.type === "note" || b.type === "note") continue;
    const portWord: Partial<Record<Port, string>> = { approved: "approved", rejected: "rejected", body: "repeat", exit: "done" };
    const label = oneLine(e.label, 40) || (e.to.port === "back" ? "again" : portWord[e.from.port] || "");
    const line: BoardLink = { from: a.id, to: b.id, fp: e.from.port, tp: e.to.port };
    if (label) line.label = label;
    if (e.condition) line.cond = String(e.condition).slice(0, 500);
    links.push(line);
  }
  return { name: spec?.name || "", cards, links };
}

// ── Placing a flow on the board, piece by piece ──────────────────────────
//
// BeeZilla says WHAT goes on the board and how it connects; WHERE is worked out here,
// from the cards already there and the lines known so far. A model asked for
// coordinates gets the target right far more often than the placement (CanvasObs,
// arXiv 2610.27176: "Correct placement remains a distinct bottleneck"), so the model
// never writes a coordinate. The rules are a person's: the work reads left to right,
// a branch's second answer goes under its first, a join sits level with what it
// joins, and a card put between two others makes room by moving what follows.

export interface FlowBox { id: string; x: number; y: number; w: number; h: number; kind?: string }
export interface FlowLine { from: string; to: string; label?: string }
export interface PlaceOptions {
  /** Space between columns (the board's COL_GAP is 120). */
  colGap?: number;
  /** Space between cards stacked in one column. */
  rowGap?: number;
  /** Where a flow with nothing to hang on starts. */
  origin?: { x: number; y: number };
}

const BACK_WORDS = /^(?:again|back|loop back|go back|retry|try again|repeat again)$/i;

/** A line that goes back to repeat earlier work (into a loop), not forward. */
export function isBackLine(line: FlowLine, boxes: Map<string, FlowBox> | FlowBox[]): boolean {
  const m = boxes instanceof Map ? boxes : new Map(boxes.map((b) => [b.id, b]));
  const to = m.get(line.to);
  if (BACK_WORDS.test(String(line.label || "").trim())) return true;
  return !!(to && to.kind === "loop" && /\bagain\b/i.test(String(line.label || "")));
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad: number): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

/** The first free spot at (x, y) or below it, so nothing overlaps; above only when nothing below is free. */
export function freeSpotNear(x: number, y: number, w: number, h: number, boxes: FlowBox[], skip?: Set<string>, pad = 24): { x: number; y: number } {
  const others = boxes.filter((b) => !skip || !skip.has(b.id));
  const free = (yy: number) => !others.some((b) => overlaps({ x, y: yy, w, h }, b, pad));
  for (let i = 0; i < 120; i++) if (free(y + i * 24)) return { x: Math.round(x), y: Math.round(y + i * 24) };
  for (let i = 1; i < 40; i++) if (free(y - i * 24)) return { x: Math.round(x), y: Math.round(y - i * 24) };
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Where a new flow starts: the first spot from (x, y) where a whole row of cards fits —
 * past anything sitting where the first card would go (the conversation card, say), then
 * lower down if the row is still blocked — so the flow reads level from its first card.
 */
export function flowOrigin(x: number, y: number, boxes: FlowBox[], opts: { cardW?: number; cardH?: number; colGap?: number; columns?: number } = {}): { x: number; y: number } {
  const w = opts.cardW ?? 210, h = (opts.cardH ?? 130) + 20, step = w + (opts.colGap ?? 120);
  const width = step * (opts.columns ?? 5);
  let at = x;
  for (let k = 0; k < 8; k++) {
    const hit = boxes.filter((b) => overlaps({ x: at, y, w, h }, b, 24));
    if (!hit.length) break;
    at = Math.max(...hit.map((b) => b.x + b.w)) + 60;
  }
  for (let i = 0; i < 80; i++) {
    const yy = y + i * 40;
    if (!boxes.some((b) => overlaps({ x: at, y: yy, w: width, h }, b, 24))) return { x: Math.round(at), y: Math.round(yy) };
  }
  return { x: Math.round(at), y: Math.round(y) };
}

/** Everything a card leads to (forward lines only), not counting `stop`. */
function downstream(id: string, lines: FlowLine[], boxes: Map<string, FlowBox>, stop?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const q = [id];
  while (q.length) {
    const at = q.shift()!;
    for (const l of lines) {
      if (l.from !== at || seen.has(l.to) || l.to === stop) continue;
      if (isBackLine(l, boxes)) continue;
      seen.add(l.to);
      out.push(l.to);
      q.push(l.to);
    }
  }
  return out;
}

/** Where a card belongs in the flow, before anything else on the board is considered. */
function idealSpot(id: string, size: { w: number; h: number }, boxes: FlowBox[], lines: FlowLine[], opts: PlaceOptions): { x: number; y: number } {
  const colGap = opts.colGap ?? 120, rowGap = opts.rowGap ?? 40;
  const m = new Map(boxes.map((b) => [b.id, b]));
  const forwardIn = lines.filter((l) => l.to === id && m.has(l.from) && !isBackLine(l, m));
  const preds = forwardIn.map((l) => m.get(l.from)!);
  if (preds.length) {
    // After a loop's "done": past the end of what the loop repeats.
    let right = Math.max(...preds.map((p) => p.x + p.w));
    for (const l of forwardIn) {
      const p = m.get(l.from)!;
      if (p.kind === "loop" && /\b(?:done|exit|finish|after|then|next)\b/i.test(String(l.label || ""))) {
        for (const d of downstream(p.id, lines.filter((x) => !(x.from === p.id && x.to === id)), m)) {
          const b = m.get(d);
          if (b) right = Math.max(right, b.x + b.w);
        }
      }
    }
    const x = right + colGap;
    if (preds.length >= 2) {
      // A join: level with the middle of what it joins.
      return { x, y: preds.reduce((s, p) => s + p.y + p.h / 2, 0) / preds.length - size.h / 2 };
    }
    const p = preds[0]!;
    // The n-th answer of a branch goes under the ones before it.
    const siblings = lines.filter((l) => l.from === p.id && l.to !== id && m.has(l.to) && !isBackLine(l, m)).map((l) => m.get(l.to)!).filter((b) => b.x >= p.x + p.w);
    // …but a card that only follows on (no branch yet) stays level with what it follows.
    const after = new Set(downstream(id, lines, m));
    const others = siblings.filter((b) => !after.has(b.id));
    return { x, y: others.length ? Math.max(...others.map((s) => s.y + s.h)) + rowGap : p.y };
  }
  // Only what follows is known: just before it.
  const succIds = lines.filter((l) => l.from === id && m.has(l.to) && !isBackLine(l, m)).map((l) => l.to);
  if (succIds.length) {
    const s = m.get(succIds[0]!)!;
    return { x: s.x - colGap - size.w, y: s.y };
  }
  return opts.origin ?? { x: 0, y: 0 };
}

/**
 * Where a new card goes. `lines` are the lines known so far, including the ones that
 * will join this card (read ahead from what BeeZilla already said).
 */
export function placeCard(id: string, size: { w: number; h: number }, boxes: FlowBox[], lines: FlowLine[], opts: PlaceOptions = {}): { x: number; y: number } {
  const at = idealSpot(id, size, boxes, lines, opts);
  return freeSpotNear(at.x, at.y, size.w, size.h, boxes, new Set([id]));
}

/**
 * Where a new card goes in a flow, making room when its place is taken by what comes
 * after it: put between "Write" and "Publish", it takes Publish's place and Publish
 * (with everything after it) moves right, the way a person would slide them over.
 * Anything else in the way, it goes under instead.
 */
export function placeInFlow(id: string, size: { w: number; h: number }, boxes: FlowBox[], lines: FlowLine[], opts: PlaceOptions = {}): { x: number; y: number; moves: Array<{ id: string; x: number; y: number }> } {
  const colGap = opts.colGap ?? 120;
  const at = idealSpot(id, size, boxes, lines, opts);
  const m = new Map(boxes.map((b) => [b.id, b]));
  const here = { x: at.x, y: at.y, w: size.w, h: size.h };
  const blocking = boxes.filter((b) => b.id !== id && overlaps(here, b, 24));
  if (blocking.length) {
    const after = new Set(downstream(id, lines, m));
    if (blocking.every((b) => after.has(b.id))) {
      const dx = Math.round(at.x + size.w + colGap - Math.min(...blocking.map((b) => b.x)));
      const moves = Array.from(after).map((bid) => m.get(bid)).filter((b): b is FlowBox => !!b && b.x >= at.x - size.w)
        .map((b) => ({ id: b.id, x: Math.round(b.x + dx), y: Math.round(b.y) }));
      const moved = new Map(moves.map((v) => [v.id, v]));
      const after2 = boxes.map((b) => (moved.has(b.id) ? { ...b, x: moved.get(b.id)!.x } : b));
      const spot = freeSpotNear(at.x, at.y, size.w, size.h, after2, new Set([id]));
      return { x: spot.x, y: spot.y, moves };
    }
  }
  const spot = freeSpotNear(at.x, at.y, size.w, size.h, boxes, new Set([id]));
  return { x: spot.x, y: spot.y, moves: [] };
}

/**
 * What a line in a flow should say, given the cards at its ends: "repeat" and "done"
 * only leave a loop, "again" only goes back into one, "approved"/"rejected" only leave
 * an approval. A word in the wrong place is dropped rather than shown, so the board
 * never says something the flow doesn't mean.
 */
export function tidyLineLabel(label: string, fromKind: string, toKind: string): string {
  const l = String(label || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!l) return "";
  const low = l.toLowerCase();
  if (/^(?:again|back|loop back|go back|retry|try again|repeat again)$/.test(low)) return toKind === "loop" ? "again" : "";
  if (/^(?:repeat|body|each|loop|do|run)$/.test(low)) return fromKind === "loop" ? "repeat" : "";
  if (/^(?:done|exit|finished|finish|after|then|next)$/.test(low)) return fromKind === "loop" ? "done" : fromKind === "decision" ? l : "";
  if (/^(?:approved|rejected|approve|reject)$/.test(low)) return fromKind === "approval" ? (low.startsWith("approve") ? "approved" : "rejected") : fromKind === "decision" ? l : "";
  return l;
}

/**
 * A line from `from` to `to` where `to` does not sit after `from`: the cards from
 * `to` onwards move right (and only those), so the flow still reads left to right.
 * Returns the new places of the cards that move; nothing for a line back into a loop.
 */
export function makeRoom(from: string, to: string, boxes: FlowBox[], lines: FlowLine[], opts: PlaceOptions = {}, label?: string): Array<{ id: string; x: number; y: number }> {
  const colGap = opts.colGap ?? 120;
  const m = new Map(boxes.map((b) => [b.id, b]));
  const a = m.get(from), b = m.get(to);
  if (!a || !b || isBackLine({ from, to, label }, m)) return [];
  const need = a.x + a.w + colGap - b.x;
  if (need <= 0) return [];
  // Only cards that are really after `to` move: never `from` itself or what leads to it.
  const chain = [to, ...downstream(to, lines, m, from)].filter((id) => id !== from);
  const before = new Set(lines.filter((l) => l.to === from).map((l) => l.from));
  return chain.filter((id) => !before.has(id) && m.has(id)).map((id) => {
    const c = m.get(id)!;
    return { id, x: Math.round(c.x + need), y: Math.round(c.y) };
  });
}

// ── The board, described for the model ──────────────────────────────────
//
// What BeeZilla is shown before it builds: every card as one short line (a short id,
// what it is, its words, where it is and whether it is in view), the lines between
// them with what they say, which area holds what, what is selected, and where there
// is room. Short ids and rounded numbers keep it small (tldraw's agent kit does the
// same: "round numbers before sending them to the model"); cards far out of view are
// counted rather than listed once the board is big.

export interface MapCard { id: string; kind: string; title?: string; body?: string; url?: string; x: number; y: number; w: number; h: number; selected?: boolean }
export interface MapArea { id: string; title?: string; holds: string[] }
export interface BoardView { x1: number; y1: number; x2: number; y2: number; z: number }

/** The model's name for each board card kind. */
const MAP_KIND: Record<string, string> = {
  skill: "step", memory: "step", agent: "core-identity", person: "who-it-serves", chat: "conversation", note: "note",
  image: "picture", track: "music", model: "3d-model", video: "video", document: "document", sheet: "spreadsheet",
  slides: "slides", pdf: "pdf", file: "file", sketch: "drawing", area: "area",
  start: "start", tool: "tool", decision: "decision", parallel: "parallel", loop: "loop", approval: "approval",
  trigger: "trigger", subflow: "subflow",
};

export function describeBoard(input: { cards: MapCard[]; links: FlowLine[]; areas?: MapArea[]; view?: BoardView | null; budget?: number }): { text: string; ids: Record<string, string> } {
  const budget = input.budget ?? 3200;
  const cards = (input.cards || []).filter((c) => c && c.id && c.kind !== "area");
  const view = input.view;
  const r10 = (v: number) => Math.round(v / 10) * 10;
  const inView = (c: MapCard) => !!view && c.x < view.x2 && c.x + c.w > view.x1 && c.y < view.y2 && c.y + c.h > view.y1;
  const where = (c: MapCard): string => {
    if (!view || inView(c)) return "";
    const s: string[] = [];
    if (c.y + c.h < view.y1) s.push("above");
    else if (c.y > view.y2) s.push("below");
    if (c.x + c.w < view.x1) s.push("left");
    else if (c.x > view.x2) s.push("right");
    return " off view " + s.join("-");
  };
  // Reading order: left to right, then top to bottom.
  const ordered = cards.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const ids: Record<string, string> = {};
  const short = new Map<string, string>();
  ordered.forEach((c, i) => { const s = "c" + (i + 1); ids[s] = c.id; short.set(c.id, s); });
  const linked = new Set<string>();
  for (const l of input.links || []) { linked.add(l.from); linked.add(l.to); }
  const cx = view ? (view.x1 + view.x2) / 2 : 0, cy = view ? (view.y1 + view.y2) / 2 : 0;
  const rank = (c: MapCard) => (c.selected ? 0 : inView(c) ? 1 : linked.has(c.id) ? 2 : 3) * 1e7 + Math.hypot(c.x - cx, c.y - cy);
  const listed = new Set(cards.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 80).map((c) => c.id));

  const head: string[] = [];
  const links = (input.links || []).filter((l) => short.has(l.from) && short.has(l.to));
  head.push(`Board: ${cards.length} card${cards.length === 1 ? "" : "s"}, ${links.length} line${links.length === 1 ? "" : "s"}.` +
    (view ? ` In view: x ${r10(view.x1)}..${r10(view.x2)}, y ${r10(view.y1)}..${r10(view.y2)} at ${Math.round(view.z * 100)}%.` : ""));
  const lines: string[] = [];
  let used = head.join("\n").length;
  const skipped: MapCard[] = [];
  for (const c of ordered) {
    if (!listed.has(c.id)) { skipped.push(c); continue; }
    const kind = MAP_KIND[c.kind] || c.kind || "card";
    const title = oneLine(c.title, 60).replace(/"/g, "'");
    const body = oneLine(c.body, 90);
    const web = /^https?:\/\//i.test(String(c.url || "")) ? " " + String(c.url).slice(0, 80) : "";
    const line = `${short.get(c.id)} ${kind === "file" && web ? "link" : kind} "${title}"${body ? " — " + body : ""}${web} @${r10(c.x)},${r10(c.y)} ${r10(c.w)}x${r10(c.h)}${where(c)}`;
    if (used + line.length + 1 > budget - 400) { skipped.push(c); continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const out = head.concat(lines);
  if (skipped.length) {
    const kinds = Array.from(new Set(skipped.map((c) => MAP_KIND[c.kind] || c.kind))).slice(0, 5).join(", ");
    out.push(`(+${skipped.length} more card${skipped.length === 1 ? "" : "s"} not listed: ${kinds})`);
  }
  if (links.length) {
    const parts = links.slice(0, 120).map((l) => `${short.get(l.from)}>${short.get(l.to)}${oneLine(l.label, 24) ? ' "' + oneLine(l.label, 24).replace(/"/g, "'") + '"' : ""}`);
    out.push("Lines: " + parts.join(", "));
  }
  for (const a of input.areas || []) {
    const held = (a.holds || []).map((id) => short.get(id)).filter(Boolean);
    if (held.length) out.push(`Area "${oneLine(a.title, 40).replace(/"/g, "'")}" holds ${held.join(" ")}`);
  }
  const sel = cards.filter((c) => c.selected).map((c) => short.get(c.id));
  if (sel.length) out.push("Selected: " + sel.join(" "));
  if (cards.length) {
    const right = Math.max(...cards.map((c) => c.x + c.w));
    const below = Math.max(...cards.map((c) => c.y + c.h));
    out.push(`Room: right of x ${r10(right)}; below y ${r10(below)}.`);
  } else out.push("The board is empty.");
  return { text: out.join("\n").slice(0, budget), ids };
}
