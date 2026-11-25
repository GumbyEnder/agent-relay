/**
 * The Hive: what the Zilla agents asked each other, and the two ways they do.
 *
 * Owner, 2026-11-21: "When it scrolls above Bzilla, you see something called Hive… If you
 * click on it, you can see your agents talking to each other to get things done,
 * agent-to-agent chat, and observe it happening in the background: a window of chats that
 * say 'Bunnyzilla asked Bzilla for this.' Bzilla manages all the other agents and can talk
 * across all contexts: an executive assistant that works across all contexts."
 *
 * What lives here:
 *   - the log (buzzy_hive_messages, migration 0067): logHive, noteHive and listHive, and
 *     the route /api/buzzy/hive that the Hive window in the sidebar polls (hiveRoute);
 *   - the two delegations, which are real model calls and not decoration: askBzilla (one of
 *     the person's agents asks BeeZilla for something outside its job) and askAgent (BeeZilla
 *     asks one of the person's agents something that is its job). Each runs ONE completion
 *     and writes the question and the answer to the log;
 *   - the two tools the model calls to start them (ask_bzilla and ask_agent), declared here
 *     and registered in toolRegistry.ts, and the rule for which turns are offered which
 *     (hiveOffer).
 *
 * Depth is one, on purpose. The completion inside a delegation is given no tools, so an agent
 * that BeeZilla asks cannot ask her back, and BeeZilla answering an agent cannot ask a third.
 * Nothing here can start a chain: the only way an exchange happens is a model, in a turn the
 * person started, calling a tool the turn offered, at most twice (HIVE_MAX_PER_TURN).
 *
 * Nothing is claimed that did not happen. A line is written only after the answer it records
 * has come back; a model that fails, or is too slow, leaves no question without an answer in
 * the log, and the turn is told in plain words that no one answered (never an exception: a
 * delegation is never what stops a conversation).
 *
 * Everything is the person's own. Every query is scoped by user_id, the route returns only the
 * signed-in person's lines, and an agent that belongs to someone else is answered exactly like
 * one that does not exist.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import { chatCompletionFull } from "./llm";
import { ONE_PERSONA } from "./oneMode";
import {
  AGENTS_MAX,
  BZILLA,
  NAME_MAX,
  ROLE_MAX,
  agentIdentityBlock,
  agentPromptParts,
  cleanBody,
  personaFor,
  readyAgents,
  type AgentTurn,
  type ReadyAgent,
} from "./agents";

// ── Limits ──────────────────────────────────────────────────────────────────

/** The longest line the Hive keeps. A question or an answer is a few sentences; this is the roof. */
export const HIVE_BODY_MAX = 4000;
/** The longest question one party may put to another, before it is cut. */
export const HIVE_QUESTION_MAX = 1500;
/** The most lines kept for one person. The oldest go as new ones are written. */
export const HIVE_KEEP = 2000;
/** How many lines a request for the Hive answers with when it does not say. */
export const HIVE_LIST_DEFAULT = 100;
/** The most a request may ask for at once. */
export const HIVE_LIST_MAX = 200;
/** A note is one short sentence. */
const NOTE_MAX = 400;

/** How many times one turn may ask someone else (per tool as well as in all). */
export const HIVE_MAX_PER_TURN = 2;
/**
 * Room for an answer of a few sentences. It is bigger than the answer needs on purpose: a
 * reasoning model spends part of its budget thinking before it writes, and llm.ts records
 * what a budget of 512 did to those (no answer at all), so the cap leaves room for both.
 */
export const HIVE_MAX_TOKENS = 800;
/**
 * How long a nested answer is waited for: a little under the 45 s the tools are allowed
 * (toolRegistry.ts), so this gives up first and a late answer is never written to the log
 * after the turn has been told there was none.
 */
export const HIVE_DEADLINE_MS = 40_000;

// ── The lines ───────────────────────────────────────────────────────────────

export type HiveKind = "ask" | "answer" | "note";

/** One side of a line: an agent's id and name, or BeeZilla's. */
export interface HiveParty {
  id: string;
  name: string;
}

