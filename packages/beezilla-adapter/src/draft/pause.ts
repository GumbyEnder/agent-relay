/**
 * BeeZilla — Pause configuration
 *
 * When pause mode is active the system must not create any work items,
 * and the empty-column label must not contain forbidden jargon.
 */

/**
 * Returns true if the pause subsystem creates work-item missions.
 * Always false — pause means no new work.
 */
export function pauseCreatesMissions(): boolean {
  return false;
}

/**
 * Returns the label shown for an empty column while paused.
 * Must not contain any forbidden jargon words.
 */
export function emptyColumnLabel(): string {
  return "None";
}
