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
