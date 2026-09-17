import { describe, it, expect } from "vitest";
import { sanitizeForHoncho } from "./payload.js";
import { BEEZILLA_HONCHO_WORKSPACE } from "./honcho.js";
import { emptyCard } from "./card.js";

describe("sanitizeForHoncho", () => {
  it("strips wallet facts", () => {
    const card = emptyCard("c1");
    card.facts = [
      { id: "1", text: "wallet balance $500" },
      { id: "2", text: "Prefers morning visits" },
    ];
    card.jobs = [{ id: "j1", oneLiner: "clean job text", finishedAt: "2025-01-01" }];
    const result = sanitizeForHoncho(card);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].text).toBe("Prefers morning visits");
  });

  it("keeps clean facts", () => {
    const card = emptyCard("c2");
    card.facts = [
      { id: "1", text: "Prefers morning visits" },
      { id: "2", text: "Allergic to bees" },
    ];
    card.jobs = [];
    const result = sanitizeForHoncho(card);
    expect(result.facts).toHaveLength(2);
  });

  it("workspace is not frodo", () => {
    const card = emptyCard("c3");
    const result = sanitizeForHoncho(card);
    expect(result.workspace).not.toMatch(/frodo/i);
    expect(result.workspace).toBe(BEEZILLA_HONCHO_WORKSPACE);
  });
});
