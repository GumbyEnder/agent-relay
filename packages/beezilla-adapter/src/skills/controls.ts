/**
 * BeeZilla — Skill controls: default value and budget-cap hard stop.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlValue = string;
export type CapResult = "ok" | "stop";

// ---------------------------------------------------------------------------
// defaultControl
// ---------------------------------------------------------------------------

/**
 * Return the default control value.
 *
 * Civilians never see model ids; this is the safe default.
 */
export function defaultControl(): ControlValue {
  return "value";
}

// ---------------------------------------------------------------------------
// capHardStop
// ---------------------------------------------------------------------------

/**
 * Compare spent against a cap.
 *
 * Returns "ok" when spent < cap, "stop" when spent >= cap.
 */
export function capHardStop(spent: number, cap: number): CapResult {
  if (spent >= cap) return "stop";
  return "ok";
}
