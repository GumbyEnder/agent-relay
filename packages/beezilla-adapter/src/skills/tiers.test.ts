/**
 * BeeZilla — Tier breakdown tests.
 *
 * Verifies tierBreakdown() returns civilian strings containing "about"
 * or "pennies", never model ids.
 */

import { describe, it, expect } from "vitest";
import { tierBreakdown } from "./tiers.js";

describe("tierBreakdown", () => {
  it("returns a Record<string,string>", () => {
    const breakdown = tierBreakdown();

    expect(typeof breakdown).toBe("object");
    expect(breakdown).not.toBeNull();

    for (const [key, value] of Object.entries(breakdown)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(key.length).toBeGreaterThan(0);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("every value contains 'about' or 'pennies'", () => {
    const breakdown = tierBreakdown();

    for (const [tier, value] of Object.entries(breakdown)) {
      const hasAbout = value.toLowerCase().includes("about");
      const hasPennies = value.toLowerCase().includes("pennies");
      expect(
        hasAbout || hasPennies,
        `${tier} value "${value}" has neither "about" nor "pennies"`,
      ).toBe(true);
    }
  });

  it("no model ids appear in any value", () => {
    const breakdown = tierBreakdown();

    for (const [tier, value] of Object.entries(breakdown)) {
      expect(
        value,
        `${tier} value "${value}" contains a model id`,
      ).not.toMatch(/gpt|claude|gemini|llama|model/i);
    }
  });

  it("contains the expected tiers", () => {
    const breakdown = tierBreakdown();
    const tiers = Object.keys(breakdown);

    expect(tiers).toContain("interview");
    expect(tiers).toContain("formatting_on_approval");
  });

  it("is cached — second call returns the same reference", () => {
    const a = tierBreakdown();
    const b = tierBreakdown();
    expect(a).toBe(b);
  });
});
