import { describe, it, expect } from "vitest";
import { leaksJargon, FORBIDDEN } from "./jargon.js";

describe("leaksJargon", () => {
  it("detects every forbidden word", () => {
    for (const word of FORBIDDEN) {
      expect(leaksJargon(`This is about the ${word}`)).toBe(true);
    }
  });

  it("returns false for clean copy", () => {
    expect(leaksJargon("Working on it")).toBe(false);
    expect(leaksJargon("Starting the task")).toBe(false);
    expect(leaksJargon("Ready for you")).toBe(false);
  });

  it("leaks when 'claim the mission' appears", () => {
    expect(leaksJargon("claim the mission")).toBe(true);
  });

  it("case-insensitive", () => {
    expect(leaksJargon("Mission accomplished")).toBe(true);
    expect(leaksJargon("MISSION accomplished")).toBe(true);
    expect(leaksJargon("mIsSiOn done")).toBe(true);
  });

  it("catches multi-word phrases", () => {
    expect(leaksJargon("dev boards are great")).toBe(true);
    expect(leaksJargon("DEV BOARDS")).toBe(true);
  });

  it("catches LLM brand names", () => {
    expect(leaksJargon("used gpt-4 to analyze")).toBe(true);
    expect(leaksJargon("asked claude for help")).toBe(true);
  });
});
