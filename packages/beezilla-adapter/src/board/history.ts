/**
 * BeeZilla — Board history helpers (civilian-facing)
 *
 * Pure functions that turn Dev Boards column transitions into plain-language
 * progress notes.  No Dev Boards jargon ("mission", "claim", etc.) ever leaks
 * into civilian-facing output.
 *
 * Draft-holder missions stay in inbox — they are not moved through the board.
 * (see src/draft/store.ts)
 */

import type { DevBoardColumn } from "../adapter/types.js";

// ---------------------------------------------------------------------------
// civilianProgress — map column transitions to civilian language
// ---------------------------------------------------------------------------

/**
 * Return a one-line civilian progress note for a column transition.
 *
 * Uses everyday shop-floor language:
 *   - ready → running      => "Starting work"
 *   - running → review     => "Working on it"
 *   - running → done       => "Ready for you"
 *   - running → needs_human => "Needs your input"
 *   - blocked → running    => "Unblocked"
 *   - needs_human → running => "Back to work"
 *   - inbox → ready        => "Ready to start"
 *   - anything → blocked   => "Blocked"
 *
 * Unknown transitions fall back to "In progress".
 */
export function civilianProgress(
  fromColumn: DevBoardColumn,
  toColumn: DevBoardColumn,
): string {
  const key = `${fromColumn}→${toColumn}`;

  switch (key) {
    case "inbox→ready":
      return "Ready to start";
    case "ready→running":
      return "Starting work";
    case "running→review":
      return "Working on it";
    case "running→done":
      return "Ready for you";
    case "running→needs_human":
      return "Needs your input";
    case "needs_human→running":
      return "Back to work";
    case "blocked→running":
      return "Unblocked";
    case "ready→needs_human":
      return "Needs your input";
    case "running→blocked":
      return "Blocked";
    case "review→done":
      return "Completed";
    case "inbox→running":
      return "Starting work";
    default:
      return "In progress";
  }
}
