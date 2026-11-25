/**
 * CR-3 — the orchestration spec, its validator, and the three projections.
 *
 * Hermetic and offline: pure functions over the golden fixture, no DB and no HTTP.
 *   npx tsx scripts/test-orchestration.ts
 *
 * What it holds us to:
 *   - the golden 11-node flow validates with no blocking issue (decision, fan-out,
 *     join, loop, approval, note), and a half-drawn flow still validates *with*
 *     warnings;
 *   - x/y snap to the grid on the way in (a drag at 13 on a 16 grid is 16);
 *   - canonical JSON ignores key order and float dust, so round-tripping Mermaid
 *     compares equal;
 *   - export -> import is exact, because Mermaid cannot hold prompts or schemas and
 *     the spec rides in a %% comment;
 *   - the run sheet names every branch, the loop bound and the approval;
 *   - each blocking code fires on the graph that should trip it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalSpec,
  fromMermaid,
  parseExpression,
  parseGraphDetailPath,
  snap,
  toMermaid,
  toRunSheet,
  toYaml,
  validateOrchestration,
  type OrchSpec,
} from "../src/lib/buzzy/orchestration";

let pass = 0;
let fail = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const eq = (a: unknown, b: unknown, msg = "") => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const has = (issues: Array<{ code: string }>, code: string, msg = `expected ${code}`) => {
  if (!issues.some((i) => i.code === code)) {
    throw new Error(`${msg}; got ${issues.map((i) => i.code).join(", ") || "none"}`);
  }
};

const golden = JSON.parse(readFileSync(join(process.cwd(), "scripts/fixtures/orchestration-golden.json"), "utf8"));
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(golden));

console.log("orchestration spec");

ok("golden fixture validates with no blocking issue", () => {
  const r = validateOrchestration(golden);
  if (!r.ok) throw new Error(`blocked: ${r.issues.filter((i) => i.severity === "error").map((i) => `${i.code} ${i.message}`).join(" | ")}`);
  eq(r.spec.nodes.length, 12);
  eq(r.spec.edges.length, 14);
  eq(r.spec.entry, "n_start");

  // The three review deltas, held by assertion so they cannot regress:
  // 1. the decision's else edge ends the run — it is not a cycle back into n_res.
  const elseEdge = r.spec.edges.find((e) => e.id === "e4")!;
  eq(elseEdge.condition, null);
  eq(elseEdge.to.node, "n_end");
  if (r.issues.some((i) => i.code === "ORCH011")) throw new Error("golden closes a cycle outside a loop back port");
  // 2. every binding names something that exists: the join declares "draft", and
  //    the end output is named for what it carries.
  const join = r.spec.nodes.find((n) => n.id === "n_join")!;
  eq(join.config.output, { name: "draft" });
  const end = r.spec.nodes.find((n) => n.id === "n_end")!;
  eq(Object.keys(end.config.outputs as Record<string, string>), ["score"]);
  if (r.issues.some((i) => ["ORCH006", "ORCH009"].includes(i.code))) {
    throw new Error(`golden has a binding/port issue: ${r.issues.map((i) => i.code).join(", ")}`);
  }
  // 3. no unknown ports anywhere in a clean graph.
  if (r.issues.some((i) => i.code === "ORCH009")) throw new Error("golden uses an unknown port");
});

ok("x/y snap to the grid on the way in", () => {
  const g = clone();
  g.nodes[1].x = 13; g.nodes[1].y = -7;
  const r = validateOrchestration(g);
  const n = r.spec.nodes.find((x) => x.id === "n_res")!;
  eq(n.x, 16); eq(n.y, -0);
  eq(snap(27, 16), 32);
  eq(snap(8, 16), 16);
});

ok("canonical JSON ignores key order", () => {
  const a = validateOrchestration(golden).spec;
  // Rebuild the same spec with every object's keys in reverse insertion order.
  const reverse = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reverse);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).reverse()) {
        out[k] = reverse((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  eq(canonicalSpec(reverse(a) as OrchSpec), canonicalSpec(a));
});

ok("Mermaid export carries shapes by type and the spec comment", () => {
  const spec = validateOrchestration(golden).spec;
  const mmd = toMermaid(spec);
  truthy(mmd.startsWith("%% beezilla-orchestration v1\n"), "version comment");
  truthy(/%% spec: [A-Za-z0-9_-]+/.test(mmd), "spec comment");
  truthy(mmd.includes("flowchart TD"), "direction");
  truthy(mmd.includes('n_start(["Start"])'), "start stadium");
  truthy(mmd.includes("n_fan((\"Draft in parallel\"))"), "fan-out double circle");
  truthy(mmd.includes('n_join((("Join drafts")))'), "join triple circle");
  truthy(mmd.includes('n_loop>"Tighten until clean"]'), "loop asymmetric");
  truthy(mmd.includes('n_appr{{"Owner approves the brief"}}'), "approval hexagon");
  truthy(mmd.includes("n_dec{\"Enough findings?\"}"), "decision rhombus");
  truthy(mmd.includes("%% note n_note:"), "note is a comment");
});

ok("Mermaid export -> import is byte-exact", () => {
  const spec = validateOrchestration(golden).spec;
  const back = fromMermaid(toMermaid(spec));
  if (!back.ok) throw new Error(back.error);
  eq(canonicalSpec(back.spec), canonicalSpec(spec));
});

ok("YAML is canonical JSON (round-trips without losing a field)", () => {
  const spec = validateOrchestration(golden).spec;
  eq(toYaml(spec), canonicalSpec(spec));
});

ok("run sheet names branches, loop bound and approval", () => {
  const spec = validateOrchestration(golden).spec;
  const sheet = toRunSheet(spec);
  truthy(sheet.includes("RUN SHEET — Research and ship a brief"), "title");
  truthy(sheet.includes("Inputs: topic (required): string"), "params");
  truthy(/If \$n_res\.findings\.length >= 3, go to "Draft in parallel"/.test(sheet), "yes branch");
  truthy(/Otherwise go to "End"/.test(sheet), "else branch");
  truthy(/Run in parallel/.test(sheet), "fan-out");
  truthy(/Wait for all of the parallel branches/.test(sheet), "join");
  truthy(/repeat until \$n_edit\.score >= 0\.85; max 3 iteration/.test(sheet), "loop bound");
  truthy(/Stop for approval from owner/.test(sheet), "approval");
});

ok("expression grammar accepts bindings, comparisons and booleans", () => {
  for (const src of [
    "$n_res.findings.length >= 3",
    "$input.topic != \"\"",
    "!($n_edit.score > 0.8) && $n_appr.approved",
    "$n_x.items[0].name == 'a'",
  ]) {
    const p = parseExpression(src);
    truthy(p.ok, `${src}: ${p.error}`);
  }
  const refs = parseExpression("$n_res.findings.length >= 3 and true").refs;
  void refs;
});

ok("expression grammar rejects prose and bad bindings", () => {
  if (parseExpression("has findings").ok) throw new Error("prose parsed");
  if (parseExpression("$n_res").ok) throw new Error("bare node parsed");
  if (parseExpression("$n_res.findings >= ").ok) throw new Error("dangling operator parsed");
  if (parseExpression("$n_res.findings &&").ok) throw new Error("dangling and parsed");
});

ok("half-drawn flow is savable with warnings", () => {
  const g = clone();
  g.nodes = g.nodes.filter((n: any) => n.id !== "n_end");
  const r = validateOrchestration(g);
  has(r.issues, "ORCH002");
  truthy(r.issues.some((i) => i.code === "ORCH002" && i.severity === "error"), "ORCH002 is blocking");
  // remove the else edge: warning, not block
  const g2 = clone();
  g2.edges = g2.edges.filter((e: any) => e.id !== "e4");
  const r2 = validateOrchestration(g2);
  has(r2.issues, "ORCH004");
  truthy(r2.issues.find((i) => i.code === "ORCH004")!.severity === "warn");
  truthy(r2.ok, "decision warning must not block a save");
});

ok("blocking codes fire on the graph that breaks them", () => {
  const noStart = clone(); noStart.nodes = noStart.nodes.filter((n: any) => n.id !== "n_start");
  has(validateOrchestration(noStart).issues, "ORCH001");

  // An unknown port is a BLOCK, not a warning: the edge cannot be routed.
  const badPort = clone();
  badPort.edges.find((e: any) => e.id === "e3").from.port = "yes";
  const bp = validateOrchestration(badPort);
  const bpIssue = bp.issues.find((i) => i.code === "ORCH009");
  truthy(bpIssue, `expected ORCH009; got ${bp.issues.map((i) => i.code).join(", ")}`);
  truthy(bpIssue!.severity === "error", "ORCH009 must be an error");
  truthy(!bp.ok, "unknown port must block a save");

  const noteEdge = clone();
  noteEdge.edges.push({ id: "e99", from: { node: "n_note", port: "out" }, to: { node: "n_end", port: "in" }, label: "", condition: null });
  const nr = validateOrchestration(noteEdge);
  has(nr.issues, "ORCH012"); truthy(!nr.ok, "note edge must block");

  const dup = clone(); dup.nodes.push({ ...dup.nodes[0], name: "Start again" });
  has(validateOrchestration(dup).issues, "ORCH007");

  const badRef = clone();
  badRef.nodes.find((n: any) => n.id === "n_res").config.inputs.topic = "$input.nope";
  has(validateOrchestration(badRef).issues, "ORCH006");

  const badOut = clone();
  badOut.nodes.find((n: any) => n.id === "n_w1").config.inputs.findings = "$n_res.nothing";
  has(validateOrchestration(badOut).issues, "ORCH006");

  const noExit = clone(); noExit.edges = noExit.edges.filter((e: any) => e.id !== "e12");
  const xr = validateOrchestration(noExit);
  has(xr.issues, "ORCH005"); truthy(xr.issues.find((i) => i.code === "ORCH005")!.severity === "warn");

  const noPrompt = clone(); noPrompt.nodes.find((n: any) => n.id === "n_res").config.prompt = "  ";
  has(validateOrchestration(noPrompt).issues, "ORCH010");

  const unknown = clone(); unknown.nodes.find((n: any) => n.id === "n_res").type = "robot";
  has(validateOrchestration(unknown).issues, "ORCH015");

  const illegalCycle = clone();
  illegalCycle.edges.push({ id: "e98", from: { node: "n_appr", port: "approved" }, to: { node: "n_res", port: "in" }, label: "", condition: null });
  const cr = validateOrchestration(illegalCycle);
  // The golden already has a legal loop cycle; this adds one that never touches a loop back port.
  truthy(cr.issues.some((i) => i.code === "ORCH011"), `expected ORCH011; got ${cr.issues.map((i) => i.code).join(", ")}`);

  const selfRef = clone();
  selfRef.nodes.push({ id: "n_sub", type: "subflow", name: "Self", x: 0, y: 1200, notes: "",
    config: { ref: { graphId: "Research and ship a brief", revision: null }, inputs: {}, output: { name: "x" } } });
  has(validateOrchestration(selfRef).issues, "ORCH020");

  const badTrigger = clone();
  badTrigger.nodes.push({ id: "n_trig", type: "trigger", name: "Cron", x: 0, y: -96, notes: "",
    config: { mode: "entry", trigger: { kind: "schedule" } } });
  badTrigger.entry = "n_trig";
  has(validateOrchestration(badTrigger).issues, "ORCH017");
});

ok("the page is registered in one nav and one route table", () => {
  const pages = readFileSync(join(process.cwd(), "src/lib/buzzy/pages.nitro.ts"), "utf8");
  const nav = readFileSync(join(process.cwd(), "public/buzzy/nav.js"), "utf8");
  truthy(/PAGES = new Set\(\[[^\]]*"orchestrate"/.test(pages), "PAGES has orchestrate");
  truthy(pages.includes('href="/buzzy/orchestrate" data-nav="orchestrate"'), "NAV_ROW has the anchor");
  truthy(/id: "orchestrate", href: "\/buzzy\/orchestrate"/.test(nav), "nav.js LINKS has orchestrate");
  truthy(pages.includes('name === "graph"') && pages.includes('return sendRedirect(event, "/buzzy/orchestrate"'), "graph redirects");
});

ok("the revisions route parses its path, not its index", () => {
  // The bug this replaces: the route tested the literal "revisions" segment, so the
  // list branch was unreachable and every call answered 400 bad_revision.
  const list = parseGraphDetailPath("/api/buzzy/graphs/g1/revisions");
  truthy(list !== null, "list path parses");
  eq(list!.graphId, "g1");
  eq(list!.revision, null);
  eq(list!.bad, undefined);

  const one = parseGraphDetailPath("/api/buzzy/graphs/g1/revisions/2");
  eq(one!.graphId, "g1");
  eq(one!.revision, 2);

  eq(parseGraphDetailPath("/api/buzzy/graphs/g1")!.revision, null);
  eq(parseGraphDetailPath("/api/buzzy/graphs/g1")!.graphId, "g1");

  // A bad revision must be reported, never silently treated as "list everything".
  eq(parseGraphDetailPath("/api/buzzy/graphs/g1/revisions/0")!.revision, null);
  eq(parseGraphDetailPath("/api/buzzy/graphs/g1/revisions/0")!.bad, "0");
  eq(parseGraphDetailPath("/api/buzzy/graphs/g1/revisions/abc")!.bad, "abc");

  eq(parseGraphDetailPath("/api/buzzy/graphs/g1/run"), null);
  eq(parseGraphDetailPath("/api/buzzy/runs/x"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
