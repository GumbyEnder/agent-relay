/**
 * The Hive (2026-11-23, the server side): the log of what the Zilla agents asked each other,
 * and the two real ways they do. An agent in a conversation asks BeeZilla for something outside
 * its job (ask_bzilla); BeeZilla asks one of the person's agents something that is its job
 * (ask_agent). Each is ONE model completion with no tools, and leaves a question and an answer
 * in the log that the Hive window in the sidebar reads.
 *
 *   - The log: lines in the order written, `after` and `limit`, the cap of 200, text cleaned of
 *     control characters and cut at 4000, names copied in (a rename or a removal changes nothing
 *     that was said), the oldest removed past 2000, and only ever the person's own.
 *   - GET /api/buzzy/hive through the real handler: 401 signed out, the person's own lines, the
 *     query string, every other method refused.
 *   - Who may be asked: an agent by exact name, then by the start of it, then by a part of it;
 *     two that fit are refused in words that name them; none is refused with the list of agents
 *     that have a job; an agent with no job, and someone else's, are not there to be found.
 *   - The two delegations against a stand-in model that records every prompt: the nested
 *     call gets BeeZilla's own prompt (her persona, the agents and colonies) or the agent's own
 *     (its persona and job), no tools, a few hundred tokens; the two lines are written with
 *     copied names and one thread; a model that fails, says nothing or is too slow writes nothing
 *     and comes back in plain words, never as an exception.
 *   - Which turns are offered which tool, as a table, and in the real chat loop: an agent that has
 *     a job is offered ask_bzilla, BeeZilla is offered ask_agent only when the message is about one
 *     of the agents (named, or in its job), and any other turn is exactly what it was: no tools,
 *     the old text, still streamed.
 *   - The whole chat loop: the model calls the tool, the nested call answers, the model tells the
 *     person (for both tools); a turn may ask at most twice; a tool the turn was not offered, an
 *     agent that is not there, and a model that rejects the tool list are all answered in words.
 *   - The notes the agents' own routes write (a job taken on, a colony made), the account export,
 *     the account deletion and the rollback.
 *   - The same through the real /api/buzzy handler, signed in with real sessions.
 *
 * Hermetic: every migration on an in-memory PGlite and a local stand-in for the model.
 *   npx tsx scripts/test-agent-hive.ts      (AGENT_HIVE_SHOW=1 also prints the Hive's answer, the
 *                                            nested prompts and the gating table)
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { H3 } from "h3";
import JSZip from "jszip";
import * as ag from "../src/lib/buzzy/agents";
import { buildExportBundle, deleteAccountData, DELETION_STATEMENTS } from "../src/lib/buzzy/portability";

// This test must never reach a real database: the in-memory one is what getSql() gives
// when no DATABASE_URL is set, and that is checked before anything else loads.
delete process.env.DATABASE_URL;

let pass = 0;
let fail = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const SHOW = Boolean(process.env.AGENT_HIVE_SHOW);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Characters that must not survive cleaning, built without writing them in the source.
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const HALF_EMOJI = String.fromCharCode(0xd83d);
const REPLACEMENT = String.fromCharCode(0xfffd);

// ── A stand-in model: records every request, and answers by rule ────────────
interface Msg { role?: string; content?: string }
interface Call {
  /** Every system message, joined. */
  system: string;
  /** The last user message. */
  user: string;
  messages: Msg[];
  /** The names of the tools the request carried. */
  tools: string[];
  stream: boolean;
  maxTokens: number | null;
  model: string;
}
interface Reply {
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** An HTTP error instead of an answer. */
  status?: number;
  delayMs?: number;
}
interface Rule { when: (c: Call) => boolean; reply: Reply }

const DEFAULT_ANSWER = "Happy to help with that.";
const calls: Call[] = [];
let rules: Rule[] = [];
const say = (content: string, delayMs = 0): Reply => ({ content, delayMs });
const tool = (name: string, args: Record<string, unknown>): Reply => ({ toolCalls: [{ name, args }] });
/** The nested completion of a delegation: one party asks the other. */
const nested = (c: Call) => c.user.includes(" asks you: ");
const nestedBy = (who: string) => (c: Call) => c.user.startsWith(who) && nested(c);
/** The completion that follows a tool call: the tool's result is in the conversation. */
const followUp = (prefix: string) => (c: Call) => c.messages.some((m) => m.role === "user" && String(m.content ?? "").startsWith(prefix));
const offers = (name: string) => (c: Call) => c.tools.includes(name);

const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let parsed: { model?: string; stream?: boolean; max_tokens?: number; messages?: Msg[]; tools?: Array<{ function?: { name?: string } }> } = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* not JSON */ }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const users = messages.filter((m) => m.role === "user");
    const call: Call = {
      system: messages.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n"),
      user: String(users[users.length - 1]?.content ?? ""),
      messages,
      tools: (parsed.tools ?? []).map((t) => String(t.function?.name ?? "")),
      stream: parsed.stream === true,
      maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : null,
      model: String(parsed.model ?? ""),
    };
    calls.push(call);
    const reply: Reply = rules.find((r) => r.when(call))?.reply ?? { content: DEFAULT_ANSWER };
    if (reply.delayMs) await sleep(reply.delayMs);
    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stand-in refused" } }));
      return;
    }
    if (call.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const word of String(reply.content ?? DEFAULT_ANSWER).split(" ")) {
        res.write(`data: ${JSON.stringify({ model: "stand-in", choices: [{ index: 0, delta: { content: word + " " } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: parsed.model || "stand-in",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: reply.content ?? "",
          ...(reply.toolCalls ? {
            tool_calls: reply.toolCalls.map((t, i) => ({ id: `call_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })),
          } : {}),
        },
        finish_reason: reply.toolCalls ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});

