/**
 * BeeZilla — Heartbeat cadence tests (issue 93 / 9812).
 *
 * Tests:
 * 1. No heartbeat → now (0 ms)
 * 2. < 15 s → soon (wait ~15 s)
 * 3. 15–30 s → soon (wait ~30 s)
 * 4. 30–60 s → soon (wait ~60 s)
 * 5. Exactly at interval → due (0 ms)
 * 6. Just past interval → due (0 ms)
 * 7. Way past interval → missed (0 ms)
 * 8. Custom interval
 * 9. elapsedSec is correct
 */

import { describe, it, expect } from "vitest";
import { nextHeartbeat, type CadenceResult } from "./heartbeat-cadence.js";

describe("nextHeartbeat", () => {
  it("returns now when no heartbeat", () => {
    const result = nextHeartbeat(null, 1_000_000);
    expect(result.waitMs).toBe(0);
    expect(result.status).toBe("now");
    expect(result.elapsedSec).toBe(Infinity);
  });

  it("returns soon (< 15 s elapsed)", () => {
    const result = nextHeartbeat(990_000, 1_000_000); // 10 s ago
    expect(result.status).toBe("soon");
    expect(result.waitMs).toBeGreaterThan(0);
    expect(result.waitMs).toBeLessThanOrEqual(15_000);
    expect(result.elapsedSec).toBeCloseTo(10, 1);
  });

  it("returns soon (15–30 s elapsed)", () => {
    const result = nextHeartbeat(970_000, 1_000_000); // 30 s ago
    expect(result.status).toBe("soon");
    expect(result.waitMs).toBeGreaterThan(0);
    expect(result.waitMs).toBeLessThanOrEqual(30_000);
    expect(result.elapsedSec).toBeCloseTo(30, 1);
  });

  it("returns soon (30–60 s elapsed)", () => {
    const result = nextHeartbeat(945_000, 1_000_000); // 55 s ago
    expect(result.status).toBe("soon");
    expect(result.waitMs).toBeGreaterThan(0);
    expect(result.waitMs).toBeLessThanOrEqual(60_000);
    expect(result.elapsedSec).toBeCloseTo(55, 1);
  });

  it("returns due at exactly 60 s", () => {
    const result = nextHeartbeat(940_000, 1_000_000); // exactly 60 s
    expect(result.status).toBe("due");
    expect(result.waitMs).toBe(0);
  });

  it("returns due just past interval", () => {
    const result = nextHeartbeat(939_999, 1_000_000); // 60.001 s
    expect(result.status).toBe("due");
    expect(result.waitMs).toBe(0);
  });

  it("returns missed when way past interval", () => {
    const result = nextHeartbeat(800_000, 1_000_000); // 200 s ago
    expect(result.status).toBe("missed");
    expect(result.waitMs).toBe(0);
    expect(result.elapsedSec).toBeCloseTo(200, 1);
  });

  it("uses custom interval", () => {
    const now = 1_000_000;
    const result = nextHeartbeat(970_000, now, 90_000); // 30 s ago, 90 s interval
    expect(result.status).toBe("soon");
    expect(result.waitMs).toBeGreaterThan(0);
    expect(result.waitMs).toBeLessThanOrEqual(90_000);
    expect(result.elapsedSec).toBeCloseTo(30, 1);
  });

  it("returns due at custom interval boundary", () => {
    const now = 1_000_000;
    const result = nextHeartbeat(910_000, now, 90_000); // exactly 90 s
    expect(result.status).toBe("due");
    expect(result.waitMs).toBe(0);
  });

  it("returns missed past custom interval", () => {
    const now = 1_000_000;
    const result = nextHeartbeat(800_000, now, 90_000); // 200 s ago, 90 s interval
    expect(result.status).toBe("missed");
    expect(result.waitMs).toBe(0);
  });

  it("elapsedSec is always correct", () => {
    const last = 900_000;
    const now = 1_000_000;
    const result = nextHeartbeat(last, now);
    expect(result.elapsedSec).toBeCloseTo((now - last) / 1000, 1);
  });
});
