/**
 * Buzzy context budget + explicit compaction (plan doc 23, Phase 4).
 *
 * Rules from the plan:
 *  - Budget accounting per assembled turn (cheap char-based estimate).
 *  - Compaction is EXPLICIT about what was dropped — a stated marker goes
 *    where the middle of the history was; never silent truncation.
 *  - Durable facts live outside the window (company KB, memory), so dropping
 *    middle turns cannot lose them.
 *  - Tool results are normalized before feedback: head+tail keep.
 */

/** Cheap token estimate: ~4 chars/token for mixed prose. */
export function estimateTokens(messages: Array<{ role: string; content: string }>): number {
  return Math.ceil(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
}

export interface CompactionResult {
  messages: Array<{ role: string; content: string }>;
  compacted: boolean;
  droppedCount: number;
}

/**
 * Compact a chat history to a token budget, explicitly.
 * Keeps: the first turn (origin of the job) and the last `keepLast` turns
 * (the live conversation). The middle is replaced with ONE stated marker —
 * the owner-visible behavior is "the thread picks up with a recap," never
 * a silent hole.
 */
export function compactHistory(
  history: Array<{ role: string; content: string }>,
  budgetTokens: number,
  keepLast = 6,
): CompactionResult {
  if (history.length <= keepLast + 1) {
    return { messages: history, compacted: false, droppedCount: 0 };
  }
  const estimate = estimateTokens(history);
  if (estimate <= budgetTokens) {
    return { messages: history, compacted: false, droppedCount: 0 };
  }
  const keepFirst = history[0];
  const keptLast = history.slice(-keepLast);
  const droppedCount = history.length - 1 - keptLast.length;
  const marker = {
    role: "system",
    content:
      `[Earlier conversation summarized out to fit the window — ${droppedCount} turns dropped. ` +
      `Decisions captured in the working box above are retained. If a needed detail is missing, ` +
      `ask the owner rather than guessing.]`,
  };
  return { messages: [keepFirst, marker, ...keptLast], compacted: true, droppedCount };
}

/**
 * Normalize a big tool result before feeding it back: keep the head and tail,
 * state the elision in the middle. Bounded by `maxChars` (default 6000).
 */
export function normalizeToolResult(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return (
    text.slice(0, head) +
    `\n[... ${text.length - maxChars} characters elided ...]\n` +
    text.slice(-tail)
  );
}


/** Rough context window for a model id/label. Env override: BZ_CONTEXT_TOKENS. */
const WINDOW_HINTS: Array<[RegExp, number]> = [
  [/gemini/i, 1000000],
  [/kimi|moonshot/i, 256000],
  [/claude|anthropic/i, 200000],
  [/glm/i, 128000],
  [/deepseek/i, 128000],
  [/qwen/i, 131072],
  [/gpt|openai|solar|mercury/i, 128000],
];

export function contextWindowFor(model: string | null | undefined): number {
  const override = Number(process.env.BZ_CONTEXT_TOKENS || 0);
  if (Number.isFinite(override) && override > 0) return override;
  const m = String(model ?? "");
  for (const [re, n] of WINDOW_HINTS) if (re.test(m)) return n;
  return 128000;
}

/** Every configured model id, comma/space separated in the BZ_* lists. */
function configuredModels(): string[] {
  const out: string[] = [];
  for (const key of ["BZ_CHAT_MODELS", "BZ_VOICE_MODEL", "BZ_CHAT_MODEL", "BZ_ASR_MODEL"]) {
    const raw = (process.env[key] ?? "").trim();
    if (raw) out.push(...raw.split(/[,\s]+/).filter(Boolean));
  }
  return out;
}

/**
 * The ONE total the context meter reports.
 *
 * A conversation is one history shared by several lanes: a typed turn answers on
 * the chat model (gemini: 1M) and a spoken turn on the audio model (gpt-audio:
 * 128k). Reporting each lane's own window made the meter flip between
 * "1% · 7k / 1.0M" and "3% · 4k / 128k" for the same conversation, which reads as
 * two different conversations. The binding limit is the SMALLEST window any lane
 * can be handed, because that is the one compaction actually has to respect, so
 * that is the total shown — consistently, whichever model answered last.
 *
 * Override with BZ_CONVERSATION_TOKENS on a deployment that pins one model.
 */
export function conversationWindowFor(): number {
  const override = Number(process.env.BZ_CONVERSATION_TOKENS || 0);
  if (Number.isFinite(override) && override > 0) return override;
  const models = configuredModels();
  if (!models.length) return contextWindowFor(process.env.BZ_CHAT_MODEL);
  return Math.min(...models.map((m) => contextWindowFor(m)));
}

/** Fraction of the window where we start compacting, and where we warn. */
export const CONTEXT_COMPACT_AT = 0.55;
export const CONTEXT_WARN_AT = 0.75;

/**
 * The fixed allowance a turn pays before any words: tool schemas + protocol
 * overhead, and the persona/brief instructions. Both the live turn and the
 * idle `GET /api/buzzy/context` estimate must use the SAME numbers or the meter
 * jumps the moment you reload the page.
 */
export const CONTEXT_TOOL_OVERHEAD_TOKENS = 1500;
export const CONTEXT_PROMPT_OVERHEAD_TOKENS = 2200;

export interface ContextState {
  used: number;
  limit: number;
  pct: number;
  compacted: boolean;
  dropped: number;
}

export function contextState(
  usedTokens: number,
  limit: number,
  compacted = false,
  dropped = 0,
): ContextState {
  const pct = limit > 0 ? Math.min(100, Math.round((usedTokens / limit) * 100)) : 0;
  return { used: Math.round(usedTokens), limit, pct, compacted, dropped };
}
