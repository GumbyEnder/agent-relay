/**
 * BeeZilla — getSkill tests.
 *
 * Verifies that all civilian skills exist in the catalog with
 * dana_sow=true, nonempty civilian_name, and no github/railway in their ids.
 */

import { describe, it, expect } from "vitest";
import { getSkill } from "./defs.js";

describe("getSkill", () => {
  const allSkills = [
    "interview",
    "doc-draft",
    "plain-language",
    "research",
    "rates-research",
    "source-verify",
    "fairness-review",
    "doc-format",
  ];

  for (const id of allSkills) {
    it(`returns {id, civilian_name, dana_sow} for "${id}"`, () => {
      const skill = getSkill(id);
      expect(skill).toBeDefined();
      expect(skill).not.toBeUndefined();
    });

    it(`"${id}" has dana_sow=true`, () => {
      const skill = getSkill(id);
      expect(skill?.dana_sow).toBe(true);
    });

    it(`"${id}" has nonempty civilian_name`, () => {
      const skill = getSkill(id);
      expect(skill?.civilian_name).toBeDefined();
      expect(typeof skill?.civilian_name).toBe("string");
      expect(skill?.civilian_name!.length).toBeGreaterThan(0);
    });

    it(`"${id}" id does not contain "github"`, () => {
      const skill = getSkill(id);
      expect(skill?.id).not.toContain("github");
    });

    it(`"${id}" id does not contain "railway"`, () => {
      const skill = getSkill(id);
      expect(skill?.id).not.toContain("railway");
    });
  }
});
