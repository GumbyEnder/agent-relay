import { describe, it, expect } from "vitest";
import { emptyCard, forgetFact, forgetEverything, addJobSummary } from "./card.js";

describe("BeeZilla LTM card", () => {
  it("starts empty except not-stored list", () => {
    const c = emptyCard("dana");
    expect(c.facts).toEqual([]);
    expect(c.jobs).toEqual([]);
    expect(c.notStored.length).toBeGreaterThan(0);
  });

  it("forget this / forget everything", () => {
    let c = emptyCard("dana");
    c = { ...c, facts: [{ id: "f1", text: "Likes short paperwork" }] };
    c = forgetFact(c, "f1");
    expect(c.facts).toEqual([]);
    c = addJobSummary(c, "Fence SOW for quotes");
    c = forgetEverything(c);
    expect(c.facts).toEqual([]);
    expect(c.jobs).toEqual([]);
    expect(c.clientId).toBe("dana");
  });
});
