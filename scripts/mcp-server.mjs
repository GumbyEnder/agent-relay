#!/usr/bin/env node
/**
 * Stdio JSON-RPC MCP server — Dev Boards five verbs (+ create).
 *
 * Usage:
 *   DEVBOARDS_BASE_URL=https://app.devboards.ai \
 *   DEVBOARDS_API_KEY=ark_… \
 *   DEVBOARDS_AGENT=forge \
 *   node scripts/mcp-server.mjs
 *
 * Env aliases: AGENT_RELAY_BASE_URL, AGENT_RELAY_API_KEY
 */
import readline from "node:readline";

const base = (
  process.env.DEVBOARDS_BASE_URL ??
  process.env.AGENT_RELAY_BASE_URL ??
  "http://127.0.0.1:8090"
).replace(/\/$/, "");
const key = process.env.DEVBOARDS_API_KEY ?? process.env.AGENT_RELAY_API_KEY ?? "";
const defaultAgent = process.env.DEVBOARDS_AGENT ?? process.env.AGENT_RELAY_AGENT ?? "";
const defaultBoard = process.env.DEVBOARDS_BOARD ?? process.env.AGENT_RELAY_BOARD ?? "";

const TOOLS = [
  {
    name: "poll",
    description:
      "List claimable missions (Ready by default). Prefers skill∩tag matches when agent has skills.",
    inputSchema: {
      type: "object",
      properties: {
        column: { type: "string", description: "ready|inbox|…" },
        limit: { type: "number" },
        agent: { type: "string" },
        project: { type: "string", description: "board id or slug" },
        match_agent_skills: {
          type: "boolean",
          description: "If true, only return skill-matching missions",
        },
      },
    },
  },
  {
    name: "claim",
    description: "Atomically claim a mission (Running)",
    inputSchema: {
      type: "object",
      properties: {
        mission_id: { type: "string" },
        agent: { type: "string" },
      },
      required: ["mission_id"],
    },
  },
  {
    name: "heartbeat",
    description: "Progress heartbeat on a claimed mission",
    inputSchema: {
      type: "object",
      properties: {
        mission_id: { type: "string" },
        agent: { type: "string" },
        note: { type: "string" },
      },
      required: ["mission_id"],
    },
  },
  {
    name: "escalate",
    description: "Escalate with one clear human question (Needs human)",
    inputSchema: {
      type: "object",
      properties: {
        mission_id: { type: "string" },
        agent: { type: "string" },
        question: { type: "string" },
      },
      required: ["mission_id", "question"],
    },
  },
  {
    name: "deliver",
    description: "Deliver mission to Review with summary and optional artifacts/usage",
    inputSchema: {
      type: "object",
      properties: {
        mission_id: { type: "string" },
        agent: { type: "string" },
        summary: { type: "string" },
        artifacts: { type: "array", items: { type: "string" } },
        usage: { type: "object" },
      },
      required: ["mission_id"],
    },
  },
  {
    name: "create",
    description: "File a new mission (default inbox) on an allowed board",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        project: { type: "string" },
        column: { type: "string" },
        priority: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        agent: { type: "string" },
      },
      required: ["title", "objective"],
    },
  },
];

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { raw: text } };
  }
}

function agentOf(args) {
  return args.agent ?? defaultAgent;
}

async function callTool(name, args = {}) {
  const agent = agentOf(args);
  if (name === "poll") {
    const q = new URLSearchParams({
      column: args.column ?? "ready",
      limit: String(args.limit ?? 5),
      ...(agent ? { agent } : {}),
      ...(args.project || defaultBoard
        ? { project: args.project ?? defaultBoard }
        : {}),
      ...(args.match_agent_skills === true || args.match_agent_skills === "1"
        ? { match_agent_skills: "1" }
        : {}),
    });
    return api("GET", `/api/agent/missions?${q}`);
  }
  if (name === "create") {
    return api("POST", "/api/agent/missions", {
      agent,
      project: args.project ?? defaultBoard,
      column: args.column ?? "inbox",
      title: args.title,
      objective: args.objective,
      priority: args.priority ?? "p2",
      tags: args.tags ?? [],
    });
  }
  const id = args.mission_id ?? args.missionId;
  if (name === "claim") return api("POST", `/api/agent/missions/${id}/claim`, { agent });
  if (name === "heartbeat")
    return api("POST", `/api/agent/missions/${id}/heartbeat`, { agent, note: args.note });
  if (name === "escalate")
    return api("POST", `/api/agent/missions/${id}/escalate`, {
      agent,
      question: args.question,
    });
  if (name === "deliver")
    return api("POST", `/api/agent/missions/${id}/deliver`, {
      agent,
      summary: args.summary ?? "",
      artifacts: args.artifacts ?? [],
      ...(args.usage ? { usage: args.usage } : {}),
    });
  return { status: 400, json: { error: `unknown tool ${name}` } };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "devboards", version: "1.1.0" },
        },
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list" || method === "list_tools") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call" || method === "call_tool") {
      const name = msg.params?.name ?? msg.params?.tool;
      const args = msg.params?.arguments ?? msg.params?.args ?? {};
      const out = await callTool(name, args);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(out.json, null, 2) }],
          isError: out.status >= 400 || out.json?.ok === false,
        },
      });
      return;
    }
    if (id != null) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (id != null) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }
});
