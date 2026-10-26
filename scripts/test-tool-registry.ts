/**
 * Contract tests for the tool registry (plan wave 1, A1/A2/A4).
 *
 * These pin the properties that were previously prose: what is offered per
 * gate, that a withheld tool explains itself, and that every tool has a budget.
 * Run: npx tsx scripts/test-tool-registry.ts
 */
import {
  TOOL_POLICIES,
  offeredTools,
  offeredToolNames,
  policyFor,
  refusalFor,
  withToolBudget,
  clampResult,
} from "../src/lib/buzzy/toolRegistry";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("closed gate:");
const closed = offeredToolNames({ draftGateOpen: false });
check("offers read-only tools", ["web_search", "read_web_page", "lookup_market_rate", "search_knowledge", "calculate"].every((n) => closed.includes(n)), closed.join(","));
check("withholds every render tool", !closed.some((n) => n.startsWith("render_")), closed.join(","));
check("withholds the superseded fetch_website", !closed.includes("fetch_website"), closed.join(","));

console.log("open gate:");
const open = offeredToolNames({ draftGateOpen: true });
check("offers render tools", ["render_document", "render_presentation", "render_sheet"].every((n) => open.includes(n)), open.join(","));
check("still withholds fetch_website", !open.includes("fetch_website"), open.join(","));

console.log("schemas match the offered set:");
const schemas = offeredTools({ draftGateOpen: false }) as Array<{ function?: { name?: string } }>;
check(
  "one schema per offered tool",
  schemas.length === closed.length && schemas.every((s) => closed.includes(String(s.function?.name))),
  JSON.stringify(schemas.map((s) => s.function?.name)),
);

console.log("refusals carry a reason:");
const renderRefusal = refusalFor("render_document", { draftGateOpen: false });
check("gated render tool explains itself", !!renderRefusal && /brief|deliverable/i.test(renderRefusal), String(renderRefusal));
check("allowed tool has no refusal", refusalFor("web_search", { draftGateOpen: false }) === null);
check("unknown tool is named as unknown", /not a tool/i.test(String(refusalFor("teleport", { draftGateOpen: false }))));
check("superseded tool says why", /read_web_page/i.test(String(refusalFor("fetch_website", { draftGateOpen: true }))));

console.log("budgets:");
check(
  "every policy declares a wall clock and a byte cap",
  TOOL_POLICIES.every((p) => p.timeoutMs > 0 && p.maxResultBytes > 0),
  TOOL_POLICIES.filter((p) => !(p.timeoutMs > 0 && p.maxResultBytes > 0)).map((p) => p.name).join(","),
);
check("read_web_page budget exceeds the browser render budget", (policyFor("read_web_page")?.timeoutMs ?? 0) >= 30000);

console.log("timeout is a named failure:");
const slow = await withToolBudget("calculate", () => new Promise<string>((r) => setTimeout(() => r("late"), 3000)));
check("a tool past its budget fails by name", !slow.ok && /calculate/.test(String(slow.error)), String(slow.error));
const fast = await withToolBudget("calculate", async () => "1+1=2");
check("a fast tool returns its value", fast.ok && fast.value === "1+1=2");

console.log("result clamp:");
const clamped = clampResult("web_search", "x".repeat(20000));
check("result is trimmed to the declared cap", clamped.length < 20000 && /trimmed/.test(clamped));

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("tool registry: all checks passed");
