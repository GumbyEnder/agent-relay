/**
 * Buzzy — civilian jargon guard + payload sanitizer.
 *
 * Ported from beezilla-adapter's copy/jargon.ts and memory/payload.ts.
 * Keeps the LLM from leaking Dev Boards / model internals into memory.
 */

/** Forbidden words that must never appear in client-facing output. */
const FORBIDDEN = [
  "mission",
  "claim",
  "dev boards",
  "token",
  "gpt",
  "claude",
] as const;

/**
 * Check whether *text* leaks any forbidden jargon (case-insensitive).
 * Returns true if a leak is detected.
 */
export function leaksJargon(text: string): boolean {
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN) {
    if (lower.includes(word)) return true;
  }
  return false;
}

/** Fields that must never appear in any memory row. */
const NEVER_INCLUDE = new Set([
  "wallet",
  "model_id",
  "token_count",
  "transcript",
]);

/**
 * Sanitize text before writing to memory.
 * - Drops lines that contain forbidden jargon.
 * - Drops lines mentioning wallet/model/token/transcript.
 * - Returns the cleaned text (original if no changes needed).
 */
export function sanitizeMemoryText(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const key of NEVER_INCLUDE) {
      if (lower.includes(key)) {
        kept.push("[redacted]");
        break;
      }
    }
    if (!kept.length || kept[kept.length - 1] !== "[redacted]") {
      kept.push(line);
    }
  }
  return kept.join("\n");
}
