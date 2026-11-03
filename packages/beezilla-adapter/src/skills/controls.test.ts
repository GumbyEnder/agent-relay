/**
 * BeeZilla — Controls tests.
 *
 * Verifies defaultControl() returns "value" and capHardStop() enforces
 * the spent >= cap boundary correctly.
 */

import { describe, it, expect } from "vitest";
import { defaultControl, capHardStop } from "./controls.js";

describe("defaultControl", () => {
  it('returns "value"', () => {
    expect(defaultControl()).toBe("value");
  });
});

describe("capHardStop", () => {
  it("spent 3.0 vs cap 3.5 → ok", () => {
    expect(capHardStop(3.0, 3.5)).toBe("ok");
  });

  it("spent 3.5 vs cap 3.5 → stop", () => {
    expect(capHardStop(3.5, 3.5)).toBe("stop");
  });

  it("spent 4 vs cap 3.5 → stop", () => {
    expect(capHardStop(4, 3.5)).toBe("stop");
  });
});
