/**
 * BeeZilla — Heartbeat cadence helper (issue 93 / 9812).
 *
 * Pure function: given a mission's last heartbeat timestamp and
 * the current time, returns the next time a heartbeat should be
 * sent. No live API calls.
 *
 * Cadence policy:
 *   - No heartbeat yet (null) or > 60 s ago → send now (0 ms)
 *   - 0–15 s since last → wait 15 s
 *   - 15–30 s → wait 30 s
 *   - 30–60 s → wait 60 s
 *   - > 60 s → send now (0 ms, missed)
 */

export interface CadenceResult {
  /** Milliseconds to wait before next heartbeat (0 = send now) */
  waitMs: number;
  /** Human-readable status */
  status: "now" | "soon" | "due" | "missed";
  /** Seconds since last heartbeat (Infinity if none) */
  elapsedSec: number;
}

const DEFAULT_INTERVAL_MS = 60_000; // 60 seconds
const BUCKETS: [number, number][] = [
  [0, 15_000],
  [15_000, 30_000],
  [30_000, 60_000],
];

/**
 * Compute when the next heartbeat should fire.
 *
 * @param lastHeartbeatMs — timestamp of last heartbeat (epoch ms), or null
 * @param nowMs — current time (epoch ms), defaults to Date.now()
 * @param intervalMs — heartbeat interval in ms (default 60 000)
 * @returns CadenceResult with waitMs, status, elapsedSec
 */
export function nextHeartbeat(
  lastHeartbeatMs: number | null,
  nowMs?: number,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): CadenceResult {
  const now = nowMs ?? Date.now();

  if (lastHeartbeatMs == null) {
    return { waitMs: 0, status: "now", elapsedSec: Infinity };
  }

  const elapsed = now - lastHeartbeatMs;

  // Overdue — send immediately
  if (elapsed >= intervalMs) {
    return { waitMs: 0, status: elapsed > intervalMs * 2 ? "missed" : "due", elapsedSec: elapsed / 1000 };
  }

  // Find the right bucket
  let waitMs = intervalMs - elapsed;
  let status: CadenceResult["status"] = "soon";

  for (const [min, max] of BUCKETS) {
    if (elapsed >= min && elapsed < max) {
      // Bucket says wait a shorter interval
      waitMs = max - elapsed;
      status = "soon";
      break;
    }
  }

  return { waitMs, status, elapsedSec: elapsed / 1000 };
}
