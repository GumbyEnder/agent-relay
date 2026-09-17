/**
 * BeeZilla — Pause configuration tests
 *
 * Verifies pause never creates work items and the empty-column label
 * is clean civilian copy.
 */

import { describe, it, expect } from "vitest";
import { pauseCreatesMissions, emptyColumnLabel } from "./pause.js";
import { leaksJargon } from "../copy/jargon.js";

// ===========================================================================
// TEST 1: pauseCreatesMissions
// ===========================================================================

describe("pauseCreatesMissions", () => {
  it("returns false — pause never creates work-item missions", () => {
    expect(pauseCreatesMissions()).toBe(false);
  });
});

// ===========================================================================
// TEST 2: emptyColumnLabel
// ===========================================================================

describe("emptyColumnLabel", () => {
  it('returns "None"', () => {
    expect(emptyColumnLabel()).toBe("None");
  });

  it("does not leak any forbidden jargon", () => {
    expect(leaksJargon(emptyColumnLabel())).toBe(false);
  });
});
