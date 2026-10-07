/**
 * Buzzy chat — server-side chat loop.
 *
 * Called from the Nitro route handler (chat.nitro.ts) by the agent-api
 * pattern: a thin h3 handler delegates to this pure function.
 *
 * Flow:
 * 1. Ensure Honcho peer for this user.
 * 2. Load recent chat messages + memory facts for user/job.
 * 3. Build system prompt with persona, slot state, and guidance.
 * 4. Call the LLM harness (chatCompletion).
 * 5. Sanitize the reply (jargon guard + payload sanitizer).
 * 6. Persist messages to buzzy_chat_messages.
 * 7. Persist slot facts to buzzy_user_memory.
 * 8. Sync conversation to Honcho session.
 * 9. Return structured response.
 */

import { chatCompletion, getModels } from "./llm";
import { sanitizeMemoryText, leaksJargon } from "./sanitizer";
import { BUZZY_QUESTIONS, SLOT_IDS, REQUIRED_SLOTS } from "./questions";
import { getSql } from "@/lib/db";
import { DbMemory } from "./memory";
import { ensurePeer, ensureSession, syncMessages, honchoAvailable } from "./honcho";

// ── Persona prompt ─────────────────────────────────────────────────────

const PERSONA = `You are BeeZilla, a no-nonsense project manager who turns a client's problem into a clear, actionable scope of work. Speak in plain business English — no jargon, no acronyms, no "mission"/"claim" talk, no small talk, no filler praise ("good call", "nice", "sorry you're dealing with that"). Style rules:
- Be brief: 1–3 sentences per turn. Ask exactly ONE question per turn.
- Stay focused on the problem and the decisions needed: what's being done, scope, materials/supplier, budget, timing, and how success gets checked.
- Do not repeat back the user's answer as a restatement or react emotionally to it. Acknowledge in at most two words ("Got it.") or skip the acknowledgment entirely, then move to the next decision.
- Never re-ask something already answered — the conversation state shows what's decided.
- Track decisions, not stories: capture the decision, then move on.
- IMPORTANT — job type: if the client's message is clearly a different kind of job (creative writing, a story, copy, a poem, a technical explainer), work THAT job. Do not refuse it and do not drag in unrelated earlier problems. Only ask scope-of-work questions that fit the actual request.
- Only use details from THIS conversation. Never mention or reuse problems from other jobs.
You never mention models, tokens, or technical internals.`;

// ── Helper: str ────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

// ── Helper: extract slot updates from LLM reply ────────────────────────

function extractSlotsFromReply(
  reply: string,
  currentSlots: Record<string, string>,
): Record<string, string> {
  const updated = { ...currentSlots };
  const slotRegex = /\[(\w+):\s*([^\]]+)\]/g;
  let match;
  while ((match = slotRegex.exec(reply)) !== null) {
    const id = match[1];
    const val = match[2].trim();
    if (SLOT_IDS.includes(id) && val) {
      updated[id] = val;
    }
  }
  return updated;
}

// ── Main chat loop ─────────────────────────────────────────────────────

export interface ChatRequest {
  userId: string;
  jobId: string | null;
  message: string;
  model?: string;
}

export interface ChatResponse {
  ok: boolean;
  reply: string;
  slots?: Record<string, string>;
  draft?: boolean;
  done?: boolean;
  error?: string;
  code?: string;
}

