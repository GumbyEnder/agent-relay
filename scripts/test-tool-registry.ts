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
  offeredHiveTools,
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

console.log("lockdown (the owner's privacy mode):");
const locked = offeredToolNames({ draftGateOpen: true, lockdown: true });
const outside = TOOL_POLICIES.filter((p) => p.egress).map((p) => p.name);
check("web, page reading and music are marked as leaving BeeZilla", ["web_search", "read_web_page", "generate_music"].every((n) => outside.includes(n)), outside.join(","));
check("lockdown offers none of them", outside.every((n) => !locked.includes(n)), locked.join(","));
check("lockdown keeps the local tools", ["calculate", "render_document", "render_sheet"].every((n) => locked.includes(n)), locked.join(","));
check("a withheld outside tool explains Lockdown", /Lockdown/.test(refusalFor("web_search", { draftGateOpen: true, lockdown: true }) ?? ""));
check("without lockdown nothing changes", outside.filter((n) => policyFor(n)?.offered).every((n) => offeredToolNames({ draftGateOpen: true, browser: true }).includes(n)));

console.log("BeeZilla's browser (the globe):");
check("offered only on a browser turn", !offeredToolNames({ draftGateOpen: true }).includes("use_browser") && offeredToolNames({ draftGateOpen: false, browser: true }).includes("use_browser"));
check("a browser turn keeps the read-only tools", ["web_search", "read_web_page"].every((n) => offeredToolNames({ draftGateOpen: false, browser: true }).includes(n)));
check("withheld, it says why", /browser node/.test(refusalFor("use_browser", { draftGateOpen: true }) ?? ""));

