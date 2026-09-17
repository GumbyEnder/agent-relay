import { describe, it, expect } from "vitest";
import { sanitizeForHoncho } from "./payload.js";
import { BEEZILLA_HONCHO_WORKSPACE } from "./honcho.js";
import { emptyCard } from "./card.js";

describe("sanitizeForHoncho", () => {
  it("strips wallet facts", () => {
    const card = emptyCard("client-1");
    card.facts = [
      { id: "f1", text: "wallet balance is $500" },
      { id: "f2", text: "Prefers morning visits" },
    ];
    card.jobs = [];

    const result = sanitizeForHoncho(card);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].text).toBe("Prefers morning visits");
  });

  it("keeps clean facts", () => {
    const card = emptyCard("client-2");
    card.facts = [
      { id: "f1", text: "Prefers morning visits" },
      { id: "f2", text: "Allergic to bees" },
    ];
    card.jobs = [];

    const result = sanitizeForHoncho(card);

    expect(result.facts).toHaveLength(2);
    expect(result.facts.map((f) => f.text)).toEqual([
      "Prefers morning visits",
      "Allergic to bees",
    ]);
  });

  it("workspace !== frodo", () => {
    const card = emptyCard("client-3");
    const result = sanitizeForHoncho(card);

    expect(result.workspace).toBe(BEEZILLA_HONCHO_WORKSPACE);
    expect(result.workspace).not.toMatch(/frodo/i);
  });
});