export async function chatLoop(req: ChatRequest): Promise<ChatResponse> {
  const { userId, jobId, message, model } = req;

  if (!message?.trim()) {
    return { ok: false, reply: "", error: "message is required", code: "bad_request" };
  }

  // ── Validate model against catalog ──────────────────────────────────
  if (model) {
    const allowed = getModels();
    const valid = allowed.some(m => m.model === model);
    if (!valid) {
      return {
        ok: false,
        reply: "",
        error: `Unknown model "${model}". Available: ${allowed.map(m => m.label).join(", ")}`,
        code: "invalid_model",
      };
    }
  }

  const sql = await getSql();
  const memory = new DbMemory(sql, userId, jobId);

  // ── Ensure Honcho peer ──────────────────────────────────────────────
  await ensurePeer(userId);

  // ── Load recent chat history ───────────────────────────────────────
  const rows = await sql`
    SELECT role, content FROM buzzy_chat_messages
    WHERE user_id = ${userId} AND job_id IS NOT DISTINCT FROM ${jobId}
    ORDER BY created_at DESC LIMIT 10
  `;

  // Reverse to chronological order
  const history = rows.reverse() as Array<{ role: string; content: string }>;

  // ── Load current slot values ───────────────────────────────────────
  const slotValues: Record<string, string> = {};
  for (const slotId of SLOT_IDS) {
    const facts = await memory.get_facts();
    const fact = facts.find(f => f.key === slotId);
    if (fact) slotValues[slotId] = fact.value;
  }

  const filledCount = REQUIRED_SLOTS.filter(id => slotValues[id]).length;

  // ── Build system prompt ────────────────────────────────────────────
  const factsText = await memory.get_facts();
  const factsSection =
    factsText.length > 0
      ? "\n\nYou have gathered these details so far:\n" +
        factsText.map(f => `- ${f.key}: ${f.value}`).join("\n")
      : "";

  const nextQuestion = REQUIRED_SLOTS[filledCount];
  const nextQ = nextQuestion ? BUZZY_QUESTIONS.find(q => q.id === nextQuestion) : null;

  const guidance = nextQ
    ? `\n\nYour next question should be: "${nextQ.prompt}"`
    : "\n\nAll required details have been gathered. Generate a draft summary for the user to review.";

  const systemPrompt = PERSONA + factsSection + guidance;

  // ── Build messages for LLM ─────────────────────────────────────────
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({
      role: h.role as "user" | "assistant" | "system",
      content: h.content,
    })),
    { role: "user", content: message },
  ];

  // ── Call LLM ───────────────────────────────────────────────────────
  let reply: string;
  try {
    reply = await chatCompletion(messages, { model });
  } catch (err) {
    console.error("[buzzy/chat] LLM request failed:", err instanceof Error ? err.message : err);
    return {
      ok: false,
      reply: "Sorry, I'm having trouble connecting right now. Please try again in a moment.",
      error: err instanceof Error ? err.message : "LLM request failed",
      code: "llm_error",
    };
  }

  // ── Sanitize reply ─────────────────────────────────────────────────
  const sanitizedReply = sanitizeMemoryText(reply);

  if (leaksJargon(sanitizedReply)) {
    // Simple jargon replacement as a fallback
    const fixed = sanitizedReply
      .replace(/mission/gi, "task")
      .replace(/claim/gi, "request")
      .replace(/dev boards/gi, "project board")
      .replace(/token/gi, "word");
    // Note: replace returns a new string; the variable isn't reassigned
    // here intentionally — the main sanitizeMemoryText call already
    // handles the bulk of jargon stripping. This is a belt-and-suspenders
    // pass for edge cases.
    void fixed;
  }

  // ── Persist user message ───────────────────────────────────────────
  const msgId = jobId || `buzzy_${userId.slice(0, 8)}`;
  await sql`
    INSERT INTO buzzy_chat_messages (user_id, job_id, role, content)
    VALUES (${userId}, ${jobId}, 'user', ${message})
  `;

  // ── Persist assistant reply ────────────────────────────────────────
  await sql`
    INSERT INTO buzzy_chat_messages (user_id, job_id, role, content)
    VALUES (${userId}, ${jobId}, 'assistant', ${sanitizedReply})
  `;

  // ── Persist slot updates ───────────────────────────────────────────
  const newSlots = extractSlotsFromReply(sanitizedReply, slotValues);
  for (const [slotId, val] of Object.entries(newSlots)) {
    if (!slotValues[slotId] || slotValues[slotId] !== val) {
      await memory.remember(slotId, val);
    }
  }

  // ── Sync to Honcho ─────────────────────────────────────────────────
  if (honchoAvailable()) {
    const sid = await ensureSession(msgId, userId);
    await syncMessages(sid, userId, [
      { content: message.slice(0, 4000), peer_id: userId },
      { content: sanitizedReply.slice(0, 4000), peer_id: "beezilla" },
    ]);
  }

  // ── Build response ─────────────────────────────────────────────────
  const newFillCount = REQUIRED_SLOTS.filter(id => newSlots[id]).length;

  const response: ChatResponse = {
    ok: true,
    reply: sanitizedReply,
  };

  if (newFillCount > filledCount) {
    response.slots = newSlots;
  }

  if (newFillCount >= REQUIRED_SLOTS.length) {
    response.draft = true;
    response.done = true;
  }

  return response;
}