console.log("the Hive's tools (agents asking each other, hive.ts):");
const names = (tools: unknown[]) => (tools as Array<{ function?: { name?: string } }>).map((t) => String(t.function?.name));
const hiveNames = ["ask_bzilla", "ask_agent"];
const isHive = (n: string) => hiveNames.includes(n);
check("both are declared, with their own gate", hiveNames.every((n) => policyFor(n)?.gate === "hive"), JSON.stringify(hiveNames.map((n) => policyFor(n)?.gate)));
check(
  "never in the generic always-on list, at any gate and in Lockdown",
  [{ draftGateOpen: false }, { draftGateOpen: true }, { draftGateOpen: true, lockdown: true }, { draftGateOpen: false, hive: {} }, { draftGateOpen: true, hive: { askBzilla: false, askAgent: false } }]
    .every((ctx) => !offeredToolNames(ctx).some(isHive) && !names(offeredTools(ctx)).some(isHive) && offeredHiveTools(ctx).length === 0),
);
check("a turn that is not offered them has the offered set it always had", offeredToolNames({ draftGateOpen: false, hive: {} }).join() === closed.join() && offeredToolNames({ draftGateOpen: true, hive: {} }).join() === open.join());
check("askBzilla offers ask_bzilla and only that", names(offeredHiveTools({ draftGateOpen: false, hive: { askBzilla: true } })).join() === "ask_bzilla");
check("askAgent offers ask_agent and only that", names(offeredHiveTools({ draftGateOpen: false, hive: { askAgent: true } })).join() === "ask_agent");
check("both flags offer both", names(offeredHiveTools({ draftGateOpen: false, hive: { askBzilla: true, askAgent: true } })).join() === "ask_bzilla,ask_agent");
const withHive = offeredToolNames({ draftGateOpen: false, hive: { askBzilla: true } });
check("with the draft gate shut the Hive's tool joins the always-on ones, not the draft ones", withHive.join() === [...closed, "ask_bzilla"].join(), withHive.join(","));
const withHiveOpen = offeredToolNames({ draftGateOpen: true, hive: { askAgent: true } });
check("with the draft gate open it joins those too", withHiveOpen.join() === [...open, "ask_agent"].join(), withHiveOpen.join(","));
const hiveSchemas = offeredTools({ draftGateOpen: false, hive: { askBzilla: true, askAgent: true } });
check("one schema per offered tool, the Hive's included", hiveSchemas.length === offeredToolNames({ draftGateOpen: false, hive: { askBzilla: true, askAgent: true } }).length && names(hiveSchemas).slice(-2).join() === "ask_bzilla,ask_agent", names(hiveSchemas).join(","));
check("Lockdown leaves them on (nothing leaves BeeZilla that the turn's own model call does not)", names(offeredTools({ draftGateOpen: true, lockdown: true, hive: { askBzilla: true, askAgent: true } })).filter(isHive).join() === "ask_bzilla,ask_agent");
check("they declare 45 seconds, 4000 bytes, nothing outside BeeZilla, read-only", hiveNames.every((n) => {
  const p = policyFor(n)!;
  return p.timeoutMs === 45_000 && p.maxResultBytes === 4_000 && !p.egress && p.sideEffects === "read-only" && p.offered;
}), JSON.stringify(hiveNames.map((n) => policyFor(n))));
const askRefusal = refusalFor("ask_bzilla", { draftGateOpen: false });
check("ask_bzilla withheld says why, in words: only an agent that has a job can ask", !!askRefusal && /not available in this conversation/.test(askRefusal) && /agents? that has a job can ask BeeZilla/.test(askRefusal), String(askRefusal));
const agentRefusal = refusalFor("ask_agent", { draftGateOpen: true });
check("ask_agent withheld says why, in words: BeeZilla only, and only when the message is about an agent", !!agentRefusal && /not available in this conversation/.test(agentRefusal) && /only BeeZilla herself/.test(agentRefusal) && /about one of them/.test(agentRefusal), String(agentRefusal));
check("a tool offered to the other speaker is still withheld from this one", refusalFor("ask_agent", { draftGateOpen: false, hive: { askBzilla: true } }) !== null && refusalFor("ask_bzilla", { draftGateOpen: false, hive: { askAgent: true } }) !== null);
check("an offered one has no refusal", refusalFor("ask_bzilla", { draftGateOpen: false, hive: { askBzilla: true } }) === null && refusalFor("ask_agent", { draftGateOpen: false, hive: { askAgent: true } }) === null);
const askSchema = (n: string) => (offeredHiveTools({ draftGateOpen: false, hive: { askBzilla: true, askAgent: true } }) as Array<{ function: { name: string; parameters: { required: string[] } } }>).find((t) => t.function.name === n)!.function;
check("ask_bzilla needs a question; ask_agent needs an agent and a question", askSchema("ask_bzilla").parameters.required.join() === "question" && askSchema("ask_agent").parameters.required.join() === "agent,question");
const hiveRun = await withToolBudget("ask_agent", async () => "answered");
check("a delegation runs inside its budget like every other tool", hiveRun.ok && hiveRun.value === "answered");
const hiveCut = clampResult("ask_bzilla", "y".repeat(9000));
check("and its result is cut at 4000", hiveCut.length < 4200 && /trimmed at 4000/.test(hiveCut), String(hiveCut.length));

console.log("one mode just going (documents only):");
// oneMode.ts opens the gate when it decides to just do real work. That puts the
// document makers on the table, never the outside makers that spend plan minutes.
const going = offeredToolNames({ draftGateOpen: true, documentsOnly: true });
check("documents, slides and sheets are offered", ["render_document", "render_presentation", "render_sheet"].every((n) => going.includes(n)), going.join(","));
check("music and video are not", !going.includes("generate_music") && !going.includes("generate_video"), going.join(","));
check("the always-on tools stay", ["calculate", "web_search"].every((n) => going.includes(n)), going.join(","));
check("a withheld maker says it runs when asked", /when the owner asks/.test(refusalFor("generate_video", { draftGateOpen: true, documentsOnly: true }) ?? ""));
check("documentsOnly changes nothing while the gate is shut", offeredToolNames({ draftGateOpen: false, documentsOnly: true }).join() === offeredToolNames({ draftGateOpen: false }).join());

console.log("result clamp:");
const clamped = clampResult("web_search", "x".repeat(20000));
check("result is trimmed to the declared cap", clamped.length < 20000 && /trimmed/.test(clamped));

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("tool registry: all checks passed");