/** BeeZilla herself, as the Hive writes her: never a row in buzzy_agents, always the text 'bzilla'. */
export const BEEZILLA: HiveParty = { id: BZILLA.id, name: BZILLA.name };

/** One line of the Hive as the window reads it. */
export interface HiveMessage {
  id: number;
  /** Shared by a question and its answer; a note has one of its own. */
  thread: string;
  kind: HiveKind;
  fromId: string;
  toId: string;
  /** Names as they were when the line was written: it still reads right after a rename. */
  fromName: string;
  toName: string;
  body: string;
  /** ISO time. */
  at: string;
}

/** What a caller says to write one line. */
export interface HiveLine {
  thread: string;
  kind: HiveKind;
  from: HiveParty;
  to: HiveParty;
  body: string;
  /** The conversation it was said in, kept for tracing only (never returned). */
  sessionId?: string | null;
  /**
   * When it was said, when that is not now (the question is written after its answer has come).
   * A question and its answer are both dated from this server's clock, so they can never read
   * as answered before they were asked, whatever the database's clock says.
   */
  at?: Date;
}

interface HiveRow {
  id: number | string;
  thread: string;
  kind: string;
  from_id: string;
  to_id: string;
  from_name: string;
  to_name: string;
  body: string;
  created_at: Date | string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const sessionOf = (v: unknown): string | null => (typeof v === "string" && SESSION_ID.test(v) ? v : null);

/** One id for the two lines of one exchange: th_k3j9x0w2m1qa. */
function newThread(): string {
  return "th_" + Array.from(randomBytes(12), (b) => (b % 36).toString(36)).join("");
}

/** One tidy line of text: cleaned like every other text in agents.ts, then its breaks flattened. */
const oneLine = (v: unknown, max: number): string => cleanBody(v, max).replace(/\s+/g, " ").trim();

const nameOf = (p: HiveParty): string => oneLine(p.name, NAME_MAX) || (p.id === BZILLA.id ? BZILLA.name : "An agent");

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function toMessage(r: HiveRow): HiveMessage {
  return {
    id: Number(r.id),
    thread: r.thread,
    kind: r.kind as HiveKind,
    fromId: r.from_id,
    toId: r.to_id,
    fromName: r.from_name,
    toName: r.to_name,
    body: r.body,
    at: iso(r.created_at),
  };
}

/**
 * Keep the newest HIVE_KEEP lines of a person and remove the older ones: find the id of the
 * line just past the newest HIVE_KEEP and delete it and everything before it. A person with
 * fewer lines than that finds no such line, and nothing is deleted. The (user_id, id) index
 * makes the lookup a short walk down the person's own lines.
 */
async function prune(sql: Sql, userId: string): Promise<void> {
  try {
    await sql`
      DELETE FROM buzzy_hive_messages
      WHERE user_id = ${userId}
        AND id <= (SELECT id FROM buzzy_hive_messages WHERE user_id = ${userId} ORDER BY id DESC OFFSET ${HIVE_KEEP} LIMIT 1)
    `;
  } catch (err) {
    console.warn("[buzzy/hive] pruning failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Write one line. Returns its id, or null when it could not be written (nothing to say, an
 * unknown kind, a database that has not had 0067 yet): a line for the Hive is never worth
 * stopping anything for, so this never throws. The body is cut at HIVE_BODY_MAX and cleaned
 * of control characters (line breaks stay); a note is flattened to one short line. Writing
 * also keeps the person to their newest HIVE_KEEP lines.
 */
export async function logHive(sql: Sql, userId: string, line: HiveLine): Promise<number | null> {
  try {
    const kind = line.kind;
    if (kind !== "ask" && kind !== "answer" && kind !== "note") return null;
    const body = kind === "note" ? oneLine(line.body, NOTE_MAX) : cleanBody(line.body, HIVE_BODY_MAX);
    if (!body) return null;
    const when = line.at instanceof Date && !Number.isNaN(line.at.getTime()) ? line.at.toISOString() : null;
    const rows = await sql<{ id: number | string }>`
      INSERT INTO buzzy_hive_messages (user_id, thread, kind, from_id, to_id, from_name, to_name, body, session_id, created_at)
      VALUES (${userId}, ${oneLine(line.thread, 40) || newThread()}, ${kind}, ${oneLine(line.from.id, 40)}, ${oneLine(line.to.id, 40)},
              ${nameOf(line.from)}, ${nameOf(line.to)}, ${body}, ${sessionOf(line.sessionId)},
              COALESCE(${when}::timestamptz, now()))
      RETURNING id
    `;
    await prune(sql, userId);
    return Number(rows[0]?.id) || null;
  } catch (err) {
    console.warn("[buzzy/hive] a line was not written:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * A note: something that happened to an agent (or to BeeZilla) that belongs in the history,
 * as one short plain sentence ("Bunnyzilla took on a job: calendars"). It is from and to the
 * same one. Never throws, like logHive.
 */
export async function noteHive(
  sql: Sql,
  userId: string,
  who: HiveParty,
  body: string,
  sessionId?: string | null,
): Promise<number | null> {
  return logHive(sql, userId, { thread: newThread(), kind: "note", from: who, to: who, body, sessionId });
}

/** A whole number from a query string or a body: null for anything else (a minus sign, a fraction, words). */
const wholeNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  return typeof v === "string" && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null;
};

/**
 * The person's lines, oldest first, as the window reads them. With `after` (an id the window
 * has already seen) it answers with the lines written since, the first `limit` of them, so a
 * window that was away can keep asking from the last id it got and never skips one. With none
 * it answers with the latest `limit` lines. `limit` is HIVE_LIST_DEFAULT when it is missing or
 * is not a positive whole number, and never more than HIVE_LIST_MAX. An `after` that is not a
 * whole number is ignored, as if it had not been sent.
 */
export async function listHive(
  sql: Sql,
  userId: string,
  opts: { after?: unknown; limit?: unknown } = {},
): Promise<HiveMessage[]> {
  const asked = wholeNumber(opts.limit);
  const limit = asked && asked > 0 ? Math.min(asked, HIVE_LIST_MAX) : HIVE_LIST_DEFAULT;
  const after = wholeNumber(opts.after);
  const rows = after !== null
    ? await sql<HiveRow>`
        SELECT id, thread, kind, from_id, to_id, from_name, to_name, body, created_at
        FROM buzzy_hive_messages
        WHERE user_id = ${userId} AND id > ${after}
        ORDER BY id ASC
        LIMIT ${limit}
      `
    : await sql<HiveRow>`
        SELECT id, thread, kind, from_id, to_id, from_name, to_name, body, created_at FROM (
          SELECT id, thread, kind, from_id, to_id, from_name, to_name, body, created_at
          FROM buzzy_hive_messages
          WHERE user_id = ${userId}
          ORDER BY id DESC
          LIMIT ${limit}
        ) latest
        ORDER BY id ASC
      `;
  return rows.map(toMessage);
}

// ── The route ───────────────────────────────────────────────────────────────

export interface HiveReply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (status: number, body: Record<string, unknown>): HiveReply => ({ status, body });

/**
 * /api/buzzy/hive for a signed-in person (chat.nitro.ts checks the session and reads the query
 * string; `rest` is the path after /api/buzzy/hive).
 *
 *   GET /api/buzzy/hive[?after=<id>&limit=<n>]
 *       → { ok: true, messages: [{ id, thread, kind, fromId, toId, fromName, toName, body, at }, …] }
 *         oldest first. Without `after`, the latest 100 (`limit`, at most 200); with it, the
 *         lines after that id. Only the person's own.
 *
 * It only reads. Every other method is refused; the lines are written by the agents' own
 * turns (askBzilla, askAgent) and by notes (noteHive), never by a request.
 */
export async function hiveRoute(
  sql: Sql,
  userId: string,
  method: string,
  rest: string,
  query: { after?: string | null; limit?: string | null } = {},
): Promise<HiveReply> {
  const parts = String(rest ?? "").split("/").filter(Boolean);
  if (parts.length) return reply(404, { ok: false, error: "There is no such Hive page.", code: "not_found" });
  if (method !== "GET") return reply(405, { ok: false, error: "Use GET.", code: "method_not_allowed" });
  const messages = await listHive(sql, userId, { after: query.after, limit: query.limit });
  return reply(200, { ok: true, messages });
}

// ── Which turns may ask ─────────────────────────────────────────────────────
//
// The two tools are never in the always-on list. A tool list that is not empty makes a turn
// buffered instead of streamed (server.ts), which is the price of an agent that can ask for
// help, and it is a price only a turn that can use the tool should pay. So a turn is offered
// a delegation tool only where it makes sense, and the answer is worked out here, once,
// before the prompt is written (the prompt mentions a tool only when the tool is really
// there, so the two can never disagree).

/** Which of the two tools a turn is offered. */
export interface HiveOffer {
  askBzilla: boolean;
  askAgent: boolean;
}

/**
 * Words that carry no job. A message and a job that only share these have nothing in common
 * ("I need help with that" is not about "helping with calendars"). Only words of four letters
 * or more are written down: shorter ones are never compared at all.
 */
const STOP = new Set(
  (
    "about above after again agent agents also always another anyone anything around asked asking asks assistant because been " +
    "before beezilla being below between both cannot care check checked checks could does doing done dont down during each " +
    "either else enough even ever every everyone everything find finds from further gets getting give goes going gonna good " +
    "great handling have having help helped helping helps here hers however into just keep keeping kind know like look " +
    "looking looks made make makes making managing many might more most much must myself need needs never next nice nothing " +
    "often okay once only onto other ours over please really right said same shall should show shows since some someone " +
    "something still stuff such sure take taking tell than thank thanks that their theirs them then there these they thing " +
    "things think this those though through today told tomorrow toward under until upon very want wants well were what " +
    "whatever when where whether which while whom whose will with within without work worked working works would yeah your " +
    "yours yourself zilla"
  ).split(/\s+/),
);

/** "calendars" and "calendar", "taxes" and "tax", "trips" and "trip" are one word; "business" stays as it is. */
function fold(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (w.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** The words of a text that could name a job: four letters or more, not a stop word, plurals folded. */
function jobWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/\p{L}[\p{L}'’]*/gu)) {
    const w = m[0].replace(/['’]s?$/, "");
    if (w.length >= 4 && !STOP.has(w)) out.add(fold(w));
  }
  return out;
}

/** The short words that are never a job and never a name worth matching: "to", "my", "the", "can". */
const SHORT_COMMON = new Set(
  (
    "am an as at be by do go he hi if in is it me my no of oh ok on or so to up us we " +
    "all and any are but can did for get got had has her him his how its let may new nor not now off one our out own " +
    "say see she the too use was who why yes yet you"
  ).split(/\s+/),
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a person might call an agent: its name, and the name without its "zilla" ("Blue
 * Frogzilla" is also "Blue Frog"). A one-letter name, or one that is only a common word, is
 * left out: it would be "named" by almost every message there is.
 */
function aliasesOf(name: string): string[] {
  const full = name.replace(/\s+/g, " ").trim();
  const short = full.replace(/zilla(?=\s|$)/i, "").replace(/\s+/g, " ").trim();
  return [...new Set([full, short])].filter((a) => {
    const w = a.toLowerCase();
    return a.length >= 2 && !STOP.has(w) && !SHORT_COMMON.has(w);
  });
}

/** Does the message say this agent's name, as a whole word (any case, any alphabet)? */
function namedIn(message: string, name: string): boolean {
  return aliasesOf(name).some((alias) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(alias)}(?![\\p{L}\\p{N}_])`, "iu").test(message),
  );
}

/**
 * Which delegation tool, if any, a turn is offered:
 *
 *   - ask_bzilla, in a turn spoken by one of the person's agents that has a job: it is the one
 *     way such an agent can get something outside its job, or from another agent. An agent
 *     with no job yet has nothing to ask for (it is asking the person what its job is).
 *   - ask_agent, in BeeZilla's own turn, only when the person has agents with a job AND the
 *     message is about one: it names one (a whole word, any case; the name without "zilla"
 *     counts too) or shares a significant word with its job (four letters or more, not a stop
 *     word, plural and singular the same). A plain BeeZilla turn is offered neither and is
 *     exactly what it was before.
 *   - neither, on a spoken turn that will run on the voice lane: that lane has no tools at all,
 *     and forcing it onto the text lane for a possible question would slow every spoken
 *     conversation with an agent to the speed of a tool turn.
 *
 * `ready` is every agent of the person that has a job (names and jobs are all that is read).
 */
export function hiveOffer(input: {
  agent?: Pick<AgentTurn, "role"> | null;
  ready: ReadyAgent[];
  message: string;
  spoken?: boolean;
}): HiveOffer {
  const none: HiveOffer = { askBzilla: false, askAgent: false };
  if (input.spoken) return none;
  if (input.agent) return { askBzilla: Boolean(input.agent.role), askAgent: false };
  const ready = (input.ready ?? []).filter((a) => a && a.name && a.role);
  if (!ready.length) return none;
  const text = String(input.message ?? "").replace(/\s+/g, " ");
  const said = jobWords(text);
  const about = ready.some((a) => namedIn(text, a.name) || [...jobWords(a.role)].some((w) => said.has(w)));
  return { askBzilla: false, askAgent: about };
}

/**
 * Every agent of the person that has a job, by name and job, for matching a message against:
 * the list BeeZilla is shown stops at ROSTER_LINES, and a person may name the thirtieth.
 * [] when it cannot be read, which leaves the caller with the shorter list it already had.
 */
export async function readyNames(sql: Sql, userId: string): Promise<ReadyAgent[]> {
  try {
    return await sql<ReadyAgent>`
      SELECT name, role FROM buzzy_agents
      WHERE user_id = ${userId} AND role <> ''
      ORDER BY pos ASC, created_at ASC, id ASC
      LIMIT ${AGENTS_MAX}
    `;
  } catch {
    return [];
  }
}

// ── The tools ───────────────────────────────────────────────────────────────

export const ASK_BZILLA_TOOL = {
  type: "function",
  function: {
    name: "ask_bzilla",
    description:
      "Ask BeeZilla, the person's executive assistant who looks after all their agents and can see across them, for something " +
      "outside your job or that needs another agent. She answers in a few sentences. Use it instead of guessing about another area.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What you need from her, in a sentence or two, with what she needs to know to answer it.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
} as const;

export const ASK_AGENT_TOOL = {
  type: "function",
  function: {
    name: "ask_agent",
    description:
      "Ask one of the person's agents (by name) something that is its job, then tell the person what it said and who said it.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "The agent's name, as it is in the list of the person's agents.",
        },
        question: {
          type: "string",
          description: "What you want to know from it, in a sentence or two, with what it needs to know to answer.",
        },
      },
      required: ["agent", "question"],
      additionalProperties: false,
    },
  },
} as const;

// ── The two delegations ─────────────────────────────────────────────────────

/** What a delegation comes back with: the answer, or, in plain words, why there is none. */
export type Delegation =
  | { ok: true; text: string; /** The agent that answered (askAgent). */ agentName?: string }
  | { ok: false; code: string; message: string };

const refused = (code: string, message: string): Delegation => ({ ok: false, code, message });

/** `names`, at most `max` of them, and "and 3 more" for the rest. */
function nameList(names: string[], max: number): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown}, and ${names.length - max} more` : shown;
}

/** A text as a sentence that can be followed by another: with an end mark, which it is given if it has none. */
export const sentence = (q: string): string => (/[.?!…)"'”]$/.test(q) ? q : `${q}.`);

/** BeeZilla's own persona, the one she speaks in conversation: the one persona (oneMode.ts). */
async function chatPersona(): Promise<string> {
  return ONE_PERSONA;
}

/**
 * ONE completion with no tools: a system prompt and a message, answered in a few sentences.
 * The person's own key applies when the turn runs on it (llm.ts keeps it per request), and
 * `model` is the one the turn was routed to, so a person who chose a local or a cheaper model
 * is not quietly sent to another. Gives up after `deadlineMs` (a late answer is dropped, not
 * written anywhere). The text, or null for any failure: the model erred, the request failed,
 * it was too slow, or it said nothing.
 */
async function converse(
  system: string,
  user: string,
  opts: { model?: string; deadlineMs?: number },
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answered = chatCompletionFull(
      [{ role: "system", content: system }, { role: "user", content: user }],
      { model: opts.model, maxTokens: HIVE_MAX_TOKENS },
    );
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer in time")), opts.deadlineMs ?? HIVE_DEADLINE_MS);
    });
    const done = await Promise.race([answered, tooSlow]);
    return cleanBody(done.content, HIVE_BODY_MAX) || null;
  } catch (err) {
    console.warn("[buzzy/hive] a nested answer failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One of the person's agents asks BeeZilla for something. Her prompt is her own conversational
 * persona and the roster of the person's agents and colonies (the same text she is given in
 * her own conversation, with its caution that she cannot hand anything over, because here
 * she has no tools), and the question is put to her as the agent's. She answers as the
 * person's executive assistant, in a few sentences, from what she knows about their agents
 * and about this exchange.
 *
 * The question and the answer are written to the Hive (the agent → BeeZilla, then BeeZilla →
 * the agent, one thread) once the answer is in. A model that fails writes nothing.
 */
export async function askBzilla(
  sql: Sql,
  userId: string,
  args: {
    agent: Pick<AgentTurn, "id" | "name" | "role">;
    question: string;
    sessionId?: string | null;
    model?: string;
    deadlineMs?: number;
  },
): Promise<Delegation> {
  const question = cleanBody(args.question, HIVE_QUESTION_MAX);
  if (!question) return refused("no_question", "There was no question to pass on. Say what you need from BeeZilla, in a sentence or two.");
  const asker: HiveParty = { id: args.agent.id, name: oneLine(args.agent.name, NAME_MAX) || "Your agent" };
  const job = oneLine(args.agent.role, ROLE_MAX);

  let ready: ReadyAgent[] = [];
  try { ready = await readyAgents(sql, userId); } catch { ready = []; }
  const parts = agentPromptParts(null, await chatPersona(), ready);
  const who = job ? `${asker.name} (who helps with ${job})` : asker.name;

  const askedAt = new Date();
  const text = await converse(
    parts.persona + parts.section,
    `${who} asks you: ${sentence(question)} Answer it as the person's executive assistant, in a few sentences, only from what you ` +
      `know about their agents and this conversation; never claim you did something you did not.`,
    args,
  );
  if (!text) {
    return refused(
      "ask_failed",
      "BeeZilla could not be reached just now, so there is no answer to pass on. Tell the person you could not ask her, and do not guess what she would say.",
    );
  }
  const thread = newThread();
  await logHive(sql, userId, { thread, kind: "ask", from: asker, to: BEEZILLA, body: question, sessionId: args.sessionId, at: askedAt });
  await logHive(sql, userId, { thread, kind: "answer", from: BEEZILLA, to: asker, body: text, sessionId: args.sessionId, at: new Date() });
  return { ok: true, text };
}

interface ReadyRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
  face: string;
}

/**
 * Which of the person's agents that have a job `ref` means: the one whose name is exactly it
 * (any case); else the one whose name starts with it; else the one whose name contains it.
 * Each step is taken only when the one before found nobody, and a step that finds more than one
 * is ambiguous (the refusal names the choices, with what each helps with, so two agents of one
 * name can still be told apart). Nobody found is a refusal that lists the agents that do have a
 * job. An agent with no job yet is not there to be found, and neither is anyone else's.
 */
async function findReadyAgent(
  sql: Sql,
  userId: string,
  ref: unknown,
): Promise<{ ok: true; agent: AgentTurn } | { ok: false; code: string; message: string }> {
  const wanted = oneLine(ref, NAME_MAX * 2);
  const rows = await sql<ReadyRow>`
    SELECT id, name, role, instructions, face FROM buzzy_agents
    WHERE user_id = ${userId} AND role <> ''
    ORDER BY pos ASC, created_at ASC, id ASC
    LIMIT ${AGENTS_MAX}
  `;
  if (!rows.length) {
    return {
      ok: false,
      code: "no_agents",
      message:
        "The person has no agents with a job yet, so there is no one to ask. An agent needs a job first: they open it in the " +
        "sidebar and tell it what it helps with. Tell them that, and do not pretend anyone answered.",
    };
  }
  const names = rows.map((r) => r.name);
  if (!wanted) {
    return { ok: false, code: "not_found", message: `Say which agent to ask. The agents that have a job are: ${nameList(names, 20)}.` };
  }
  const low = wanted.toLowerCase();
  for (const group of [
    rows.filter((r) => r.name.trim().toLowerCase() === low),
    rows.filter((r) => r.name.toLowerCase().startsWith(low)),
    rows.filter((r) => r.name.toLowerCase().includes(low)),
  ]) {
    if (group.length === 1) {
      const r = group[0]!;
      return { ok: true, agent: { id: r.id, name: r.name, role: r.role, instructions: r.instructions ?? "", face: r.face ?? "" } };
    }
    if (group.length > 1) {
      return {
        ok: false,
        code: "ambiguous",
        message:
          `More than one of the person's agents fits "${wanted}": ${nameList(group.map((r) => `${r.name} (helps with ${r.role})`), 8)}. ` +
          `Ask again with the full name of one of them, or ask the person which they mean. Nobody has been asked.`,
      };
    }
  }
  return {
    ok: false,
    code: "not_found",
    message:
      `None of the person's agents is called "${wanted}". The agents that have a job are: ${nameList(names, 20)}. ` +
      `Ask again with one of those names, or tell the person you could not find it. Nobody has been asked.`,
  };
}

/**
 * BeeZilla asks one of the person's agents something that is its job. `agentRef` is whatever she
 * called it (findReadyAgent says how it is matched). The agent answers from its own prompt, the
 * same persona and job it speaks with in its own conversations, put the question by BeeZilla,
 * in a few sentences. It has no tools here, and it does not see its own conversations: what it
 * can answer from is its job, what the person said to set it up, and what she asks.
 *
 * The question (BeeZilla → the agent) and the answer (the agent → BeeZilla) are written to the
 * Hive, one thread, once the answer is in. An agent that cannot be found, or is not clear, is
 * refused in plain words and nothing is written (nobody was asked).
 */
export async function askAgent(
  sql: Sql,
  userId: string,
  args: {
    agentRef: string;
    question: string;
    sessionId?: string | null;
    model?: string;
    deadlineMs?: number;
  },
): Promise<Delegation> {
  const question = cleanBody(args.question, HIVE_QUESTION_MAX);
  if (!question) return refused("no_question", "There was no question to ask. Say what you want to know from the agent, in a sentence or two.");
  const found = await findReadyAgent(sql, userId, args.agentRef);
  if (!found.ok) return refused(found.code, found.message);
  const agent = found.agent;
  const replier: HiveParty = { id: agent.id, name: agent.name };

  const system = personaFor(agent, await chatPersona()) + agentIdentityBlock(agent);
  const askedAt = new Date();
  const text = await converse(
    system,
    `BeeZilla (the person's executive assistant) asks you: ${sentence(question)} Answer in a few sentences, as the agent you are, ` +
      `only from what you know about your job; never claim you did something you did not.`,
    args,
  );
  if (!text) {
    return refused(
      "ask_failed",
      `${agent.name} could not be reached just now, so there is no answer to pass on. Tell the person you could not ask it, and do not guess what it would say.`,
    );
  }
  const thread = newThread();
  await logHive(sql, userId, { thread, kind: "ask", from: BEEZILLA, to: replier, body: question, sessionId: args.sessionId, at: askedAt });
  await logHive(sql, userId, { thread, kind: "answer", from: replier, to: BEEZILLA, body: text, sessionId: args.sessionId, at: new Date() });
  return { ok: true, text, agentName: agent.name };
}
