#!/usr/bin/env node
/**
 * Tool-call reliability fixture (plan doc 23, open decision #3 worked).
 *
 * 20 synthetic turns per model across the four shapes the loop actually
 * sees, scored pass/fail per turn. Decision rule:
 *   >=95% clean  -> native tool_calls, fallback dormant
 *   80–95%       -> native + fallback on malformed results
 *   <80%         -> structured-JSON prompt becomes the primary path
 *
 * Usage: BZ_CHAT_MODEL=<model> node scripts/tool-reliability-fixture.mjs
 * Re-run on any BZ_CHAT_MODELS addition or version bump.
 */

const BASE_URL = (process.env.BZ_CHAT_BASE_URL || "https://inference-api.nousresearch.com/v1").replace(/\/+$/, "");
const API_KEY = process.env.BZ_CHAT_KEY;
const MODEL = process.env.BZ_CHAT_MODEL || "z-ai/glm-5.3-flash";

const RENDER_TOOL = {
  type: "function",
  function: {
    name: "render_document",
    description: "Render the finished document as a real Word file.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
            },
            required: ["heading", "paragraphs"],
          },
        },
      },
      required: ["title", "sections"],
    },
  },
};

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

/** The four shapes: [userMessage, expectToolCalls, offeredTools] */
const SHAPES = [
  ["What is the weather in Orlando? Use the weather tool.", true, [WEATHER_TOOL]],
  ["Get the weather for Miami and for Tampa using the tool.", true, [WEATHER_TOOL]],
  ["Write me a one-paragraph note about our meeting, then use the weather tool to check Orlando.", true, [WEATHER_TOOL]],
  ["Say hello and tell me a one-line joke. Do not use any tools.", false, [WEATHER_TOOL]],
];

const RESULTS_LOG = process.env.FIXTURE_LOG || null;

async function callModel(messages, tools, toolChoice) {
  const body = { model: MODEL, messages, tools, max_tokens: 4096, stream: false };
  if (toolChoice) body.tool_choice = toolChoice;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function score(turn, response) {
  const msg = response.choices?.[0]?.message ?? {};
  const tc = msg.tool_calls ?? [];
  const finish = response.choices?.[0]?.finish_reason;
  const content = (msg.content ?? "").trim();
  const failures = [];

  if (turn.expectToolCalls) {
    if (tc.length === 0) failures.push("no tool_calls");
    for (const c of tc) {
      if (c.function?.name && !["get_weather", "render_document"].includes(c.function.name)) {
        failures.push(`hallucinated tool: ${c.function.name}`);
      }
      try {
        const args = JSON.parse(c.function?.arguments ?? "{}");
        if (typeof args !== "object") failures.push("arguments not an object");
      } catch {
        failures.push("arguments not valid JSON");
      }
    }
  } else {
    if (tc.length > 0) failures.push("unexpected tool_calls");
    if (!content) failures.push("no content for a no-tool turn");
  }
  if (!turn.expectToolCalls && finish === "tool_calls") failures.push("wrong finish_reason");
  return { pass: failures.length === 0, failures, finish, hadContent: !!content };
}

async function main() {
  if (!API_KEY) {
    console.error("BZ_CHAT_KEY is required");
    process.exit(1);
  }
  const runs = [];
  let passCount = 0;
  // 5 rounds x 4 shapes = 20 turns
  for (let round = 1; round <= 5; round++) {
    for (let s = 0; s < SHAPES.length; s++) {
      const [message, expectToolCalls, tools] = SHAPES[s];
      const label = `round${round}/shape${s + 1}`;
      try {
        const response = await callModel([{ role: "user", content: message }], tools, undefined);
        const result = score({ expectToolCalls }, response);
        runs.push({ label, pass: result.pass, failures: result.failures, finish: result.finish });
        if (result.pass) passCount++;
        console.log(`${result.pass ? "PASS" : "FAIL"} ${label} finish=${result.finish}${result.failures.length ? " :: " + result.failures.join(", ") : ""}`);
      } catch (err) {
        runs.push({ label, pass: false, failures: [String(err.message ?? err)] });
        console.log(`FAIL ${label} :: ${err.message ?? err}`);
      }
    }
  }
  const pct = Math.round((passCount / runs.length) * 100);
  console.log(`\n${MODEL}: ${passCount}/${runs.length} clean (${pct}%)`);
  console.log(
    pct >= 95 ? "DECISION: native tool_calls, fallback dormant"
    : pct >= 80 ? "DECISION: native + fallback on malformed results"
    : "DECISION: structured-JSON prompt becomes the primary path for this model",
  );
  if (RESULTS_LOG) {
    const fs = await import("node:fs");
    fs.writeFileSync(RESULTS_LOG, JSON.stringify({ model: MODEL, pct, passCount, runs }, null, 2));
    console.log(`results written to ${RESULTS_LOG}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
