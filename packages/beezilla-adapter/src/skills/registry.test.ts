/**
 * BeeZilla — Registry tests.
 *
 * Verifies listSkills() returns {id, civilian_name} entries from the
 * catalog and that twoPasses() returns the expected pull order.
 */

import { describe, it, expect } from "vitest";
import { listSkills, twoPasses } from "./registry.js";

describe("listSkills", () => {
  it("returns an array of {id, civilian_name}", () => {
    const skills = listSkills();

    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);

    for (const entry of skills) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("civilian_name");
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.civilian_name).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.civilian_name.length).toBeGreaterThan(0);
    }
  });

  it("contains 'interview' and 'draft'-related skills", () => {
    const skills = listSkills();
    const ids = skills.map((s) => s.id);

    expect(ids).toContain("interview");
    // doc-draft is the draft skill
    expect(ids).toContain("doc-draft");
  });

  it("no model ids appear in civilian_name", () => {
    const skills = listSkills();

    for (const entry of skills) {
      expect(entry.civilian_name).not.toMatch(/gpt|claude|gemini|llama|model/i);
    }
  });

  it("is cached — second call returns the same reference", () => {
    const a = listSkills();
    const b = listSkills();
    expect(a).toBe(b);
  });

  it("returns exactly 8 skills from catalog-v0.json", () => {
    const skills = listSkills();
    expect(skills.length).toBe(8);
  });
});

describe("twoPasses", () => {
  it('returns ["interview", "draft"]', () => {
    const passes = twoPasses();
    expect(passes).toEqual(["interview", "draft"]);
  });

  it("returns a new array each call (not a shared reference)", () => {
    const a = twoPasses();
    const b = twoPasses();
    expect(a).not.toBe(b);
  });
});
