#!/usr/bin/env node
/**
 * Minimal stdio JSON-RPC MCP-like server for Agent Relay five verbs.
 * Protocol subset: tools/list, tools/call
 *
 * Usage:
 *   DATABASE_URL=... node scripts/mcp-server.mjs
 *
 * Env: AGENT_RELAY_BASE_URL (default http://127.0.0.1:8090)
 *      AGENT_RELAY_API_KEY optional bearer
 */
import readline from "node:readline";

const base = (process.env.AGENT_RELAY_BASE_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const key = process.env.AGENT_RELAY_API_KEY ?? "";

const TOOLS = [
  { name: "poll", description: "List claimable missions" },
  { name: "claim", description: "Claim a mission" },
  { name: "heartbeat", description: "Heartbeat a mission" },
  { name: "escalate", description: "Escalate to human" },
  { name: "deliver", description: "Deliver for review" },
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

async function callTool(name, args = {}) {
  if (name === "poll") {
    const q = new URLSearchParams({
      column: args.column ?? "ready",
      limit: String(args.limit ?? 5),
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.projectId ? { project: args.projectId } : {}),
    });
    return api("GET", `/api/agent/missions?${q}`);
  }
  const id = args.mission_id ?? args.missionId;
  if (name === "claim") return api("POST", `/api/agent/missions/${id}/claim`, { agent: args.agent });
  if (name === "heartbeat")
    return api("POST", `/api/agent/missions/${id}/heartbeat`, { agent: args.agent, note: args.note });
  if (name === "escalate")
    return api("POST", `/api/agent/missions/${id}/escalate`, {
      agent: args.agent,
      question: args.question,
    });
  if (name === "deliver")
    return api("POST", `/api/agent/missions/${id}/deliver`, {
      agent: args.agent,
      summary: args.summary ?? "",
      artifacts: args.artifacts ?? [],
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
          isError: out.status >= 400,
        },
      });
      return;
    }
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "agent-relay", version: "0.3.0" },
          capabilities: { tools: {} },
        },
      });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
    });
  }
});
