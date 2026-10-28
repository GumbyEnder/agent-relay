/**
 * Turn a finished job into a recipe.
 *
 * This is the part that makes a recipe worth buying: the method is not typed in by
 * the author, it is *read out of the work they actually did*. The evidence is the
 * job itself — the first draft, the version they accepted, and every correction they
 * made along the way. The corrections are the valuable part: a first draft is what
 * the model guessed, the accepted version is what the owner knows.
 *
 * Nothing here publishes. It produces a draft the owner can read, correct and price,
 * because a recipe derived from one job is a claim about the next one, and the person
 * who did the work is the only one who can judge whether that claim is true.
 */
import type { Sql } from "@/lib/db";
import { chatCompletion } from "./llm";

export interface JobEvidence {
  jobId: string;
  title: string;
  slots: Record<string, string>;
  firstDraft: string | null;
  finalDraft: string | null;
  corrections: string[];
  ownerAsked: string[];
}

export interface DerivedRecipe {
  title: string;
  description: string;
  discovery: string[];
  boundary: string;
  checklist: { output: string; audience: string; success: string };
  outputContract: string[];
  /** What the derivation leaned on, so the owner can see it was not invented. */
  evidence: { versions: number; corrections: number; messages: number };
}

const MAX_CHARS = 6000;

function clip(s: string | null, n = MAX_CHARS): string | null {
  if (!s) return null;
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`;
}

/** Everything the derivation is allowed to look at. Scoped to the owner. */
export async function gatherEvidence(sql: Sql, userId: string, jobId: string): Promise<JobEvidence | null> {
  const jobs = await sql<{ id: string; title: string | null; data: Record<string, unknown> | null }>`
    SELECT id, title, data FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} LIMIT 1`;
  const job = jobs[0];
  if (!job) return null;

  const docs = await sql<{ id: string; current_version: number }>`
    SELECT id, current_version FROM buzzy_documents
     WHERE job_id = ${jobId} AND user_id = ${userId}
     ORDER BY updated_at DESC LIMIT 1`;
  const doc = docs[0] ?? null;

  let firstDraft: string | null = null;
  let finalDraft: string | null = null;
  let versions = 0;
  if (doc) {
    const rows = await sql<{ version: number; content: string }>`
      SELECT version, content FROM buzzy_document_versions
       WHERE doc_id = ${doc.id} ORDER BY version ASC`;
    versions = rows.length;
    firstDraft = clip(rows[0]?.content ?? null);
    finalDraft = clip(rows[rows.length - 1]?.content ?? null);
  }

  const msgs = await sql<{ role: string; content: string }>`
    SELECT role, content FROM buzzy_chat_messages
     WHERE user_id = ${userId} AND (job_id = ${jobId} OR session_id = ${jobId})
     ORDER BY created_at ASC LIMIT 80`;

  const ownerAsked = msgs
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean)
    .slice(-12);
  const assistantSaid = msgs
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.trim())
    .filter(Boolean);

  // Corrections = what the owner told it to change. The most recent instructions are
  // the ones that shaped the accepted version, so they come from the end of the log.
  const corrections = ownerAsked.filter((c) => /\b(no|not|change|instead|remove|add|don't|do not|should|wrong|fix|keep)\b/i.test(c));

  const data = (job.data ?? {}) as Record<string, unknown>;
  const rawSlots = (data.slots ?? data.slotValues ?? {}) as Record<string, unknown>;
  const slots: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawSlots)) if (typeof v === "string" && v.trim()) slots[k] = v.trim();

  return {
    jobId,
    title: job.title ?? "Untitled job",
    slots,
    firstDraft,
    finalDraft,
    corrections,
    ownerAsked: ownerAsked.length ? ownerAsked : assistantSaid.slice(0, 3),
  };
}

const SCHEMA_HINT = `Return ONLY a JSON object, no prose and no markdown fences, with exactly these keys:
{
  "title": "what to call this recipe on a shelf, 3-60 characters",
  "description": "what a buyer gets, 40-300 characters. Describe the result, never the steps",
  "discovery": ["3 to 6 questions the owner must answer before this can start"],
  "boundary": "one sentence starting with 'Never' — what this must not do",
  "checklist": { "output": "...", "audience": "...", "success": "..." },
  "outputContract": ["3 to 7 section names the finished document always contains"]
}`;

/**
 * Ask the model to read the evidence and write the method down.
 *
 * The prompt is deliberately narrow: it may only describe what the evidence shows.
 * Anything the job did not demonstrate is not part of the method — that is what stops
 * a derived recipe from becoming generic advice with the owner's name on it.
 */
export async function deriveRecipe(ev: JobEvidence): Promise<DerivedRecipe> {
  const parts: string[] = [];
  parts.push(`JOB: ${ev.title}`);
  const slotLines = Object.entries(ev.slots).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  if (slotLines) parts.push(`FACTS THE OWNER GAVE:\n${slotLines}`);
  if (ev.firstDraft) parts.push(`FIRST DRAFT (what the assistant produced before correction):\n"""\n${ev.firstDraft}\n"""`);
  if (ev.finalDraft) parts.push(`ACCEPTED VERSION (what the owner kept):\n"""\n${ev.finalDraft}\n"""`);
  if (ev.corrections.length) parts.push(`CORRECTIONS THE OWNER MADE:\n${ev.corrections.map((c) => `- ${c}`).join("\n")}`);

  const system = [
    "You write recipes from evidence. A recipe is the METHOD of a job that was already done well.",
    "Use only what the evidence shows. If the accepted version differs from the first draft, the",
    "difference is the lesson — say what the owner would have wanted to know before starting.",
    "The boundary must be a real prohibition this job demonstrated, not a generic disclaimer.",
    "Do not mention the owner, the client, or any person by name. Do not include prices or dates",
    "specific to this job; the recipe must work for the next one.",
    SCHEMA_HINT,
  ].join(" ");

  const raw = await chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n\n") },
    ],
    { temperature: 0.2 },
  );

  const json = extractJson(raw);
  if (!json) throw new Error("derivation returned no JSON");
  const d = json as Record<string, unknown>;

  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v.trim() : fallback);
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];

  const checklist = (d.checklist ?? {}) as Record<string, unknown>;
  const out: DerivedRecipe = {
    title: str(d.title, ev.title).slice(0, 120),
    description: str(d.description).slice(0, 600),
    discovery: arr(d.discovery).slice(0, 8),
    boundary: str(d.boundary).slice(0, 400),
    checklist: {
      output: str(checklist.output),
      audience: str(checklist.audience),
      success: str(checklist.success),
    },
    outputContract: arr(d.outputContract).slice(0, 10),
    evidence: { versions: ev.finalDraft ? 1 : 0, corrections: ev.corrections.length, messages: ev.ownerAsked.length },
  };

  // A method with no boundary is not a recipe, it is a wish. Refuse rather than
  // publish something that cannot fail.
  if (!out.boundary) throw new Error("derivation produced no boundary");
  if (out.discovery.length < 2) throw new Error("derivation produced too few discovery questions");
  return out;
}

function extractJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}
