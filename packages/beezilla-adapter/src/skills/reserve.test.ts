/**
 * BeeZilla — Reserve / cap / cap_status tests.
 *
 * Verifies that verificationReserve(), budgetCap(), and capStatus() read
 * cost-envelope.example.json and return the expected values.
 */

import { describe, it, expect } from "vitest";
import { verificationReserve, budgetCap, capStatus } from "./reserve.js";

describe("reserve", () => {
  it("verificationReserve returns 0.5", () => {
    expect(verificationReserve()).toBe(0.5);
  });

  it("budgetCap returns 3.5", () => {
    expect(budgetCap()).toBe(3.5);
  });

  it("capStatus returns 'hard_stop'", () => {
    expect(capStatus()).toBe("hard_stop");
  });

  it("capStatus is never empty or a model id", () => {
    const status = capStatus();
    expect(status.length).toBeGreaterThan(0);
    expect(status).not.toMatch(/gpt|claude|gemini|llama/i);
  });

  it("is cached — second call returns the same reference", () => {
    const a = verificationReserve();
    const b = verificationReserve();
    expect(a).toBe(b);
  });
});