(async () => {
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", () => r()));
  process.env.BZ_CHAT_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  process.env.BZ_CHAT_KEY = "stand-in-key";
  process.env.BZ_CHAT_MODEL = "stand-in-model";

  // Loaded only now: the model client reads its address from the environment as it is first loaded.
  const { getSql, getPglite } = await import("../src/lib/db");
  const sql = await getSql();
  const server = await import("../src/lib/buzzy/server");
  const hv = await import("../src/lib/buzzy/hive");
  const reg = await import("../src/lib/buzzy/toolRegistry");

  const route = (user: string, method: string, rest: string, body?: unknown) => ag.agentsRoute(sql, user, method, rest, body);
  const count = async (table: string, user: string) =>
    Number(((await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user]))[0] as { n: number }).n);
  const session = async (id: string, user: string, agentId: string | null = null) => {
    await sql.query("INSERT INTO buzzy_sessions (id, user_id, agent_id) VALUES ($1, $2, $3)", [id, user, agentId]);
  };
  /** Every line of the person's Hive, in order, as stored. */
  const lines = async (user: string) =>
    sql.query<{ id: number; thread: string; kind: string; from_id: string; to_id: string; from_name: string; to_name: string; body: string; session_id: string | null; created_at: Date }>(
      "SELECT * FROM buzzy_hive_messages WHERE user_id = $1 ORDER BY id ASC", [user]);
  /**
   * The person's agents, each with a job (set directly: telling an agent its job in a conversation
   * leaves a note in the Hive, and these tests count lines). The first is the starter bunny.
   */
  const team = async (user: string, jobs: string[]): Promise<ag.Agent[]> => {
    const out: ag.Agent[] = [];
    const have = (await route(user, "GET", "")).body.agents as ag.Agent[];
    for (let i = 0; i < jobs.length; i++) {
      const made = have[i] ?? ((await route(user, "POST", "", {})).body.agent as ag.Agent);
      const got = jobs[i] ? ((await route(user, "PATCH", made.id, { role: jobs[i] })).body.agent as ag.Agent) : made;
      out.push(got);
    }
    return out;
  };
  const turn = async (
    user: string,
    sessionId: string,
    message: string,
    extra: Partial<Parameters<typeof server.chatLoop>[0]> = {},
  ) => {
    calls.length = 0;
    return server.chatLoop({ userId: user, jobId: null, sessionId, message, mode: "chat", agent: await ag.agentForSession(sql, user, sessionId), ...extra });
  };
  /** The system prompt of the main completion of a turn (the longest one, as the other tests take it). */
  const mainCall = () => calls.filter((c) => !nested(c) && /You are /.test(c.system)).sort((a, b) => b.system.length - a.system.length)[0]!;
  const { ONE_PERSONA: chat } = await import("../src/lib/buzzy/oneMode"); // one persona since one mode

  // ── The table ─────────────────────────────────────────────────────────────

  console.log("\nThe table\n");

  await ok("the migration made buzzy_hive_messages with its columns, its index, and a kind that is ask, answer or note", async () => {
    const cols = await sql.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'buzzy_hive_messages' ORDER BY ordinal_position");
    eq(cols.map((c) => c.column_name), ["id", "user_id", "thread", "kind", "from_id", "to_id", "from_name", "to_name", "body", "session_id", "created_at"]);
    eq(cols.filter((c) => c.is_nullable === "YES").map((c) => c.column_name), ["session_id"], "only the conversation is optional");
    const idx = await sql.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'buzzy_hive_messages' AND indexname = 'buzzy_hive_messages_user_idx'");
    truthy(/\(user_id, id\)/.test(idx[0]?.indexdef ?? ""), "an index on (user_id, id)");
    let refused = false;
    try {
      await sql.query("INSERT INTO buzzy_hive_messages (user_id, thread, kind, from_id, to_id, from_name, to_name, body) VALUES ('hx', 't', 'shout', 'a', 'b', 'A', 'B', 'x')");
    } catch { refused = true; }
    truthy(refused, "a kind other than ask, answer or note is refused by the table");
    eq([hv.HIVE_BODY_MAX, hv.HIVE_KEEP, hv.HIVE_LIST_DEFAULT, hv.HIVE_LIST_MAX, hv.HIVE_MAX_PER_TURN], [4000, 2000, 100, 200, 2]);
  });

  // ── The log ───────────────────────────────────────────────────────────────

  console.log("\nThe log\n");

  const A = { id: "ag_aaaaaaaaaaaa", name: "Bunnyzilla" };

  await ok("a line is written and read back oldest first, with its names copied in and its time as an ISO string", async () => {
    const t1 = await hv.logHive(sql, "hl0", { thread: "th_one", kind: "ask", from: A, to: hv.BEEZILLA, body: "Which day is free?" });
    const t2 = await hv.logHive(sql, "hl0", { thread: "th_one", kind: "answer", from: hv.BEEZILLA, to: A, body: "Friday." });
    truthy(typeof t1 === "number" && typeof t2 === "number" && t2! > t1!, `ids ${t1}, ${t2}`);
    const got = await hv.listHive(sql, "hl0");
    eq(got.map((m) => [m.kind, m.fromId, m.toId, m.fromName, m.toName, m.body, m.thread]), [
      ["ask", "ag_aaaaaaaaaaaa", "bzilla", "Bunnyzilla", "BeeZilla", "Which day is free?", "th_one"],
      ["answer", "bzilla", "ag_aaaaaaaaaaaa", "BeeZilla", "Bunnyzilla", "Friday.", "th_one"],
    ]);
    eq(Object.keys(got[0]!).sort(), ["at", "body", "fromId", "fromName", "id", "kind", "thread", "toId", "toName"], "exactly what the window reads");
    truthy(typeof got[0]!.id === "number", "the id is a number, so the window can send it back as ?after=");
    truthy(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(got[0]!.at), got[0]!.at);
    truthy(!JSON.stringify(got).includes("session"), "the conversation is kept for tracing and never returned");
  });
  await ok("a line that says when it was said keeps that time, and the next one is dated now", async () => {
    const past = new Date(Date.now() - 60_000);
    await hv.logHive(sql, "hl1", { thread: "t", kind: "ask", from: A, to: hv.BEEZILLA, body: "earlier", at: past });
    await hv.logHive(sql, "hl1", { thread: "t", kind: "answer", from: hv.BEEZILLA, to: A, body: "now" });
    const [a, b] = await hv.listHive(sql, "hl1");
    eq(a!.at, past.toISOString());
    truthy(Math.abs(Date.parse(b!.at) - Date.now()) < 5000, b!.at);
  });
  await ok("a hundred and thirty lines: the latest 100 come back oldest first; limit and after pick from them", async () => {
    await sql.query(
      `INSERT INTO buzzy_hive_messages (user_id, thread, kind, from_id, to_id, from_name, to_name, body)
       SELECT 'hl', 't' || g, 'note', 'bzilla', 'bzilla', 'BeeZilla', 'BeeZilla', 'line ' || g FROM generate_series(1, 130) g`);
    const all = await hv.listHive(sql, "hl");
    eq([all.length, all[0]!.body, all[99]!.body], [100, "line 31", "line 130"], "the newest 100, oldest of them first");
    eq(all.map((m) => m.id), [...all.map((m) => m.id)].sort((x, y) => x - y), "in id order");
    eq((await hv.listHive(sql, "hl", { limit: 5 })).map((m) => m.body), ["line 126", "line 127", "line 128", "line 129", "line 130"], "the latest five");
    eq((await hv.listHive(sql, "hl", { limit: "3" })).map((m) => m.body), ["line 128", "line 129", "line 130"], "a limit may come as text");
    const id125 = all.find((m) => m.body === "line 125")!.id;
    eq((await hv.listHive(sql, "hl", { after: id125 })).map((m) => m.body), ["line 126", "line 127", "line 128", "line 129", "line 130"], "after: only what is newer");
    eq((await hv.listHive(sql, "hl", { after: String(id125) })).length, 5, "after may come as text");
    eq((await hv.listHive(sql, "hl", { after: id125, limit: 2 })).map((m) => m.body), ["line 126", "line 127"], "the first of the newer lines, so a window never skips one");
    eq(await hv.listHive(sql, "hl", { after: all[99]!.id }), [], "nothing newer: an empty list");
    eq(await hv.listHive(sql, "hl", { after: 999999999 }), []);
    const fromStart = await hv.listHive(sql, "hl", { after: 0, limit: 3 });
    eq(fromStart.map((m) => m.body), ["line 1", "line 2", "line 3"], "after 0 is from the very start");
  });
  await ok("limit is capped at 200; one that is missing or is not a positive whole number means 100; an after that is not a number is ignored", async () => {
    await sql.query(
      `INSERT INTO buzzy_hive_messages (user_id, thread, kind, from_id, to_id, from_name, to_name, body)
       SELECT 'hl2', 't' || g, 'note', 'bzilla', 'bzilla', 'BeeZilla', 'BeeZilla', 'n ' || g FROM generate_series(1, 250) g`);
    const first = async (opts: { after?: unknown; limit?: unknown }) => { const r = await hv.listHive(sql, "hl2", opts); return [r.length, r[0]?.body, r[r.length - 1]?.body]; };
    eq(await first({ limit: 500 }), [200, "n 51", "n 250"], "never more than 200");
    eq(await first({ limit: 200 }), [200, "n 51", "n 250"]);
    eq(await first({}), [100, "n 151", "n 250"], "100 when it is not said");
    for (const bad of ["abc", 0, "0", -3, "-3", 2.5, "2.5", null, "", "1e3", {}]) eq(await first({ limit: bad }), [100, "n 151", "n 250"], `limit ${JSON.stringify(bad)}`);
    for (const bad of ["abc", -1, "-1", 1.5, "1.5", null, "", "1e3", "12 34", {}]) eq(await first({ after: bad }), [100, "n 151", "n 250"], `after ${JSON.stringify(bad)} is ignored`);
    eq(await first({ after: 0, limit: 500 }), [200, "n 1", "n 200"], "from the start, 200 at a time");
  });
  await ok("what is said is cleaned (no control characters, no half of an emoji, breaks kept, one blank line at most) and cut at 4000", async () => {
    const dirty = "a" + NUL + "b" + BEL + "c\r\n\r\n\r\n\r\nd   e \t f" + HALF_EMOJI + "!  \n  g";
    await hv.logHive(sql, "hc", { thread: "t", kind: "answer", from: hv.BEEZILLA, to: A, body: dirty });
    await hv.logHive(sql, "hc", { thread: "t", kind: "answer", from: hv.BEEZILLA, to: A, body: "x".repeat(5000) });
    await hv.logHive(sql, "hc", { thread: "t", kind: "answer", from: hv.BEEZILLA, to: A, body: "🐰".repeat(4500) });
    const [clean, long, bunnies] = await hv.listHive(sql, "hc");
    eq(clean!.body, `abc\n\nd e f${REPLACEMENT}!\ng`, "no control characters, spaces tidied, the line breaks kept");
    eq(Array.from(long!.body).length, 4000, "cut at 4000");
    eq(Array.from(bunnies!.body).length, 4000, "by whole characters: no emoji cut in half");
    truthy(!/[\uD800-\uDBFF]$/.test(bunnies!.body), "and no lone half at the end");
  });
  await ok("names are copied, cleaned and kept to 40 characters; a line with nothing to say, or of an unknown kind, is not written", async () => {
    await hv.logHive(sql, "hn", { thread: "t", kind: "ask", from: { id: "ag_x", name: `Bun${BEL}ny` + "z".repeat(60) }, to: { id: "ag_y", name: "" }, body: "hi" });
    const [m] = await hv.listHive(sql, "hn");
    eq(Array.from(m!.fromName).length, 40);
    truthy(m!.fromName.startsWith("Bunnyzzz"), m!.fromName);
    eq(m!.toName, "An agent", "an empty name still reads as something");
    eq(await hv.logHive(sql, "hn", { thread: "t", kind: "ask", from: A, to: hv.BEEZILLA, body: `  ${NUL}${BEL} \n ` }), null, "nothing to say");
    eq(await hv.logHive(sql, "hn", { thread: "t", kind: "shout" as never, from: A, to: hv.BEEZILLA, body: "x" }), null, "an unknown kind");
    eq(await count("buzzy_hive_messages", "hn"), 1);
    const noThread = await hv.logHive(sql, "hn", { thread: "", kind: "ask", from: A, to: hv.BEEZILLA, body: "no thread given" });
    truthy(noThread, "written");
    truthy(/^th_[a-z0-9]{12}$/.test((await lines("hn")).at(-1)!.thread), "it is given one");
  });
  await ok("a note is one short plain sentence, from and to the same one; the conversation it came from is kept for tracing", async () => {
    await session("sess_note1", "hno");
    const id = await hv.noteHive(sql, "hno", A, `Bunnyzilla took on a job: calendars\n\n   and more${NUL}`, "sess_note1");
    truthy(id);
    const [row] = await lines("hno");
    eq([row!.kind, row!.from_id, row!.to_id, row!.from_name, row!.to_name, row!.body, row!.session_id], ["note", A.id, A.id, "Bunnyzilla", "Bunnyzilla", "Bunnyzilla took on a job: calendars and more", "sess_note1"]);
    truthy(/^th_[a-z0-9]{12}$/.test(row!.thread), "a thread of its own");
    await hv.noteHive(sql, "hno", hv.BEEZILLA, "x".repeat(900), "../not-a-session");
    const long = (await lines("hno")).at(-1)!;
    eq([long.body.length, long.from_id, long.to_id, long.session_id], [400, "bzilla", "bzilla", null], "cut short, and a session id that is not one is not kept");
  });
  await ok("only the newest 2000 lines of a person are kept: writing removes the oldest, and no one else's", async () => {
    await sql.query(
      `INSERT INTO buzzy_hive_messages (user_id, thread, kind, from_id, to_id, from_name, to_name, body)
       SELECT 'hp', 't' || g, 'note', 'bzilla', 'bzilla', 'BeeZilla', 'BeeZilla', 'row ' || g FROM generate_series(1, 2005) g`);
    const others = await count("buzzy_hive_messages", "hl");
    await hv.logHive(sql, "hp", { thread: "t", kind: "note", from: hv.BEEZILLA, to: hv.BEEZILLA, body: "the newest" });
    eq(await count("buzzy_hive_messages", "hp"), 2000, "2005 + 1 written, 2000 kept");
    const kept = await lines("hp");
    eq([kept[0]!.body, kept.at(-1)!.body], ["row 7", "the newest"], "the oldest six went");
    await hv.logHive(sql, "hp", { thread: "t", kind: "note", from: hv.BEEZILLA, to: hv.BEEZILLA, body: "one more" });
    eq([await count("buzzy_hive_messages", "hp"), (await lines("hp"))[0]!.body], [2000, "row 8"], "and one more goes with each new one");
    eq(await count("buzzy_hive_messages", "hl"), others, "another person's lines are not touched");
  });
  await ok("a person sees only their own lines, even when they share an agent id", async () => {
    await hv.logHive(sql, "hx1", { thread: "t", kind: "ask", from: A, to: hv.BEEZILLA, body: "mine" });
    await hv.logHive(sql, "hx2", { thread: "t", kind: "ask", from: A, to: hv.BEEZILLA, body: "theirs" });
    eq((await hv.listHive(sql, "hx1")).map((m) => m.body), ["mine"]);
    eq((await hv.listHive(sql, "hx2")).map((m) => m.body), ["theirs"]);
    eq(await hv.listHive(sql, "hx3"), [], "someone with nothing sees nothing");
    eq((await hv.listHive(sql, "hx1", { after: 0 })).map((m) => m.body), ["mine"], "from the very start, still only your own");
  });

  // ── The route ─────────────────────────────────────────────────────────────

  console.log("\nThe route\n");

  await ok("GET answers { ok, messages } in order; the query chooses what comes back; every other method is refused", async () => {
    const out = await hv.hiveRoute(sql, "hl", "GET", "", {});
    eq([out.status, out.body.ok, (out.body.messages as unknown[]).length], [200, true, 100]);
    eq(Object.keys(out.body).sort(), ["messages", "ok"]);
    const some = await hv.hiveRoute(sql, "hl", "GET", "/", { after: "0", limit: "2" });
    eq((some.body.messages as Array<{ body: string }>).map((m) => m.body), ["line 1", "line 2"]);
    eq((await hv.hiveRoute(sql, "hl", "GET", "", { limit: null, after: null })).status, 200, "no query at all is fine");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const r = await hv.hiveRoute(sql, "hl", method, "", {});
      eq([r.status, r.body.ok, r.body.code], [405, false, "method_not_allowed"], method);
      truthy(/GET/.test(String(r.body.error)), String(r.body.error));
    }
    const other = await hv.hiveRoute(sql, "hl", "GET", "/something/else", {});
    eq([other.status, other.body.code], [404, "not_found"], "there is one Hive page");
    eq(await count("buzzy_hive_messages", "hl"), 130, "and no request wrote anything");
  });

  // ── Who may be asked ──────────────────────────────────────────────────────

  console.log("\nWho may be asked\n");

  // Bunnyzilla (calendars), Bullzilla (trips), Frogzilla (recipes), Blue Frogzilla (hotels), Bunnyzilla 2 (budget),
  // and Red Beezilla, which has no job.
  let crew: ag.Agent[] = [];
  const resolve = async (ref: string) => {
    calls.length = 0;
    return hv.askAgent(sql, "hr", { agentRef: ref, question: "What is on your list?" });
  };
  await ok("set up: five agents with a job, and one without", async () => {
    crew = await team("hr", ["calendars", "trips", "recipes"]);
    crew.push(((await route("hr", "POST", "", { creature: "frog", look: "blue" })).body.agent as ag.Agent));
    crew.push(((await route("hr", "POST", "", { creature: "bunny" })).body.agent as ag.Agent));
    crew.push(((await route("hr", "POST", "", { creature: "bee", look: "red" })).body.agent as ag.Agent));
    await route("hr", "PATCH", crew[3]!.id, { role: "hotels" });
    await route("hr", "PATCH", crew[4]!.id, { role: "budget" });
    eq(crew.map((a) => a.name), ["Bunnyzilla", "Bullzilla", "Frogzilla", "Blue Frogzilla", "Bunnyzilla 2", "Red Beezilla"]);
    eq((await ag.readyAgents(sql, "hr")).map((a) => a.name), ["Bunnyzilla", "Bullzilla", "Frogzilla", "Blue Frogzilla", "Bunnyzilla 2"], "Red Beezilla has no job");
  });
  await ok("an exact name finds it, whatever the case; an exact name beats a longer one that starts the same", async () => {
    for (const ref of ["Bullzilla", "bullzilla", "  BULLZILLA  "]) {
      const r = await resolve(ref);
      truthy(r.ok && r.agentName === "Bullzilla", `${ref}: ${JSON.stringify(r)}`);
    }
    const bunny = await resolve("bunnyzilla");
    truthy(bunny.ok && bunny.agentName === "Bunnyzilla", "Bunnyzilla, not Bunnyzilla 2 (its name is exactly that)");
    const two = await resolve("Bunnyzilla 2");
    truthy(two.ok && two.agentName === "Bunnyzilla 2");
    truthy(calls.some(nested), "and it was asked");
  });
  await ok("the start of a name finds it when only one starts that way; a part of a name when only one holds it", async () => {
    const bull = await resolve("bul");
    truthy(bull.ok && bull.agentName === "Bullzilla", JSON.stringify(bull));
    const blue = await resolve("Blue");
    truthy(blue.ok && blue.agentName === "Blue Frogzilla", "starts with Blue");
    const frog = await resolve("frog");
    truthy(frog.ok && frog.agentName === "Frogzilla", "Frogzilla starts with it; Blue Frogzilla only contains it, and the start comes first");
    const part = await resolve("ue Frog");
    truthy(part.ok && part.agentName === "Blue Frogzilla", "contained in only one name");
    const roll = await resolve("ullzi");
    truthy(roll.ok && roll.agentName === "Bullzilla", "a part of one name");
  });
  await ok("two that fit are refused in words that name them with what each helps with, and nobody is asked or logged", async () => {
    const before = await count("buzzy_hive_messages", "hr");
    for (const ref of ["Bunny", "rogzil"]) {
      const r = await resolve(ref);
      truthy(!r.ok && r.code === "ambiguous", `${ref}: ${JSON.stringify(r)}`);
      if (!r.ok) {
        truthy(/More than one/.test(r.message) && /full name/.test(r.message), r.message);
        truthy(/Nobody has been asked/.test(r.message), "it says so, so the model does not claim otherwise");
      }
    }
    const bunny = await resolve("Bunny");
    if (!bunny.ok) truthy(bunny.message.includes("Bunnyzilla (helps with calendars)") && bunny.message.includes("Bunnyzilla 2 (helps with budget)"), bunny.message);
    const frogs = await resolve("rogzil");
    if (!frogs.ok) truthy(frogs.message.includes("Frogzilla (helps with recipes)") && frogs.message.includes("Blue Frogzilla (helps with hotels)"), frogs.message);
    eq(calls.filter(nested).length, 0, "no model call");
    eq(await count("buzzy_hive_messages", "hr"), before, "nothing logged");
  });
  await ok("two agents with one name are told apart by what they help with", async () => {
    const [x, y] = await team("hr2", ["calendars", "trips"]);
    await route("hr2", "PATCH", y!.id, { name: x!.name });
    calls.length = 0;
    const r = await hv.askAgent(sql, "hr2", { agentRef: x!.name, question: "Hello?" });
    truthy(!r.ok && r.code === "ambiguous" && r.message.includes(`${x!.name} (helps with calendars), ${x!.name} (helps with trips)`), JSON.stringify(r));
    eq(calls.length, 0);
  });
  await ok("no one by that name: the refusal lists the agents that have a job, and never the one that has none", async () => {
    const before = await count("buzzy_hive_messages", "hr");
    const r = await resolve("Zorp");
    truthy(!r.ok && r.code === "not_found", JSON.stringify(r));
    if (!r.ok) {
      truthy(r.message.includes("Bunnyzilla, Bullzilla, Frogzilla, Blue Frogzilla, Bunnyzilla 2"), r.message);
      truthy(!r.message.includes("Red Beezilla"), "an agent with no job is not listed");
      truthy(/Nobody has been asked/.test(r.message), r.message);
    }
    const blank = await resolve("   ");
    truthy(!blank.ok && blank.code === "not_found" && /Say which agent/.test(blank.message), JSON.stringify(blank));
    eq(calls.filter(nested).length, 0);
    eq(await count("buzzy_hive_messages", "hr"), before, "nothing logged");
  });
  await ok("an agent with no job is not found, by its exact name or any part of it", async () => {
    for (const ref of ["Red Beezilla", "red", "beezilla"]) {
      const r = await resolve(ref);
      truthy(!r.ok, `${ref} should not be found: ${JSON.stringify(r)}`);
    }
    await route("hr", "PATCH", crew[5]!.id, { role: "music" });
    const found = await resolve("Red Beezilla");
    truthy(found.ok && found.agentName === "Red Beezilla", "once it has a job it can be asked");
    await route("hr", "PATCH", crew[5]!.id, { role: "" });
    truthy(!(await resolve("Red Beezilla")).ok, "and not once it has none again");
  });
  await ok("a person with no agent that has a job is told there is no one to ask; a blank or missing question is refused", async () => {
    await route("hnone", "GET", ""); // the starter bunny, with no job
    const r = await hv.askAgent(sql, "hnone", { agentRef: "Bunnyzilla", question: "Hello?" });
    truthy(!r.ok && r.code === "no_agents" && /no agents with a job/.test(r.message), JSON.stringify(r));
    const none = await hv.askAgent(sql, "hr", { agentRef: "Bullzilla", question: `  ${BEL} ` });
    truthy(!none.ok && none.code === "no_question", JSON.stringify(none));
    const noBz = await hv.askBzilla(sql, "hr", { agent: crew[0]!, question: "" });
    truthy(!noBz.ok && noBz.code === "no_question", JSON.stringify(noBz));
  });
  await ok("someone else's agent is not there to be asked, even by its exact name", async () => {
    const [mine] = await team("hz1", ["calendars"]);
    await route("hz1", "PATCH", mine!.id, { name: "Zephyr" });
    const [theirs] = await team("hz2", ["trips"]);
    const r = await hv.askAgent(sql, "hz2", { agentRef: "Zephyr", question: "Hello?" });
    truthy(!r.ok && r.code === "not_found" && r.message.includes(`The agents that have a job are: ${theirs!.name}.`) && !r.message.includes("calendars"), JSON.stringify(r));
    const own = await hv.askAgent(sql, "hz1", { agentRef: "zephyr", question: "Hello?" });
    truthy(own.ok && own.agentName === "Zephyr");
  });

  // ── The two delegations ───────────────────────────────────────────────────

  console.log("\nThe two delegations, against a stand-in model\n");

  const BZ_ANSWER = "Friday is free this week, and Bunnyzilla has nothing booked then.";
  const AGENT_ANSWER = "Two things are on the list this week: call the plumber and send the invoice.";
  let dTeam: ag.Agent[] = [];
  let bzPrompt = "";
  let agentPrompt = "";

  await ok("an agent asks BeeZilla: she answers, and the two lines are written (agent to BeeZilla, then BeeZilla to the agent, one thread)", async () => {
    dTeam = await team("hd", ["calendars", "trips", "recipes"]);
    await session("sess_d1", "hd", dTeam[0]!.id);
    rules = [{ when: nestedBy("Bunnyzilla"), reply: say(BZ_ANSWER, 150) }];
    calls.length = 0;
    const r = await hv.askBzilla(sql, "hd", { agent: dTeam[0]!, question: "Which day this week is free?", sessionId: "sess_d1" });
    truthy(r.ok && r.text === BZ_ANSWER, JSON.stringify(r));
    const rows = await lines("hd");
    eq(rows.map((x) => [x.kind, x.from_id, x.to_id, x.from_name, x.to_name, x.body]), [
      ["ask", dTeam[0]!.id, "bzilla", "Bunnyzilla", "BeeZilla", "Which day this week is free?"],
      ["answer", "bzilla", dTeam[0]!.id, "BeeZilla", "Bunnyzilla", BZ_ANSWER],
    ]);
    eq(rows[0]!.thread, rows[1]!.thread, "one thread");
    truthy(/^th_[a-z0-9]{12}$/.test(rows[0]!.thread), rows[0]!.thread);
    eq([rows[0]!.session_id, rows[1]!.session_id], ["sess_d1", "sess_d1"], "both kept the conversation");
    truthy(rows[1]!.id === rows[0]!.id + 1, "written together, one after the other");
    truthy(new Date(rows[1]!.created_at).getTime() - new Date(rows[0]!.created_at).getTime() >= 100, "the question is dated when it was asked, not when its answer came");
  });
  await ok("the nested call to BeeZilla: her own persona and the agents (names, jobs), the question as the agent's, no tools, a few hundred tokens", async () => {
    const c = calls.filter(nested);
    eq(c.length, 1, "exactly one model call for the delegation");
    const n = c[0]!;
    bzPrompt = n.system;
    truthy(n.system.startsWith("You are BeeZilla."), n.system.slice(0, 60));
    eq(n.system.slice(0, chat.length), chat, "her conversational persona, word for word");
    truthy(n.system.includes("THE PERSON'S ZILLA AGENTS") && n.system.includes("- Bunnyzilla: helps with calendars") && n.system.includes("- Bullzilla: helps with trips"), "she is told who the agents are");
    truthy(/can't do that yet/.test(n.system) && !/ask_agent/.test(n.system), "and that she cannot hand work on: she has no tools here");
    eq(n.user, "Bunnyzilla (who helps with calendars) asks you: Which day this week is free? Answer it as the person's executive assistant, in a few sentences, only from what you know about their agents and this conversation; never claim you did something you did not.");
    eq(n.tools, [], "no tools, so there is no recursion");
    truthy(n.maxTokens !== null && n.maxTokens >= 400 && n.maxTokens <= 1000, `max_tokens ${n.maxTokens}`);
    eq(n.messages.map((m) => m.role), ["system", "user"], "a system prompt and one message");
  });
  await ok("BeeZilla's own prompt names the colonies too, with the person's words quoted as theirs", async () => {
    await route("hd", "POST", "colonies", { name: "Travel and time", purpose: "Plans \"my\" year", agents: [dTeam[1]!.id, dTeam[0]!.id] });
    rules = [{ when: nested, reply: say(BZ_ANSWER) }];
    calls.length = 0;
    const r = await hv.askBzilla(sql, "hd", { agent: dTeam[2]!, question: "Who looks after my hotels?" });
    truthy(r.ok);
    const n = calls.find(nested)!;
    truthy(n.system.includes("Some are grouped into colonies") && n.system.includes("- Colony \"Travel and time\" (purpose: \"Plans 'my' year\"): Bullzilla (helps with trips), Bunnyzilla (helps with calendars)"), n.system.slice(-700));
    truthy(n.system.includes("- Frogzilla: helps with recipes"), "the one on its own");
  });
  await ok("BeeZilla asks an agent: it answers, and the two lines are written (BeeZilla to the agent, then the agent to BeeZilla)", async () => {
    await session("sess_d2", "hd");
    rules = [{ when: nestedBy("BeeZilla"), reply: say(AGENT_ANSWER, 150) }];
    calls.length = 0;
    const r = await hv.askAgent(sql, "hd", { agentRef: "bunny", question: "What is on your list this week?", sessionId: "sess_d2" });
    truthy(r.ok && r.text === AGENT_ANSWER && r.agentName === "Bunnyzilla", JSON.stringify(r));
    const rows = (await lines("hd")).slice(-2);
    eq(rows.map((x) => [x.kind, x.from_id, x.to_id, x.from_name, x.to_name, x.body]), [
      ["ask", "bzilla", dTeam[0]!.id, "BeeZilla", "Bunnyzilla", "What is on your list this week?"],
      ["answer", dTeam[0]!.id, "bzilla", "Bunnyzilla", "BeeZilla", AGENT_ANSWER],
    ]);
    eq(rows[0]!.thread, rows[1]!.thread, "one thread");
    eq(rows[0]!.session_id, "sess_d2");
  });
  await ok("the nested call to an agent: its own persona and job (as in its own conversations), no tools, the question as BeeZilla's", async () => {
    const n = calls.filter(nested)[0]!;
    agentPrompt = n.system;
    eq(calls.filter(nested).length, 1);
    truthy(n.system.startsWith("You are Bunnyzilla, one of the person's Zilla agents (a dedicated helper from the BeeZilla family)."), n.system.slice(0, 120));
    truthy(!/You are BeeZilla/.test(n.system), "it does not speak as BeeZilla");
    truthy(n.system.includes("YOUR JOB AS Bunnyzilla") && n.system.includes("Your job: calendars."), "its job");
    eq(n.system, ag.personaFor(dTeam[0]!, chat) + ag.agentIdentityBlock({ id: dTeam[0]!.id, name: "Bunnyzilla", role: "calendars", instructions: "", face: dTeam[0]!.face }), "exactly the prompt it speaks with: personaFor + agentIdentityBlock");
    truthy(!/ask_bzilla|THE PERSON'S ZILLA AGENTS/.test(n.system), "no mention of a tool it does not have, and no roster");
    eq(n.user, "BeeZilla (the person's executive assistant) asks you: What is on your list this week? Answer in a few sentences, as the agent you are, only from what you know about your job; never claim you did something you did not.");
    eq(n.tools, []);
    truthy(n.maxTokens !== null && n.maxTokens >= 400 && n.maxTokens <= 1000, `max_tokens ${n.maxTokens}`);
    if (SHOW) {
      console.log("\n  --- the nested call to BeeZilla (trimmed) ---\n  system: " + bzPrompt.slice(0, 160).replace(/\n/g, " ") + " … " + bzPrompt.slice(bzPrompt.indexOf("THE PERSON'S"), bzPrompt.indexOf("THE PERSON'S") + 330).replace(/\n/g, " | ") + " …");
      console.log("  user:   Bunnyzilla (who helps with calendars) asks you: Which day this week is free? Answer it as the person's executive assistant, …");
      console.log("\n  --- the nested call to an agent (trimmed) ---\n  system: " + agentPrompt.slice(0, 160).replace(/\n/g, " ") + " … " + agentPrompt.slice(agentPrompt.indexOf("YOUR JOB AS"), agentPrompt.indexOf("YOUR JOB AS") + 200).replace(/\n/g, " ") + " …");
      console.log("  user:   " + n.user + "\n");
    }
  });
  await ok("an agent that has no job is shown to BeeZilla without the parenthesis, and the question gets an end mark", async () => {
    rules = [{ when: nested, reply: say("Noted.") }];
    calls.length = 0;
    await hv.askBzilla(sql, "hd", { agent: { id: "ag_idle00000000", name: "Idle", role: "" }, question: "Should I wait" });
    eq(calls.find(nested)!.user.startsWith("Idle asks you: Should I wait. Answer it"), true, calls.find(nested)!.user.slice(0, 80));
  });
  await ok("a model that fails, says nothing, or is too slow writes nothing and comes back in plain words, never as an exception", async () => {
    const before = await count("buzzy_hive_messages", "hd");
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const [label, rule] of [
        ["an HTTP error", { when: nested, reply: { status: 500 } }],
        ["a refusal of the request", { when: nested, reply: { status: 400 } }],
        ["an empty answer", { when: nested, reply: { content: "  " } }],
      ] as Array<[string, Rule]>) {
        rules = [rule];
        const a = await hv.askBzilla(sql, "hd", { agent: dTeam[0]!, question: "Which day?" });
        truthy(!a.ok && a.code === "ask_failed" && /could not be reached/.test(a.message) && /do not guess/.test(a.message), `${label}: ${JSON.stringify(a)}`);
        const b = await hv.askAgent(sql, "hd", { agentRef: "Bullzilla", question: "Which trip?" });
        truthy(!b.ok && b.code === "ask_failed" && /Bullzilla could not be reached/.test(b.message), `${label}: ${JSON.stringify(b)}`);
      }
      rules = [{ when: nested, reply: say("Much too late.", 700) }];
      const slow = await hv.askBzilla(sql, "hd", { agent: dTeam[0]!, question: "Which day?", deadlineMs: 150 });
      truthy(!slow.ok && slow.code === "ask_failed", JSON.stringify(slow));
      const slowAgent = await hv.askAgent(sql, "hd", { agentRef: "Bullzilla", question: "Which trip?", deadlineMs: 150 });
      truthy(!slowAgent.ok && slowAgent.code === "ask_failed", JSON.stringify(slowAgent));
      await sleep(1000); // the late answers arrive now, and are dropped
    } finally {
      console.warn = warn;
    }
    eq(await count("buzzy_hive_messages", "hd"), before, "no question without an answer, no answer that came too late");
  });
  await ok("names are copied: after a rename and after a removal the old lines still read as they were said", async () => {
    const [x] = await team("hren", ["calendars"]);
    rules = [{ when: nested, reply: say("Done.") }];
    await hv.askBzilla(sql, "hren", { agent: x!, question: "Which day?" });
    await route("hren", "PATCH", x!.id, { name: "Hopper" });
    await hv.askBzilla(sql, "hren", { agent: { ...x!, name: "Hopper" }, question: "And Tuesday?" });
    eq((await hv.listHive(sql, "hren")).map((m) => `${m.fromName}>${m.toName}`), ["Bunnyzilla>BeeZilla", "BeeZilla>Bunnyzilla", "Hopper>BeeZilla", "BeeZilla>Hopper"], "each line keeps the name it was written with");
    await route("hren", "DELETE", x!.id);
    eq((await hv.listHive(sql, "hren")).map((m) => `${m.fromName}>${m.toName}`).slice(0, 2), ["Bunnyzilla>BeeZilla", "BeeZilla>Bunnyzilla"], "and a removed agent leaves lines that still read");
  });
  await ok("what is asked is cleaned and cut before it is sent and written", async () => {
    rules = [{ when: nested, reply: say("Fine.") }];
    calls.length = 0;
    await hv.askAgent(sql, "hd", { agentRef: "Bullzilla", question: `Is it ${BEL}ready?${NUL}\n\n\n\n${"y".repeat(3000)}` });
    const n = calls.find(nested)!;
    truthy(!n.user.includes(BEL) && !n.user.includes(NUL) && !n.user.includes("\n\n\n"), "cleaned");
    const asked = (await lines("hd")).filter((x) => x.kind === "ask").at(-1)!;
    eq(Array.from(asked.body).length, hv.HIVE_QUESTION_MAX, "cut at the most a question may be");
  });

  // ── Which turns are offered which tool ────────────────────────────────────

  console.log("\nWhich turns are offered which tool\n");

  const bunny: ag.ReadyAgent = { name: "Bunnyzilla", role: "calendars" };
  const frog: ag.ReadyAgent = { name: "Blue Frogzilla", role: "planning our trips" };
  const grid: Array<[string, Parameters<typeof hv.hiveOffer>[0], hv.HiveOffer]> = [
    ["an agent with a job speaks", { agent: { role: "calendars" }, ready: [], message: "anything at all" }, { askBzilla: true, askAgent: false }],
    ["an agent with a job speaks, and the message names another agent", { agent: { role: "calendars" }, ready: [frog], message: "ask Blue Frogzilla about my trip" }, { askBzilla: true, askAgent: false }],
    ["an agent with no job yet speaks", { agent: { role: "" }, ready: [bunny], message: "calendars" }, { askBzilla: false, askAgent: false }],
    ["BeeZilla, message names an agent", { agent: null, ready: [bunny], message: "Please ask Bunnyzilla what is on its list this week" }, { askBzilla: false, askAgent: true }],
    ["BeeZilla, name in any case", { agent: null, ready: [bunny], message: "ask BUNNYZILLA about it" }, { askBzilla: false, askAgent: true }],
    ["BeeZilla, the name without zilla", { agent: null, ready: [bunny], message: "can you ask Bunny about my day?" }, { askBzilla: false, askAgent: true }],
    ["BeeZilla, a name that has two words and no zilla at the end", { agent: undefined, ready: [frog], message: "what does blue frog say about it" }, { askBzilla: false, askAgent: true }],
    ["BeeZilla, the name is only part of a longer word", { agent: null, ready: [bunny], message: "my bunnyzillas are many" }, { askBzilla: false, askAgent: false }],
    ["BeeZilla, shares a word with the job", { agent: null, ready: [bunny], message: "put the dentist on my calendar for Tuesday" }, { askBzilla: false, askAgent: true }],
    ["BeeZilla, shares a word with the job (singular and plural are one word)", { agent: null, ready: [frog], message: "plan a trip to Lisbon" }, { askBzilla: false, askAgent: true }],
    ["BeeZilla, shares only a stop word with the job", { agent: null, ready: [{ name: "Quill", role: "helping with things" }], message: "I want some help with that thing" }, { askBzilla: false, askAgent: false }],
    ["BeeZilla, a plain message", { agent: null, ready: [bunny, frog], message: "What should I make for dinner on Friday?" }, { askBzilla: false, askAgent: false }],
    ["BeeZilla, the only shared word is under four letters", { agent: null, ready: [{ name: "Quill", role: "tax" }], message: "what is my tax" }, { askBzilla: false, askAgent: false }],
    ["BeeZilla, the person has no agents", { agent: null, ready: [], message: "ask Bunnyzilla about my calendar" }, { askBzilla: false, askAgent: false }],
    ["BeeZilla, the only agent has no job", { agent: null, ready: [{ name: "Bunnyzilla", role: "" }], message: "ask Bunnyzilla about my calendar" }, { askBzilla: false, askAgent: false }],
    ["a name with symbols is matched where it stands", { agent: null, ready: [{ name: "R2-D2!", role: "droids" }], message: "ask R2-D2! please" }, { askBzilla: false, askAgent: true }],
    ["a one-letter name is not 'named' by every message", { agent: null, ready: [{ name: "A", role: "x" }], message: "I need a thing" }, { askBzilla: false, askAgent: false }],
    ["a spoken turn on the voice lane is offered nothing (that lane has no tools)", { agent: { role: "calendars" }, ready: [], message: "anything", spoken: true }, { askBzilla: false, askAgent: false }],
    ["a spoken turn on the voice lane, BeeZilla's, naming an agent", { agent: null, ready: [bunny], message: "ask Bunnyzilla", spoken: true }, { askBzilla: false, askAgent: false }],
  ];
  await ok("the gating table: who is offered what", () => {
    if (SHOW) console.log("\n  turn                                                                    ask_bzilla  ask_agent");
    for (const [label, input, want] of grid) {
      const got = hv.hiveOffer(input);
      eq(got, want, label);
      if (SHOW) console.log(`  ${label.padEnd(72)}${String(got.askBzilla).padEnd(12)}${got.askAgent}`);
    }
    if (SHOW) console.log("");
  });
  await ok("a person with many agents can name the thirtieth: the list the gate reads is every agent that has a job", async () => {
    await team("hbig", ["calendars"]);
    await sql.query(
      `INSERT INTO buzzy_agents (id, user_id, creature, look, name, color, role, pos)
       SELECT 'ag_' || lpad(g::text, 12, '0'), 'hbig', 'frog', 'red', 'Filler ' || g, '#E44449', 'filling ' || g, g FROM generate_series(1, 29) g`);
    const roster = await ag.readyAgents(sql, "hbig");
    eq(roster.length, ag.ROSTER_LINES + 1, "the roster BeeZilla is shown stops at twenty, and says there are more");
    const all = await hv.readyNames(sql, "hbig");
    eq(all.length, 30, "the gate reads all thirty");
    eq(hv.hiveOffer({ agent: null, ready: roster, message: "ask Filler 28 about it" }), { askBzilla: false, askAgent: false }, "the short list cannot see the 28th");
    eq(hv.hiveOffer({ agent: null, ready: all, message: "ask Filler 28 about it" }), { askBzilla: false, askAgent: true }, "the whole list can");
  });

  // ── The tools in the registry ─────────────────────────────────────────────

  console.log("\nThe tools in the registry\n");

  await ok("the schemas are the ones in the spec: names, descriptions, and what each needs", () => {
    const names = (r: unknown[]) => (r as Array<{ function: { name: string } }>).map((t) => t.function.name);
    eq(names(reg.offeredHiveTools({ draftGateOpen: false, hive: { askBzilla: true, askAgent: true } })), ["ask_bzilla", "ask_agent"]);
    const b = hv.ASK_BZILLA_TOOL.function;
    const a = hv.ASK_AGENT_TOOL.function;
    truthy(b.description.startsWith("Ask BeeZilla, the person's executive assistant who looks after all their agents and can see across them, for something outside your job or that needs another agent. She answers in a few sentences. Use it instead of guessing about another area."), b.description);
    eq(a.description, "Ask one of the person's agents (by name) something that is its job, then tell the person what it said and who said it.");
    eq([b.parameters.required, Object.keys(b.parameters.properties)], [["question"], ["question"]]);
    eq([a.parameters.required, Object.keys(a.parameters.properties)], [["agent", "question"], ["agent", "question"]]);
  });

  // ── The whole chat loop ───────────────────────────────────────────────────

  console.log("\nThrough the real chat loop, against a stand-in model\n");

  const BZ_REPLY = "BeeZilla says Friday is free.";
  const AG_REPLY = "Bunnyzilla says two things are on its list: the plumber and the invoice.";
  await ok("an agent's conversation: the agent is offered ask_bzilla, calls it, BeeZilla answers, and the agent tells the person", async () => {
    await session("sess_l1", "hd", dTeam[0]!.id);
    const before = await count("buzzy_hive_messages", "hd");
    rules = [
      { when: nested, reply: say(BZ_ANSWER) },
      { when: offers("ask_bzilla"), reply: tool("ask_bzilla", { question: "Which day this week is free?" }) },
      { when: followUp("ask_bzilla answered"), reply: say(BZ_REPLY) },
    ];
    const flow: Array<{ id: string; title: string; state?: string }> = [];
    const streamed: string[] = [];
    const r = await turn("hd", "sess_l1", "Which day this week is free for a long lunch with Sam?", {
      onFlow: (f) => flow.push({ id: f.id, title: f.title, state: f.state }),
      onText: (d) => streamed.push(d),
    });
    truthy(r.ok, `the turn ran: ${r.error || ""}`);
    eq(r.reply, BZ_REPLY, "the reply is what the agent said after BeeZilla answered");
    const first = mainCall();
    eq(first.tools, ["ask_bzilla"], "offered ask_bzilla, and nothing else");
    eq([first.stream, streamed.length], [false, 0], "a turn that carries a tool is buffered, not streamed (the price of an agent that can ask)");
    truthy(first.system.startsWith("You are Bunnyzilla, one of the person's Zilla agents"), first.system.slice(0, 80));
    truthy(first.system.includes("If something is outside your job, or needs another of the person's agents, call ask_bzilla with your question and use her answer. Never say you did something you did not."), "the sentence that says how");
    const nest = calls.filter(nested);
    eq(nest.length, 1);
    eq(nest[0]!.tools, [], "the nested call has no tools");
    const follow = calls.find(followUp("ask_bzilla answered"))!;
    eq(follow.messages.filter((m) => m.role === "user" && String(m.content).startsWith("ask_bzilla answered")).map((m) => m.content),
      [`ask_bzilla answered: ${BZ_ANSWER} Tell the person what BeeZilla said, in your own words, as the agent you are.`], "the model is handed her answer, and told to say who said it");
    eq((await lines("hd")).slice(before).map((x) => [x.kind, x.from_name, x.to_name, x.session_id]), [["ask", "Bunnyzilla", "BeeZilla", "sess_l1"], ["answer", "BeeZilla", "Bunnyzilla", "sess_l1"]], "the Hive shows it");
    eq((r.tools ?? []).map((t) => [t.name, t.ok]), [["ask_bzilla", true]], "and the turn's tool strip");
    truthy(flow.some((f) => f.id === "tool:ask_bzilla" && f.title === "Ask BeeZilla" && f.state === "running") && flow.some((f) => f.id === "tool:ask_bzilla" && f.state === "done"), "the board card reads 'Ask BeeZilla': " + JSON.stringify(flow));
    const stored = await sql.query<{ role: string; content: string }>("SELECT role, content FROM buzzy_chat_messages WHERE session_id = 'sess_l1' AND user_id = 'hd' ORDER BY created_at, id");
    eq(stored.map((m) => m.role), ["user", "assistant"], "the conversation holds the person's words and the agent's reply, not the tool traffic");
  });
  await ok("BeeZilla's conversation: a message about an agent offers ask_agent; she calls it, the agent answers, and she says who answered", async () => {
    await session("sess_l2", "hd");
    const before = await count("buzzy_hive_messages", "hd");
    rules = [
      { when: nested, reply: say(AGENT_ANSWER) },
      { when: offers("ask_agent"), reply: tool("ask_agent", { agent: "bunny", question: "What is on your list this week?" }) },
      { when: followUp("ask_agent answered"), reply: say(AG_REPLY) },
    ];
    const r = await turn("hd", "sess_l2", "Please ask Bunnyzilla what is on its list this week");
    truthy(r.ok, `the turn ran: ${r.error || ""}`);
    eq(r.reply, AG_REPLY);
    const first = mainCall();
    eq(first.tools, ["ask_agent"], "offered ask_agent, and nothing else");
    eq(first.stream, false);
    truthy(first.system.startsWith("You are BeeZilla."), first.system.slice(0, 60));
    truthy(first.system.includes("call ask_agent with its name and your question, and tell the person which agent answered and what it said"), "she is told how, and to say who answered");
    truthy(!/can't do that yet/.test(first.system), "the caution that she cannot hand work on is replaced, not left beside it");
    const follow = calls.find(followUp("ask_agent answered"))!;
    eq(follow.messages.filter((m) => m.role === "user" && String(m.content).startsWith("ask_agent answered")).map((m) => m.content),
      [`ask_agent answered (Bunnyzilla): ${AGENT_ANSWER} Tell the person what Bunnyzilla said and who said it.`]);
    eq((await lines("hd")).slice(before).map((x) => [x.kind, x.from_name, x.to_name, x.session_id]), [["ask", "BeeZilla", "Bunnyzilla", "sess_l2"], ["answer", "Bunnyzilla", "BeeZilla", "sess_l2"]]);
    eq((r.tools ?? []).map((t) => [t.name, t.ok]), [["ask_agent", true]]);
  });
  await ok("a message that shares a word with an agent's job offers ask_agent too, without naming it", async () => {
    await session("sess_l3", "hd");
    rules = [];
    await turn("hd", "sess_l3", "Put the dentist on my calendar for Tuesday");
    eq(mainCall().tools, ["ask_agent"], "'calendar' is Bunnyzilla's job ('calendars')");
  });
  await ok("when neither tool is offered the turn is exactly what it was: no tools, the old caution, still streamed", async () => {
    await session("sess_l4", "hd");
    rules = [];
    const streamed: string[] = [];
    const r = await turn("hd", "sess_l4", "What should I make for dinner on Friday?", { onText: (d) => streamed.push(d) });
    truthy(r.ok, r.error || "");
    const c = mainCall();
    eq(c.tools, [], "no tools in the request");
    eq(c.stream, true, "streamed, as an ordinary turn is");
    eq(streamed.join("").trim(), DEFAULT_ANSWER, "its words arrived as they were written");
    const ready = await ag.readyAgents(sql, "hd");
    truthy(c.system.startsWith(chat + ag.agentsRosterBlock(ready)), "the persona, then the roster with the caution it has always had");
    truthy(/Don't say you have asked an agent, passed something on or checked with one: you can't do that yet, and saying so would be false\./.test(c.system) && !/ask_agent|ask_bzilla/.test(c.system), "no word about asking");
    eq(calls.filter(nested).length, 0, "no delegation");
    eq(r.tools, undefined, "no tool strip");
  });
  await ok("an agent that has no job yet is not offered ask_bzilla, and its prompt does not mention it", async () => {
    await route("hd", "POST", "", { creature: "frog", look: "lime" });
    const idle = ((await route("hd", "GET", "")).body.agents as ag.Agent[]).find((a) => a.look === "lime")!;
    await session("sess_l5", "hd", idle.id);
    rules = [];
    await turn("hd", "sess_l5", "What should I do first?");
    const c = mainCall();
    eq(c.tools, []);
    truthy(/don't have a job yet/.test(c.system) && !/ask_bzilla/.test(c.system), c.system.slice(-300));
  });
  await ok("a person with no agents is sent exactly the prompt they were before: nothing about agents, no tools", async () => {
    await session("sess_l6", "hnoag");
    rules = [];
    const r = await turn("hnoag", "sess_l6", "Please ask Bunnyzilla what is on its list this week");
    truthy(r.ok);
    const c = mainCall();
    eq(c.tools, [], "even when the message asks for an agent");
    truthy(c.system.startsWith("You are BeeZilla.") && !/ZILLA AGENTS|YOUR JOB AS|Zilla agent|ask_agent|ask_bzilla/.test(c.system), "nothing about agents at all");
    eq(c.system.slice(0, chat.length), chat);
  });
  await ok("a turn may ask at most twice: the third call in one message is refused in words, and only two exchanges are logged", async () => {
    await session("sess_l7", "hd");
    const before = await count("buzzy_hive_messages", "hd");
    rules = [
      { when: nested, reply: say(AGENT_ANSWER) },
      { when: offers("ask_agent"), reply: { toolCalls: [
        { name: "ask_agent", args: { agent: "Bunnyzilla", question: "One?" } },
        { name: "ask_agent", args: { agent: "Bullzilla", question: "Two?" } },
        { name: "ask_agent", args: { agent: "Frogzilla", question: "Three?" } },
      ] } },
      { when: followUp("ask_agent answered"), reply: say("Two of them answered.") },
    ];
    const r = await turn("hd", "sess_l7", "Please ask Bunnyzilla, Bullzilla and Frogzilla how their weeks are going");
    truthy(r.ok, r.error || "");
    eq(calls.filter(nested).length, 2, "two nested calls, not three");
    const results = calls.find(followUp("ask_agent answered"))!.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    eq(results.filter((m) => m.startsWith("ask_agent answered (Bunnyzilla)") || m.startsWith("ask_agent answered (Bullzilla)")).length, 2);
    truthy(results.some((m) => m.startsWith("tool_refused (ask_agent): one turn may ask at most 2 times")), results.join(" | ").slice(-300));
    eq((await lines("hd")).slice(before).map((x) => `${x.kind}:${x.from_name}>${x.to_name}`), [
      "ask:BeeZilla>Bunnyzilla", "answer:Bunnyzilla>BeeZilla", "ask:BeeZilla>Bullzilla", "answer:Bullzilla>BeeZilla",
    ]);
    eq((r.tools ?? []).length, 2, "two tool runs on the strip");
  });
  await ok("the cap is per tool as well: an agent's turn may not ask BeeZilla a third time either", async () => {
    await session("sess_l8", "hd", dTeam[0]!.id);
    const before = await count("buzzy_hive_messages", "hd");
    rules = [
      { when: nested, reply: say(BZ_ANSWER) },
      { when: offers("ask_bzilla"), reply: { toolCalls: [1, 2, 3].map((n) => ({ name: "ask_bzilla", args: { question: `Question ${n}?` } })) } },
      { when: followUp("ask_bzilla answered"), reply: say("Done.") },
    ];
    const r = await turn("hd", "sess_l8", "Which days are free this month, and which are busy, and which are best?");
    truthy(r.ok);
    eq(calls.filter(nested).length, 2);
    eq(((await lines("hd")).length - before), 4);
  });
  await ok("an agent that is not there is refused in words that reach the model, and nothing is logged", async () => {
    await session("sess_l9", "hd");
    const before = await count("buzzy_hive_messages", "hd");
    rules = [
      { when: offers("ask_agent"), reply: tool("ask_agent", { agent: "Zorp", question: "Hello?" }) },
      { when: followUp("ask_agent could not ask"), reply: say("I couldn't find an agent called Zorp.") },
    ];
    const r = await turn("hd", "sess_l9", "Please ask Bunnyzilla something");
    truthy(r.ok);
    const msg = calls.find(followUp("ask_agent could not ask"))!.messages.map((m) => String(m.content)).find((m) => m.startsWith("ask_agent could not ask"))!;
    truthy(msg.includes("None of the person's agents is called \"Zorp\"") && ["Bunnyzilla", "Bullzilla", "Frogzilla"].every((n) => msg.includes(n)) && msg.includes("Nobody has been asked"), msg);
    eq(calls.filter(nested).length, 0, "no nested call");
    eq(await count("buzzy_hive_messages", "hd"), before, "nothing logged");
    eq((r.tools ?? []).map((t) => [t.name, t.ok, t.code]), [["ask_agent", false, "not_found"]], "the strip says it did not work, and why");
  });
  await ok("a nested model that fails reaches the turn as plain words; the turn still answers; nothing is logged", async () => {
    await session("sess_l10", "hd", dTeam[0]!.id);
    const before = await count("buzzy_hive_messages", "hd");
    const warn = console.warn;
    console.warn = () => {};
    try {
      rules = [
        { when: nested, reply: { status: 500 } },
        { when: offers("ask_bzilla"), reply: tool("ask_bzilla", { question: "Which day?" }) },
        { when: followUp("ask_bzilla could not ask"), reply: say("I couldn't reach BeeZilla just now.") },
      ];
      const r = await turn("hd", "sess_l10", "Which day this week is free for a long lunch with Sam?");
      truthy(r.ok, r.error || "");
      eq(r.reply, "I couldn't reach BeeZilla just now.");
      const msg = calls.find(followUp("ask_bzilla could not ask"))!.messages.map((m) => String(m.content)).find((m) => m.startsWith("ask_bzilla could not ask"))!;
      truthy(/could not be reached/.test(msg) && /do not guess/.test(msg), msg);
    } finally {
      console.warn = warn;
    }
    eq(await count("buzzy_hive_messages", "hd"), before, "nothing logged");
  });
  await ok("a tool the turn was not offered is refused in words that say why (a model may call a tool it was never given)", async () => {
    await session("sess_l11", "hd");
    const before = await count("buzzy_hive_messages", "hd");
    // BeeZilla's own plain turn: no tools offered, but the model calls ask_agent anyway.
    rules = [
      { when: (c) => c.tools.length === 0 && c.user === "What should I make for dinner on Friday?", reply: tool("ask_agent", { agent: "Bunnyzilla", question: "Dinner?" }) },
      { when: followUp("tool_refused"), reply: say("I can't ask an agent from here.") },
    ];
    const r = await turn("hd", "sess_l11", "What should I make for dinner on Friday?");
    truthy(r.ok, r.error || "");
    const msg = calls.find(followUp("tool_refused"))!.messages.map((m) => String(m.content)).find((m) => m.startsWith("tool_refused"))!;
    truthy(msg.startsWith("tool_refused (ask_agent): ask_agent is not available in this conversation — only BeeZilla herself can ask one of the person's agents, and only when what the person said is about one of them"), msg);
    // An agent's turn: ask_agent was never offered either.
    await session("sess_l12", "hd", dTeam[0]!.id);
    rules = [
      { when: (c) => c.tools.includes("ask_bzilla") && c.user === "What is on my list?", reply: tool("ask_agent", { agent: "Bullzilla", question: "Trips?" }) },
      { when: followUp("tool_refused"), reply: say("I can't do that from here.") },
    ];
    const r2 = await turn("hd", "sess_l12", "What is on my list?");
    truthy(r2.ok, r2.error || "");
    const msg2 = calls.find(followUp("tool_refused"))!.messages.map((m) => String(m.content)).find((m) => m.startsWith("tool_refused"))!;
    truthy(msg2.startsWith("tool_refused (ask_agent): ask_agent is not available in this conversation"), msg2);
    eq(calls.filter(nested).length, 0, "no delegation happened");
    eq(await count("buzzy_hive_messages", "hd"), before, "nothing logged");
    // And the same for BeeZilla calling ask_bzilla.
    await session("sess_l13", "hd");
    rules = [
      { when: (c) => c.tools.length === 0 && c.user === "What should I cook tonight?", reply: tool("ask_bzilla", { question: "Dinner?" }) },
      { when: followUp("tool_refused"), reply: say("Not from here.") },
    ];
    await turn("hd", "sess_l13", "What should I cook tonight?");
    const msg3 = calls.find(followUp("tool_refused"))!.messages.map((m) => String(m.content)).find((m) => m.startsWith("tool_refused"))!;
    truthy(msg3.startsWith("tool_refused (ask_bzilla): ask_bzilla is not available in this conversation — only one of the person's agents that has a job can ask BeeZilla"), msg3);
  });
  await ok("a model that rejects the tool list does not cost the person their agent: the turn is answered as the ordinary turn it was", async () => {
    await session("sess_l14", "hd", dTeam[0]!.id);
    const warn = console.warn;
    console.warn = () => {};
    try {
      rules = [{ when: (c) => c.tools.length > 0, reply: { status: 400 } }];
      const r = await turn("hd", "sess_l14", "What is on my list?");
      truthy(r.ok, `the turn ran: ${r.error || ""}`);
      eq(r.reply, DEFAULT_ANSWER, "answered");
      const mains = calls.filter((c) => /You are Bunnyzilla/.test(c.system));
      eq(mains.map((c) => c.tools.length > 0), [true, false], "asked with the tools, and once more without them");
    } finally {
      console.warn = warn;
    }
  });
  await ok("an agent's turn that also asks for a file carries the Hive's tool with the registry's own, not instead of them", async () => {
    await session("sess_l15", "hd", dTeam[0]!.id);
    rules = [];
    await turn("hd", "sess_l15", "Please put my weekly plan in a word document");
    const tools = mainCall().tools;
    truthy(tools.includes("ask_bzilla") && tools.includes("web_search") && tools.includes("calculate"), tools.join(","));
    eq(tools.filter((n) => n.startsWith("ask_")), ["ask_bzilla"], "and never ask_agent in an agent's turn");
  });

  console.log("\nThe notes the agents' own routes write\n");

  await ok("telling an agent its job leaves a note in the Hive (from and to the agent), with the conversation it was said in", async () => {
    const id = ((await route("hnote", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    await session("sess_n1", "hnote");
    const r = await route("hnote", "POST", `${id}/identity`, { text: "You're in charge of my calendars", sessionId: "sess_n1" });
    eq(r.body.saved, true);
    const rows = await lines("hnote");
    eq(rows.map((x) => [x.kind, x.from_id, x.to_id, x.from_name, x.to_name, x.body, x.session_id]), [["note", id, id, "Bunnyzilla", "Bunnyzilla", "Bunnyzilla took on a job: calendars", "sess_n1"]]);
    const shown = await hv.listHive(sql, "hnote");
    eq([shown[0]!.kind, shown[0]!.fromId === shown[0]!.toId], ["note", true]);
  });
  await ok("words with no job in them leave no note; a conversation that is not the person's is not kept in it", async () => {
    const id = ((await route("hnote2", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    for (const text of ["", "please", "ok"]) await route("hnote2", "POST", `${id}/identity`, { text });
    eq(await count("buzzy_hive_messages", "hnote2"), 0, "no job, no note");
    await session("sess_theirs2", "someone-else");
    await route("hnote2", "POST", `${id}/identity`, { text: "recipes", sessionId: "sess_theirs2" });
    const [row] = await lines("hnote2");
    eq([row!.body, row!.session_id], ["Bunnyzilla took on a job: recipes", null], "the note is still written, without a conversation that is not theirs");
    await route("hnote2", "POST", `${id}/identity`, { text: "Take care of my real estate business" });
    eq((await lines("hnote2")).map((x) => x.body), ["Bunnyzilla took on a job: recipes", "Bunnyzilla took on a job: real estate business"], "a new job is a new note");
  });
  await ok("a note that cannot be written never blocks the call that asked for it", async () => {
    const id = ((await route("hnote3", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    await sql.query("ALTER TABLE buzzy_hive_messages RENAME TO buzzy_hive_messages_away");
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      const r = await route("hnote3", "POST", `${id}/identity`, { text: "taxes" });
      eq([r.status, r.body.saved, (r.body.agent as ag.Agent).role], [200, true, "taxes"], "the job is saved");
      const colony = await route("hnote3", "POST", "colonies", { name: "Money", agents: [id] });
      eq(colony.status, 201, "and the colony is made");
    } finally {
      console.warn = warn;
      await sql.query("ALTER TABLE buzzy_hive_messages_away RENAME TO buzzy_hive_messages");
    }
    truthy(warned >= 2, `it said it dropped them (${warned})`);
    eq(await count("buzzy_hive_messages", "hnote3"), 0);
  });
  await ok("making a colony leaves a note naming the colony and its agents (from and to BeeZilla); a colony that is refused leaves none", async () => {
    const ids = (await team("hcol", ["calendars", "trips", "recipes", "hotels"])).map((a) => a.id);
    const names = ((await route("hcol", "GET", "")).body.agents as ag.Agent[]).map((a) => a.name);
    const made = await route("hcol", "POST", "colonies", { name: "Travel and time", purpose: "x", agents: [ids[1], ids[0]] });
    eq(made.status, 201);
    eq((await lines("hcol")).map((x) => [x.kind, x.from_id, x.to_id, x.from_name, x.to_name, x.body, x.session_id]), [
      ["note", "bzilla", "bzilla", "BeeZilla", "BeeZilla", `A colony was made: Travel and time (${names[1]}, ${names[0]})`, null],
    ]);
    const refused = await route("hcol", "POST", "colonies", { name: "Nope", agents: ["ag_zzzzzzzzzzzz"] });
    eq(refused.status, 404);
    const empty = await route("hcol", "POST", "colonies", { name: "Nope" });
    eq(empty.status, 400);
    eq(await count("buzzy_hive_messages", "hcol"), 1, "refusals say nothing");
    await route("hcol", "POST", "colonies", { agents: [ids[2]] });
    truthy((await lines("hcol")).at(-1)!.body.startsWith("A colony was made: New colony ("), "a colony with no name is called what it is called");
  });
  await ok("a colony of many agents lists the first few and counts the rest", async () => {
    const ids = (await team("hcol2", ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"])).map((a) => a.id);
    await route("hcol2", "POST", "colonies", { name: "Everyone", agents: ids });
    const body = (await lines("hcol2")).at(-1)!.body;
    truthy(/^A colony was made: Everyone \((?:[^,]+, ){5}[^,]+, and 2 more\)$/.test(body), body);
  });

  console.log("\nExport and deletion\n");

  await ok("the export has zilla_hive.csv (time, from, to, kind, text) when there are lines, with line breaks and commas quoted, and none when there are not", async () => {
    await hv.logHive(sql, "hexp", { thread: "t", kind: "ask", from: A, to: hv.BEEZILLA, body: "Which day, exactly?" });
    await hv.logHive(sql, "hexp", { thread: "t", kind: "answer", from: hv.BEEZILLA, to: A, body: "Friday.\n\nAnd \"maybe\" Monday." });
    await hv.noteHive(sql, "hexp", A, "Bunnyzilla took on a job: calendars");
    const zip = await JSZip.loadAsync((await buildExportBundle(sql, "hexp")).bytes);
    const csv = await zip.file("zilla_hive.csv")!.async("string");
    const rows = csv.split("\n");
    eq(rows[0], "time,from,to,kind,text");
    truthy(/^\d{4}-\d\d-\d\dT[\d:.]+Z,Bunnyzilla,BeeZilla,ask,"Which day, exactly\?"$/.test(rows[1]!), rows[1]);
    truthy(/^\d{4}-\d\d-\d\dT[\d:.]+Z,BeeZilla,Bunnyzilla,answer,"Friday\.$/.test(rows[2]!), rows[2]);
    truthy(csv.includes("And \"\"maybe\"\" Monday.\""), "the quotes in the text are doubled, as CSV wants");
    truthy(/,Bunnyzilla,Bunnyzilla,note,Bunnyzilla took on a job: calendars$/.test(csv), "the note, from and to the same one");
    const none = await JSZip.loadAsync((await buildExportBundle(sql, "nobody-at-all")).bytes);
    eq(none.file("zilla_hive.csv"), null, "no lines, no file");
    const other = await JSZip.loadAsync((await buildExportBundle(sql, "hx1")).bytes);
    eq((await other.file("zilla_hive.csv")!.async("string")).includes("theirs"), false, "never someone else's");
  });
  await ok("closing an account removes its lines, and no one else's", async () => {
    truthy(DELETION_STATEMENTS.buzzy_hive_messages, "buzzy_hive_messages is not removed with the account");
    truthy(/WHERE user_id = \$1/.test(DELETION_STATEMENTS.buzzy_hive_messages!), "and only the person's own");
    await hv.logHive(sql, "hbye", { thread: "t", kind: "ask", from: A, to: hv.BEEZILLA, body: "one" });
    await hv.logHive(sql, "hbye", { thread: "t", kind: "answer", from: hv.BEEZILLA, to: A, body: "two" });
    const others = [await count("buzzy_hive_messages", "hx1"), await count("buzzy_hive_messages", "hd")];
    const receipt = await deleteAccountData(sql, "hbye");
    eq(receipt.buzzy_hive_messages, 2, "the receipt counts them");
    eq(await count("buzzy_hive_messages", "hbye"), 0);
    eq([await count("buzzy_hive_messages", "hx1"), await count("buzzy_hive_messages", "hd")], others, "no one else's");
  });

  console.log("\nThrough the real /api/buzzy handler, signed in\n");

  process.env.BZ_DEFAULT_PLAN = "pro";
  const { handleAuthRequest } = await import("../src/lib/auth/server");
  const { latestDevMailFor } = await import("../src/lib/mailer");
  const nitro = (await import("../src/lib/buzzy/chat.nitro")).default;
  const ORIGIN = "http://127.0.0.1:8090";
  const app = new H3();
  app.all("/**", nitro as never);
  const signIn = async (email: string) => {
    const sent = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, accept: "application/json" },
      body: JSON.stringify({ email, callbackURL: "/buzzy/talk" }),
    }));
    truthy(sent.ok, `magic link send: ${sent.status}`);
    const link = latestDevMailFor(email)?.actionUrl;
    truthy(link, "magic link captured in the dev inbox");
    const verified = await handleAuthRequest(new Request(link!, { headers: { accept: "text/html" } }));
    const cookie = verified.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => /session_token=./.test(c) || /session_data=./.test(c)).join("; ");
    truthy(/session_token=/.test(cookie), `the link signs in (status ${verified.status})`);
    return cookie;
  };
  const call = async (cookie: string | null, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { host: "127.0.0.1:8090", "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    const res = await app.fetch(new Request(ORIGIN + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }));
    let json: Record<string, any> = {};
    try { json = JSON.parse(await res.text()); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const stamp = Date.now();
  const alice = await signIn(`alice-hive-${stamp}@example.com`);
  const bob = await signIn(`bob-hive-${stamp}@example.com`);
  const H = "/api/buzzy/hive";
  let aliceBunny = "";
  let agentSession = "";
  let plainSession = "";

  await ok("signed out, the Hive is not shown; signed in, a person with nothing sees an empty list", async () => {
    const out = await call(null, "GET", H);
    eq([out.status, out.json.code], [401, "signed_out"]);
    const posted = await call(null, "POST", H, {});
    eq([posted.status, posted.json.code], [401, "signed_out"], "the session is checked before the method");
    const mine = await call(alice, "GET", H);
    eq([mine.status, mine.json.ok, mine.json.messages], [200, true, []]);
  });
  await ok("an agent in a real conversation asks BeeZilla over HTTP, and the Hive window's request shows both lines", async () => {
    aliceBunny = (await call(alice, "GET", "/api/buzzy/agents")).json.agents[0].id;
    await call(alice, "POST", `/api/buzzy/agents/${aliceBunny}/identity`, { text: "You're in charge of my calendars" });
    agentSession = (await call(alice, "POST", "/api/buzzy/sessions", { agentId: aliceBunny, fresh: true })).json.session.id;
    plainSession = (await call(alice, "POST", "/api/buzzy/sessions", { fresh: true })).json.session.id;
    rules = [
      { when: nested, reply: say(BZ_ANSWER) },
      { when: offers("ask_bzilla"), reply: tool("ask_bzilla", { question: "Which day this week is free?" }) },
      { when: followUp("ask_bzilla answered"), reply: say(BZ_REPLY) },
    ];
    const r = await call(alice, "POST", "/api/buzzy/chat", { sessionId: agentSession, message: "Which day this week is free for a long lunch with Sam?", mode: "chat" });
    eq([r.status, r.json.ok, r.json.reply], [200, true, BZ_REPLY]);
    const feed = await call(alice, "GET", H);
    eq(feed.json.messages.map((m: { kind: string; fromName: string; toName: string }) => `${m.kind}:${m.fromName}>${m.toName}`), [
      "note:Bunnyzilla>Bunnyzilla", "ask:Bunnyzilla>BeeZilla", "answer:BeeZilla>Bunnyzilla",
    ], "the job she was given, then what she asked and what came back");
    if (SHOW) console.log("\n  --- GET /api/buzzy/hive after one ask and one answer ---\n" + JSON.stringify(feed.json, null, 2).replace(/^/gm, "  ") + "\n");
  });
  await ok("BeeZilla asking an agent by name over HTTP shows in the same feed, and ?after= returns only what is new", async () => {
    const before = (await call(alice, "GET", H)).json.messages;
    const last = before[before.length - 1].id;
    rules = [
      { when: nested, reply: say(AGENT_ANSWER) },
      { when: offers("ask_agent"), reply: tool("ask_agent", { agent: "Bunnyzilla", question: "What is on your list this week?" }) },
      { when: followUp("ask_agent answered"), reply: say(AG_REPLY) },
    ];
    const r = await call(alice, "POST", "/api/buzzy/chat", { sessionId: plainSession, message: "Please ask Bunnyzilla what is on its list this week", mode: "chat" });
    eq([r.status, r.json.ok, r.json.reply], [200, true, AG_REPLY]);
    const fresh = await call(alice, "GET", `${H}?after=${last}`);
    eq(fresh.json.messages.map((m: { kind: string; fromName: string; toName: string }) => `${m.kind}:${m.fromName}>${m.toName}`), ["ask:BeeZilla>Bunnyzilla", "answer:Bunnyzilla>BeeZilla"]);
    eq((await call(alice, "GET", `${H}?after=${fresh.json.messages[1].id}`)).json.messages, [], "nothing newer");
    eq((await call(alice, "GET", `${H}?limit=2`)).json.messages.map((m: { kind: string }) => m.kind), ["ask", "answer"], "limit: the latest two");
    eq((await call(alice, "GET", `${H}?after=banana&limit=zero`)).json.messages.length, 5, "nonsense in the query is ignored");
  });
  await ok("another account sees none of it, and cannot write to it", async () => {
    eq((await call(bob, "GET", H)).json, { ok: true, messages: [] });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const out = await call(bob, method, H, { kind: "note", body: "forged" });
      eq([out.status, out.json.code], [405, "method_not_allowed"], method);
    }
    eq((await call(bob, "GET", `${H}/anything`)).status, 404);
    eq((await call(alice, "GET", H)).json.messages.some((m: { body: string }) => m.body === "forged"), false, "nothing was forged");
    const bobsBunny = (await call(bob, "GET", "/api/buzzy/agents")).json.agents[0].id;
    const theirs = await call(bob, "POST", "/api/buzzy/sessions", { agentId: aliceBunny, fresh: true });
    eq([theirs.status, theirs.json.code], [400, "bad_agent"], "and cannot start a conversation as alice's agent");
    eq(bobsBunny === aliceBunny, false);
  });

  console.log("\nNext to the other tools\n");

  await ok("the retry without tools is only for a turn whose only tools were the Hive's: a document or browser turn keeps its own", () => {
    // Since the globe (browserRun.ts) a browser turn carries tools too. If the model refused the list,
    // answering it without use_browser would leave it only able to claim the job, never do it.
    const src = readFileSync(join(process.cwd(), "src", "lib", "buzzy", "server.ts"), "utf8");
    const line = src.split("\n").find((l) => /const onlyHive = /.test(l)) ?? "";
    truthy(/draftGateOpen/.test(line) && /explicitDocumentRequest/.test(line) && /browserTurn/.test(line), line.trim());
  });

  console.log("\nThe rollback\n");

  await ok("rolling 0067 back (twice is fine) drops the table and its index, and touches nothing else", async () => {
    const agentsBefore = await count("buzzy_agents", "hd");
    const down = readFileSync(join(process.cwd(), "migrations", "rollback", "0067_buzzy_hive.down.sql"), "utf8");
    await (await getPglite()).exec(down);
    await (await getPglite()).exec(down); // and again: nothing is left to do, and nothing fails
    const table = await sql.query<{ t: string | null }>("SELECT to_regclass('buzzy_hive_messages')::text AS t");
    eq(table[0]!.t, null, "the table is gone");
    const idx = await sql.query("SELECT 1 FROM pg_indexes WHERE indexname = 'buzzy_hive_messages_user_idx'");
    eq(idx.length, 0, "and its index");
    eq(await count("buzzy_agents", "hd"), agentsBefore, "agents are as they were");
    // An older database reads as an empty Hive, and the agents still work without it.
    const warn = console.warn;
    console.warn = () => {};
    try {
      eq(await hv.logHive(sql, "hd", { thread: "t", kind: "note", from: hv.BEEZILLA, to: hv.BEEZILLA, body: "x" }), null, "writing says nothing and fails nothing");
      const r = await route("hd", "PATCH", dTeam[0]!.id, { size: "l" });
      eq(r.status, 200, "an agent can still be changed");
    } finally {
      console.warn = warn;
    }
  });

  model.close();
  console.log(`\nagent-hive: ${pass} checks passed${fail ? `, ${fail} FAILED` : ""}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
