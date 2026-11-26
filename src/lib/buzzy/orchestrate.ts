/**
 * BeeZilla the orchestrator: she can make new Zilla agents herself, not only the person.
 *
 * Owner, 2026-11-23: "Bzilla is an orchestrator agent that can create new sub-agents itself,
 * not only the human, give them defined domains of expertise, just write up these agents."
 *
 * One tool, make_agent, offered on BeeZilla's own turns when the person asks for a new agent
 * (a helper, an assistant, a bot, a Zilla). It makes the agent with a name, a job and the
 * folders of the brain it works in (its domains of expertise), exactly as if the person had
 * pressed + and told it its job: it appears in the sidebar at once, under the others, and a
 * line in the Hive says BeeZilla made it. Like the Hive's own tools (hive.ts) it is offered
 * only where it makes sense, because a turn with a tool list is buffered instead of streamed,
 * and the prompt mentions it only when it is really offered.
 */
import type { Sql } from "@/lib/db";
import { BZILLA, COLORS, CREATURES, createAgentWithJob, type Agent, type AgentTurn } from "./agents";
import { cleanPath, domainsForJob, purposeById, slug, subjectById, subjectOf, GENERAL } from "./brainMap";

/** At most this many agents made in one turn ("make me three agents" makes two, then says so). */
export const MAKE_AGENT_MAX_PER_TURN = 2;

/**
 * Does the person ask BeeZilla for a new agent? A verb of making or wanting near a word for an
 * agent: "make me an agent for my taxes", "can you set up a helper that tracks my runs", "I need
 * a new bot for emails", "create a sub-agent". Asking about agents in general ("what can my
 * agents do?") is not asking for one.
 */
const ASKS_FOR_AGENT =
  /\b(?:make|create|add|build|set\s*up|setup|spin\s*up|hire|start|give\s+me|get\s+me|i\s+(?:need|want)|we\s+(?:need|want)|new)\b[^.?!\n]{0,48}?\b(?:agents?|sub-?agents?|helpers?|assistants?|bots?|zillas?)\b/i;

export function asksForAgent(message: unknown): boolean {
  return ASKS_FOR_AGENT.test(String(message ?? ""));
}

/**
 * Is make_agent offered this turn? Only on BeeZilla's own, written turn (an agent never makes
 * agents; a spoken turn on the voice lane has no tools), and only when the message asks for one.
 */
export function makeAgentOffer(input: { agent?: Pick<AgentTurn, "id"> | null; message: string; spoken?: boolean }): boolean {
  if (input.spoken || input.agent) return false;
  return asksForAgent(input.message);
}

/** What BeeZilla is told when make_agent is offered: how to use it, and never to claim it. */
export const MAKE_AGENT_SENTENCE =
  "\n\nMAKING AGENTS. You can make the person a new Zilla agent yourself: call make_agent with a short name, " +
  "the job it takes care of (a few words, like 'my taxes' or 'running'), and the subjects it works in. Make one only " +
  "when they ask for it, at most two in one turn, and then tell them its name, its job and that it is in the sidebar " +
  "on the left. Never say you made an agent unless make_agent returned it this turn.";

export const MAKE_AGENT_TOOL = {
  type: "function",
  function: {
    name: "make_agent",
    description:
      "Make the person a new Zilla agent: a dedicated helper with its own name, job and folders in their brain. Use it only when they ask for a new agent.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name for it, up to 40 characters (for example 'Tax Owl'). Leave it out for a default Zilla name." },
        job: { type: "string", description: "What it helps with, in a few words: 'my taxes', 'running', 'the kitchen remodel'." },
        subjects: {
          type: "array",
          items: { type: "string" },
          description: "The subjects it works in, one or two words each (programming, web design, money, home, travel…). Its folders in the brain are made from these.",
        },
        creature: { type: "string", enum: CREATURES.map((c) => c.id).filter((c) => c !== "bee"), description: "Which Zilla it looks like. Leave it out to pick the next one." },
        colour: { type: "string", enum: COLORS.map((c) => c.name), description: "Its colour. Leave it out for the Zilla's own." },
      },
      required: ["job"],
      additionalProperties: false,
    },
  },
} as const;

/**
 * The folders for what the model said the agent works in: each subject is a knowledge folder
 * (a known subject keeps its own name, anything else is named after the words), plus the
 * skills folder when there are skills for it. None given (or none usable): the job's own.
 */
export function domainsFromSubjects(subjects: unknown, job: string): string[] {
  const out: string[] = [];
  const add = (p: string | null) => { if (p && !out.includes(p) && out.length < 12) out.push(p); };
  for (const raw of Array.isArray(subjects) ? subjects.slice(0, 6) : []) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const known = subjectById(slug(text)) ?? subjectById(subjectOf(text));
    const id = known && known.id !== GENERAL.id ? known.id : slug(text);
    add(cleanPath(`knowledge/${id}`));
    if (purposeById(id)) add(cleanPath(`systems/skills/${id}`));
  }
  return out.length ? out : domainsForJob(job);
}

export type MadeAgent = { ok: true; agent: Agent } | { ok: false; code: string; message: string };

/**
 * make_agent: make the agent, leave a line in the Hive ("BeeZilla made a new agent: Tax Owl,
 * helps with my taxes"), and say what was made. `words` is the person's message that asked for
 * it, kept as the agent's instructions (their own words about the job).
 */
export async function makeAgent(
  sql: Sql,
  userId: string,
  args: { name?: unknown; job?: unknown; subjects?: unknown; creature?: unknown; colour?: unknown; words?: unknown; sessionId?: string | null },
): Promise<MadeAgent> {
  const job = String(args.job ?? "").trim();
  if (!job) return { ok: false, code: "no_job", message: "say what the new agent should help with (job)." };
  const made = await createAgentWithJob(sql, userId, {
    name: args.name,
    job,
    words: args.words,
    domains: domainsFromSubjects(args.subjects, job),
    creature: args.creature,
    look: typeof args.colour === "string" ? args.colour : undefined,
  });
  if (!made.ok) return { ok: false, code: made.code, message: made.error };
  try {
    const { noteHive } = await import("./hive");
    await noteHive(sql, userId, { id: BZILLA.id, name: BZILLA.name }, `BeeZilla made a new agent: ${made.agent.name}, helps with ${made.agent.role}`, args.sessionId ?? null);
  } catch (err) {
    console.warn("[buzzy/orchestrate] a note for the Hive was dropped:", err instanceof Error ? err.message : err);
  }
  return { ok: true, agent: made.agent };
}

/** What the model is told after make_agent ran. */
export function madeMessage(a: Agent): string {
  const where = a.domains.length ? ` It works in ${a.domains.map((d) => "brain/" + d).join(", ")}.` : "";
  return (
    `make_agent made ${a.name}, who helps with ${a.role}.${where} It is in the sidebar on the left, under BeeZilla and the ` +
    `person's other agents; they open it by clicking it. Tell them its name and job in a sentence.`
  );
}
