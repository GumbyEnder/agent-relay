// A stand-in chat model for the built-server probes. No key, no network, no cost.
//
// Why this exists: scripts/probe-new-conversation.mjs drives real chat turns — the
// seed card, the late answer, a second tab, a conversation reopened from History —
// so without a chat model the server answers nothing. That meant the probe could
// only be run by hand, signed in, against a live account, which is exactly how the
// behaviour it pins reached live QA in the first place. CI gets this instead.
//
// Point BeeZilla at it with:
//   BZ_CHAT_BASE_URL=http://127.0.0.1:<port>/v1
//   BZ_CHAT_KEY=stand-in BZ_CHAT_MODEL=stand-in BZ_EXTRACT_MODEL=stand-in
//
// It echoes the ask back ("Stand-in reply: <the ask>"), which is what the probe
// looks for when it checks that a reply shows in a tab that did not ask for it, or
// that a reply arrives after the conversation was reopened.
//
// The delay matters: 3.5 s is slow enough that "New conversation" is pressed while
// the answer is still on its way (probe step 5) and fast enough that the probe's
// 11 s wait sees it land.
//
// usage: node scripts/stand-in-model.mjs [--port 8246] [--delay 3500]
import { createServer } from "node:http";

const num = (flag, env, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i > 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return Number(process.env[env] || fallback);
};
const PORT = num("--port", "STAND_IN_PORT", 8246);
const DELAY = num("--delay", "STAND_IN_DELAY_MS", 3500);

const asText = (part) => (typeof part === "string" ? part : String(part?.text || ""));
const contentOf = (m) => (typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map(asText).join(" ") : "");

function replyTo(messages) {
  const lastUser = [...(messages || [])].reverse().find((m) => m?.role === "user");
  const ask = contentOf(lastUser).trim().slice(0, 300);
  return ask ? `Stand-in reply: ${ask}` : "Stand-in reply."; // echoed back on purpose
}

// What the server actually sent. probe-agent-colonies.mjs reads GET /last to
// assert BeeZilla's system prompt names the colony it is working inside; a probe
// that cannot see the prompt only looks like it checks that. Bounded so a long
// probe cannot grow this without limit.
const seen = [];
function remember(messages) {
  const list = messages || [];
  const system = list.filter((m) => m?.role === "system").map(contentOf).join("\n");
  const user = contentOf([...list].reverse().find((m) => m?.role === "user")).trim();
  seen.push({ at: Date.now(), system, user: user.slice(0, 300) });
  if (seen.length > 50) seen.splice(0, seen.length - 50);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && /\/models$/.test(req.url || "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] }));
    return;
  }
  if (req.method === "GET" && /\/last$/.test(req.url || "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(seen));
    return;
  }
  if (req.method !== "POST" || !(req.url || "").includes("chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    if (body.messages) remember(body.messages);
    const text = replyTo(body.messages);
    console.log(`[stand-in] ${body.stream ? "stream" : "buffered"} ${body.model || "?"} -> ${text.slice(0, 70)}`);
    if (body.stream) return stream(res, text);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "stand-in", object: "chat.completion", model: "stand-in",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: text.length, total_tokens: 10 + text.length },
      }));
    }, DELAY);
  });
});
function stream(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (delta, finish = null) => res.write("data: " + JSON.stringify({
    id: "stand-in", object: "chat.completion.chunk", model: "stand-in",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + "\n\n");
  setTimeout(async () => {
    send({ role: "assistant", content: "" });
    for (let i = 0; i < text.length; i += 16) {
      send({ content: text.slice(i, i + 16) });
      await new Promise((r) => setTimeout(r, 25));
    }
    send({}, "stop");
    res.write(String.fromCharCode(100,97,116,97,58,32) + "[" + "DONE]" + String.fromCharCode(10,10));
    res.end();
  }, DELAY);
}
server.listen(PORT, "127.0.0.1", () => {
  console.log("[stand-in] listening on http://127.0.0.1:" + PORT + "/v1 (" + DELAY + " ms delay)");
});
