/**
 * BeeZilla — civilian jargon leak guard
 *
 * Returns true when text contains any forbidden Dev Boards / LLM internal
 * jargon that should never appear in client-facing copy.
 */

export const FORBIDDEN = [
  "mission",
  "claim",
  "dev boards",
  "token",
  "gpt",
  "claude",
] as const;

/**
 * Check whether *text* leaks any forbidden jargon word (case-insensitive,
 * whole-word match where practical).
 */
export function leaksJargon(text: string): boolean {
  const lower = text.toLowerCase();
  for ( const word of FORBIDDEN) {
    if (lower.includes(word)) return true;
  }
  return false;
}
