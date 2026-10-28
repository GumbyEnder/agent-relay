import { describe, it, expect } from "vitest";
import { fairnessNotes, escalateOnce } from "./review.js";

describe("fairnessNotes", () => {
  it("returns 2–3 bullets for a jargon-heavy SOW", () => {
    const notes = fairnessNotes(
      "We will leverage synergistic paradigms to deliver cutting-edge solutions."
    );
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.length).toBeLessThanOrEqual(3);
  });

  it("returns 2–3 bullets for a clean SOW", () => {
    const notes = fairnessNotes(
      "We will build a website for your bakery. The project costs $3000 and takes 4 weeks."
    );
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.length).toBeLessThanOrEqual(3);
  });

  it("always returns a non-empty array", () => {
    const notes = fairnessNotes("");
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.length).toBeLessThanOrEqual(3);
  });
});

describe("escalateOnce", () => {
  it("returns retry when fails === 1", () => {
    expect(escalateOnce(1)).toBe("retry");
  });

  it("returns pause when fails === 2", () => {
    expect(escalateOnce(2)).toBe("pause");
  });

  it("returns pause when fails > 2", () => {
    expect(escalateOnce(5)).toBe("pause");
  });
});
