/* Generated from src/lib/buzzy/orchestration.ts by scripts/build-orchestration-client.mjs. Do not edit. */
"use strict";
var BZOrchestration = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/lib/buzzy/orchestration.ts
  var orchestration_exports = {};
  __export(orchestration_exports, {
    LEGACY_NODE_TYPES: () => LEGACY_NODE_TYPES,
    NODE_TYPES: () => NODE_TYPES,
    ORCH_SCHEMA: () => ORCH_SCHEMA,
    ORCH_SCHEMA_VERSION: () => ORCH_SCHEMA_VERSION,
    PORTS: () => PORTS,
    canonicalSpec: () => canonicalSpec,
    canonicalise: () => canonicalise,
    fromBase64Url: () => fromBase64Url,
    fromMermaid: () => fromMermaid,
    parseExpression: () => parseExpression,
    parseGraphDetailPath: () => parseGraphDetailPath,
    snap: () => snap,
    toBase64Url: () => toBase64Url,
    toGraphRows: () => toGraphRows,
    toMermaid: () => toMermaid,
    toRunSheet: () => toRunSheet,
    toYaml: () => toYaml,
    validateOrchestration: () => validateOrchestration
  });
  var ORCH_SCHEMA = "beezilla/orchestration";
  var ORCH_SCHEMA_VERSION = 1;
  var NODE_TYPES = [
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
    "note"
  ];
  var LEGACY_NODE_TYPES = ["skill", "model", "review", "gate"];
  var BLOCKING = /* @__PURE__ */ new Set([
    "ORCH001",
    "ORCH002",
    "ORCH006",
    "ORCH007",
    "ORCH008",
    "ORCH009",
    "ORCH010",
    "ORCH011",
    "ORCH012",
    "ORCH013",
    "ORCH015",
    "ORCH017",
    "ORCH020"
  ]);
  var PORTS = {
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
    note: []
  };
  var CONFIG_KEYS = {
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
    note: ["text"]
  };
  var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var str = (v) => typeof v === "string" ? v : "";
  var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  var int = (v, lo, hi) => {
    const n = num(v);
    return n !== void 0 && Number.isInteger(n) && n >= lo && n <= hi ? n : void 0;
  };
  var snap = (value, grid) => Math.round(value / grid) * grid;
  function canonicalise(value) {
    if (Array.isArray(value)) return value.map(canonicalise);
    if (isObj(value)) {
      const out = {};
      for (const k of Object.keys(value).sort()) {
        if (value[k] === void 0) continue;
        out[k] = k === "x" || k === "y" ? Math.round(Number(value[k]) * 10) / 10 : canonicalise(value[k]);
      }
      return out;
    }
    return value;
  }
  function canonicalSpec(spec) {
    return JSON.stringify(canonicalise(spec));
  }
  function tokenise(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1, s = "";
        while (j < src.length && src[j] !== q) {
          if (src[j] === "\\" && j + 1 < src.length) {
            s += src[j + 1];
            j += 2;
            continue;
          }
          s += src[j++];
        }
        if (j >= src.length) return { error: `unterminated string at ${i}` };
        out.push({ t: "str", v: s });
        i = j + 1;
        continue;
      }
      if (c === "$") {
        let j = i + 1, s = "";
        while (j < src.length && /[A-Za-z0-9_.\[\]]/.test(src[j])) s += src[j++];
        const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+|\[\d+\])+)$/.exec(s);
        if (!m) return { error: `bad binding "$${s}"` };
        out.push({ t: "ref", v: s });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || c === "-" && /[0-9]/.test(src[i + 1] || "")) {
        const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        out.push({ t: "num", v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        out.push({ t: "id", v: m[0] });
        i += m[0].length;
        continue;
      }
      const three = src.slice(i, i + 2);
      if (["==", "!=", ">=", "<=", "&&", "||"].includes(three)) {
        out.push({ t: "op", v: three });
        i += 2;
        continue;
      }
      if (["!", ">", "<", "(", ")"].includes(c)) {
        out.push({ t: "op", v: c });
        i++;
        continue;
      }
      return { error: `unexpected character "${c}" at ${i}` };
    }
    out.push({ t: "eof" });
    return out;
  }
  function parseExpression(src) {
    const toks = tokenise(src);
    if ("error" in toks) return { ok: false, error: toks.error, refs: [] };
    let p = 0;
    const refs = [];
    const peek = () => toks[Math.min(p, toks.length - 1)];
    const eat = (v) => {
      const t = peek();
      if (t.t === "op" && t.v === v || t.t === "id" && t.v === v) {
        p++;
        return true;
      }
      return false;
    };
    let error;
    const primary = () => {
      const t = peek();
      if (t.t === "num" || t.t === "str") {
        p++;
        return;
      }
      if (t.t === "ref") {
        refs.push(t.v);
        p++;
        return;
      }
      if (t.t === "id") {
        if (t.v === "true" || t.v === "false" || t.v === "null") {
          p++;
          return;
        }
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
    const unary = () => {
      if (eat("!")) {
        unary();
        return;
      }
      primary();
    };
    const cmp = () => {
      unary();
      const t = peek();
      if (t.t === "op" && [">", ">=", "<", "<=", "==", "!="].includes(t.v) || t.t === "id" && t.v === "in") {
        p++;
        unary();
      }
    };
    const and = () => {
      cmp();
      while (eat("&&")) cmp();
    };
    const expr = () => {
      and();
      while (eat("||")) and();
    };
    expr();
    if (!error && peek().t !== "eof") error = `unexpected token at ${p}`;
    return { ok: !error, error, refs };
  }
  function rootOf(ref) {
    const parts = ref.split(".");
    if (parts[0] === "input" && parts.length >= 2) return { kind: "input", name: parts[1] };
    if (parts[0] === "loop") return { kind: "loop" };
    if (parts.length >= 2) {
      const out = parts[1].replace(/\[\d+\]$/, "");
      return { kind: "node", node: parts[0], out };
    }
    return null;
  }
  function interpolations(s) {
    const out = [];
    const re = /\{\{([\s\S]*?)\}\}/g;
    let m;
    while (m = re.exec(s)) out.push(m[1].trim());
    return out;
  }
  function emptySpec() {
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
      meta: {}
    };
  }
  function validateOrchestration(input) {
    const issues = [];
    const add = (code, severity, message, nodeId, edgeId) => issues.push({ code, severity, message, nodeId, edgeId });
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
    const params = [];
    const paramNames = /* @__PURE__ */ new Set();
    for (const raw of Array.isArray(input.params) ? input.params : []) {
      if (!isObj(raw)) {
        add("ORCH015", "error", "Every param must be an object.");
        continue;
      }
      const pname = str(raw.name).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pname)) {
        add("ORCH015", "error", `Param name "${pname}" is not an identifier.`);
        continue;
      }
      if (paramNames.has(pname)) add("ORCH007", "error", `Two params are named "${pname}".`);
      paramNames.add(pname);
      const type = ["string", "number", "boolean", "object", "array"].includes(str(raw.type)) ? str(raw.type) : "string";
      params.push({
        name: pname,
        type,
        required: raw.required === true,
        default: raw.default ?? null,
        ...str(raw.description) ? { description: str(raw.description).slice(0, 300) } : {}
      });
    }
    const nodes = [];
    const byId = /* @__PURE__ */ new Map();
    const declared = /* @__PURE__ */ new Map();
    const pending = [];
    function checkBinding(ref, at) {
      pending.push({ ref: ref.replace(/^\$/, ""), at });
    }
    const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
    if (rawNodes.length === 0) add("ORCH015", "error", "A spec needs at least one node.");
    if (rawNodes.length > 200) add("ORCH015", "error", "The node limit is 200.");
    for (const raw of rawNodes) {
      if (!isObj(raw)) {
        add("ORCH015", "error", "Every node must be an object.");
        continue;
      }
      const id = str(raw.id).trim();
      const type = raw.type;
      if (!/^n_[A-Za-z0-9_]+$/.test(id)) {
        add("ORCH015", "error", `Node id "${id}" must match n_[A-Za-z0-9_]+.`);
        continue;
      }
      if (byId.has(id)) {
        add("ORCH007", "error", `Two nodes use the id "${id}".`, id);
        continue;
      }
      if (!NODE_TYPES.includes(type)) {
        add("ORCH015", "error", `"${id}" has unknown type "${String(raw.type)}".`, id);
        continue;
      }
      const config = isObj(raw.config) ? raw.config : {};
      const allowed = new Set(CONFIG_KEYS[type]);
      for (const k of Object.keys(config)) {
        if (!allowed.has(k)) add("ORCH015", "error", `"${id}" (${type}) has unknown config key "${k}".`, id);
      }
      const clean = {};
      for (const k of allowed) if (k in config) clean[k] = config[k];
      const node = {
        id,
        type,
        name: str(raw.name).trim().slice(0, 160) || type,
        x: snap(num(raw.x) ?? 0, grid),
        y: snap(num(raw.y) ?? 0, grid),
        notes: str(raw.notes).slice(0, 2e3),
        config: clean
      };
      const c = config;
      const needText = (key, code = "ORCH010") => {
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
          if (max === void 0) add("ORCH017", "error", `"${id}" needs maxIterations 1..50.`, id);
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
      if (type === "agent" || type === "tool" || type === "subflow" || type === "parallel" && str(c.mode) === "join") {
        const out = isObj(c.output) ? c.output : null;
        const oname = out ? str(out.name).trim() : "";
        if (out && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(oname)) {
          add("ORCH013", "error", `"${id}" output name "${oname}" is not an identifier.`, id);
        } else if (out && oname) {
          if (declared.has(id)) add("ORCH013", "error", `"${id}" declares more than one output.`, id);
          declared.set(id, /* @__PURE__ */ new Set([oname]));
        }
      }
      if (type === "end" && isObj(c.outputs)) {
      }
      for (const key of ["inputs", "args"]) {
        if (!isObj(c[key])) continue;
        for (const [k, v] of Object.entries(c[key])) {
          if (typeof v !== "string") {
            add("ORCH015", "error", `"${id}" ${key}.${k} must be a string binding.`, id);
            continue;
          }
          if (v.startsWith("$")) checkBinding(v, id);
        }
      }
      if (type === "end" && isObj(c.outputs)) {
        for (const [k, v] of Object.entries(c.outputs)) {
          if (typeof v !== "string" || !v.startsWith("$")) {
            add("ORCH015", "error", `"${id}" outputs.${k} must be a $binding.`, id);
          } else checkBinding(v, id);
        }
      }
      for (const key of ["prompt", "until"]) {
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
    const edges = [];
    const edgeIds = /* @__PURE__ */ new Set();
    const rawEdges = Array.isArray(input.edges) ? input.edges : [];
    for (const raw of rawEdges) {
      if (!isObj(raw)) {
        add("ORCH015", "error", "Every edge must be an object.");
        continue;
      }
      const from = isObj(raw.from) ? raw.from : null;
      const to = isObj(raw.to) ? raw.to : null;
      const fromNode = from ? str(from.node) : "";
      const toNode = to ? str(to.node) : "";
      const fromPort = from ? str(from.port) : "out";
      const toPort = to ? str(to.port) : "in";
      const id = str(raw.id).trim() || `e_${edges.length + 1}`;
      if (edgeIds.has(id)) {
        add("ORCH008", "error", `Two edges use the id "${id}".`, void 0, id);
        continue;
      }
      edgeIds.add(id);
      const a = byId.get(fromNode), b = byId.get(toNode);
      if (!a || !b) {
        add("ORCH008", "error", `Edge ${fromNode || "?"} -> ${toNode || "?"} points at a node that does not exist.`, void 0, id);
        continue;
      }
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
      const condition = raw.condition === null || raw.condition === void 0 ? null : str(raw.condition).trim();
      if (condition) {
        const parsed = parseExpression(condition);
        if (!parsed.ok) add("ORCH016", "warn", `Condition on ${id} does not parse: ${parsed.error}`, void 0, id);
        for (const ref of parsed.refs) pending.push({ ref, at: `edge ${id}` });
      }
      if ((raw.label ?? "") !== "" && typeof raw.label !== "string") {
        add("ORCH015", "error", `Edge ${id} label must be text.`, void 0, id);
      }
      edges.push({
        id,
        from: { node: fromNode, port: fromPort },
        to: { node: toNode, port: toPort },
        label: str(raw.label).slice(0, 160),
        condition
      });
    }
    for (const { ref, at } of pending) {
      const root = rootOf(ref);
      if (!root) {
        add("ORCH006", "error", `"${ref}" in ${at} is not a binding.`, void 0);
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
      if (root.kind === "loop" && !nodes.some((n) => n.type === "loop")) {
        add("ORCH006", "error", `${at} reads $loop.* but the graph has no loop node.`);
      }
    }
    const starts = nodes.filter((n) => n.type === "start");
    const entryTriggers = nodes.filter((n) => n.type === "trigger" && str(n.config.mode) === "entry");
    if (starts.length + entryTriggers.length === 0) add("ORCH001", "error", "No start node (or trigger in entry mode).");
    if (starts.length > 1) add("ORCH001", "error", "More than one start node.");
    const ends = nodes.filter((n) => n.type === "end");
    if (ends.length === 0) add("ORCH002", "error", "No end node.");
    const entry = str(input.entry).trim() || starts[0]?.id || entryTriggers[0]?.id || "";
    if (entry && !byId.has(entry)) add("ORCH001", "error", `entry "${entry}" is not a node.`, entry);
    if (!entry && (starts.length || entryTriggers.length)) add("ORCH001", "error", "Choose an entry node.");
    const forward = /* @__PURE__ */ new Map();
    for (const n of nodes) forward.set(n.id, []);
    for (const e of edges) {
      if (e.to.port === "back") continue;
      forward.get(e.from.node)?.push(e.to.node);
    }
    if (entry) {
      const seen = /* @__PURE__ */ new Set([entry]);
      const q = [entry];
      while (q.length) {
        const at = q.shift();
        for (const to of forward.get(at) || []) if (!seen.has(to)) {
          seen.add(to);
          q.push(to);
        }
      }
      for (const n of nodes) {
        if (n.type === "note") continue;
        if (!seen.has(n.id)) add("ORCH003", "warn", `"${n.name}" (${n.id}) cannot be reached from the entry.`, n.id);
      }
    }
    for (const n of nodes.filter((x) => x.type === "decision")) {
      const outs = edges.filter((e) => e.from.node === n.id);
      if (outs.length < 2) add("ORCH004", "warn", `Decision "${n.name}" has ${outs.length} outgoing edge(s); it needs a branch and an else.`, n.id);
      const elseEdges = outs.filter((e) => !e.condition);
      if (elseEdges.length === 0) add("ORCH004", "warn", `Decision "${n.name}" has no else edge (one outgoing edge with no condition).`, n.id);
      if (elseEdges.length > 1) add("ORCH004", "warn", `Decision "${n.name}" has ${elseEdges.length} else edges; only one may have no condition.`, n.id);
    }
    for (const n of nodes.filter((x) => x.type === "loop")) {
      const outs = edges.filter((e) => e.from.node === n.id);
      if (!outs.some((e) => e.from.port === "body")) add("ORCH005", "warn", `Loop "${n.name}" has no body edge.`, n.id);
      if (!outs.some((e) => e.from.port === "exit")) add("ORCH005", "warn", `Loop "${n.name}" has no exit edge, so it never leaves.`, n.id);
    }
    for (const n of nodes.filter((x) => x.type === "parallel" && str(x.config.mode) === "fan-out")) {
      const outs = edges.filter((e) => e.from.node === n.id);
      if (outs.length < 2) add("ORCH019", "warn", `Fan-out "${n.name}" has ${outs.length} outgoing edge(s); fan-out needs at least two.`, n.id);
    }
    const cycles = findCycles(nodes.map((n) => n.id), edges.filter((e) => e.to.port !== "back"));
    for (const cyc of cycles) {
      add("ORCH011", "error", `Cycle ${cyc.join(" -> ")} does not return through a loop's back port.`, cyc[0]);
    }
    for (const n of nodes.filter((x) => x.type === "subflow")) {
      const ref = isObj(n.config.ref) ? n.config.ref : null;
      if (ref && str(ref.graphId) === name) add("ORCH020", "error", `"${n.name}" references this orchestration.`, n.id);
    }
    const spec = {
      schema: ORCH_SCHEMA,
      schemaVersion: ORCH_SCHEMA_VERSION,
      ...input.id ? { id: str(input.id).slice(0, 80) } : {},
      name,
      description: str(input.description).slice(0, 2e3),
      direction,
      grid,
      entry,
      params,
      policy: {
        maxConcurrency: int(isObj(input.policy) ? input.policy.maxConcurrency : void 0, 1, 16) ?? 4,
        budgetSec: int(isObj(input.policy) ? input.policy.budgetSec : void 0, 1, 86400) ?? 900,
        onError: isObj(input.policy) && input.policy.onError === "continue" ? "continue" : "stop"
      },
      nodes,
      edges,
      meta: isObj(input.meta) ? { ...input.meta } : {}
    };
    const ok = !issues.some((i) => i.severity === "error" && BLOCKING.has(i.code));
    return { ok, spec, issues };
  }
  function findCycles(ids, edges) {
    const adj = /* @__PURE__ */ new Map();
    for (const id of ids) adj.set(id, []);
    for (const e of edges) adj.get(e.from.node)?.push(e.to.node);
    let index = 0;
    const idx = /* @__PURE__ */ new Map(), low = /* @__PURE__ */ new Map(), on = /* @__PURE__ */ new Set(), stack = [], out = [];
    const strong = (v) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      on.add(v);
      for (const w of adj.get(v) || []) {
        if (!idx.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          on.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) out.push(comp);
        else if ((adj.get(v) || []).includes(v)) out.push(comp);
      }
    };
    for (const id of ids) if (!idx.has(id)) strong(id);
    return out;
  }
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      const n = a << 16 | (b ?? 0) << 8 | (c ?? 0);
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (b === void 0 ? "" : B64[n >> 6 & 63]) + (c === void 0 ? "" : B64[n & 63]);
    }
    return out;
  }
  function fromBase64Url(text) {
    const clean = text.replace(/[^A-Za-z0-9_-]/g, "");
    const bytes = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c = [0, 0, 0, 0].map((_, k) => B64.indexOf(clean[i + k] ?? ""));
      const n = (c[0] << 18 | c[1] << 12 | (c[2] & 63) << 6 | c[3] & 63) >>> 0;
      bytes.push(n >> 16 & 255);
      if (i + 2 < clean.length) bytes.push(n >> 8 & 255);
      if (i + 3 < clean.length) bytes.push(n & 255);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  function mermaidText(s) {
    return s.replace(/"/g, "#quot;").replace(/\n/g, "<br/>").replace(/\|/g, "#124;");
  }
  function shapeFor(n) {
    const label2 = mermaidText(n.name || n.id);
    switch (n.type) {
      case "start":
      case "end":
        return ["([", "])"];
      case "agent":
        return ["[", "]"];
      case "tool":
        return ["[[", "]]"];
      case "decision":
        return ["{", "}"];
      case "parallel":
        return str(n.config.mode) === "join" ? ["(((", ")))"] : ["((", "))"];
      case "loop":
        return [">", "]"];
      case "approval":
        return ["{{", "}}"];
      case "trigger":
        return ["[/", "/]"];
      case "subflow":
        return ["[(", ")]"];
      case "note":
        return ["[", "]"];
    }
  }
  function toMermaid(spec) {
    const dir = spec.direction === "LR" ? "LR" : "TD";
    const canon = canonicalSpec(spec);
    const b64 = toBase64Url(canon);
    const wrapped = [];
    for (let i = 0; i < b64.length; i += 120) wrapped.push(`%% spec: ${b64.slice(i, i + 120)}`);
    const lines = [
      "%% beezilla-orchestration v1",
      ...wrapped,
      `flowchart ${dir}`
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
      const label2 = e.label || e.condition || "";
      lines.push(`  ${e.from.node} -->${label2 ? `|${mermaidText(label2)}|` : ""} ${e.to.node}`);
    }
    return lines.join("\n") + "\n";
  }
  function fromMermaid(text) {
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
  function toYaml(spec) {
    return canonicalSpec(spec);
  }
  function toRunSheet(spec) {
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    const outs = /* @__PURE__ */ new Map();
    for (const n of spec.nodes) outs.set(n.id, []);
    for (const e of spec.edges) {
      if (e.to.port === "back") continue;
      outs.get(e.from.node)?.push(e);
    }
    const steps = [];
    const seen = /* @__PURE__ */ new Map();
    const visit = (id) => {
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
        for (const b of branches) {
          steps.push({
            n: steps.length + 1,
            nodeId: b.to.node,
            text: `If ${b.condition}, go to ${label(b.to.node, byId)}${b.label ? ` (${b.label})` : ""}.`
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
      spec.params.length ? `Inputs: ${spec.params.map((p) => `${p.name}${p.required ? " (required)" : ""}: ${p.type || "string"}`).join("; ")}` : "Inputs: none.",
      "",
      ...steps.map((s) => `${s.n}. ${s.text}`)
    ].filter(Boolean).join("\n");
  }
  function label(id, byId) {
    const n = byId.get(id);
    return n ? `"${n.name}"` : id;
  }
  function describe(n, outs, byId) {
    const c = n.config;
    switch (n.type) {
      case "start":
        return `Start${outs.length ? `, then go to ${label(outs[0].to.node, byId)}` : ""}.`;
      case "agent": {
        const tools = Array.isArray(c.tools) && c.tools.length ? ` Tools: ${c.tools.join(", ")}.` : "";
        const model = str(c.model) ? ` Model: ${str(c.model)}.` : "";
        return `Agent "${n.name}"${model}: ${str(c.prompt)}${tools}`;
      }
      case "tool":
        return `Call tool "${str(c.tool)}"${isObj(c.args) && Object.keys(c.args).length ? ` with ${JSON.stringify(c.args)}` : ""}, then go to ${outs.map((e) => label(e.to.node, byId)).join(" or ") || "end"}.`;
      case "parallel":
        return str(c.mode) === "join" ? `Wait for ${str(c.join) || "all"} of the parallel branches to finish (${n.name}).` : `Run in parallel${int(c.maxConcurrency, 1, 16) ? ` (max ${int(c.maxConcurrency, 1, 16)})` : ""}: ${outs.map((e) => label(e.to.node, byId)).join(", ")}.`;
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
  function toGraphRows(spec) {
    return {
      nodes: spec.nodes.map((n) => ({
        key: n.id,
        // The approval node is the product's gate (buzzygrok 6675); everything else
        // keeps its own type now that 0063 widened the CHECK.
        kind: n.type === "approval" ? "gate" : n.type,
        title: n.name,
        config: { ...n.config, orchType: n.type, orchConfig: n.config },
        x: n.x,
        y: n.y
      })),
      edges: spec.edges.map((e) => ({
        from: e.from.node,
        to: e.to.node,
        kind: e.to.port === "approved" || e.to.port === "rejected" ? "gate" : "data"
      }))
    };
  }
  function parseGraphDetailPath(path) {
    const m = /^\/api\/buzzy\/graphs\/([A-Za-z0-9_-]+)(?:\/revisions(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return null;
    const graphId = m[1];
    const raw = m[2];
    if (raw === void 0) return { graphId, revision: null };
    if (!/^[0-9]+$/.test(raw)) return { graphId, revision: null, bad: raw };
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return { graphId, revision: null, bad: raw };
    return { graphId, revision: n };
  }
  return __toCommonJS(orchestration_exports);
})();
