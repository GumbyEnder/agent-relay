/**
 * BeeZilla — getSkill tests.
 *
 * Verifies that the three core civilian skills (interview, doc-draft,
 * plain-language) exist in the catalog with dana_sow=true, nonempty
 * civilian_name, and no github in their ids.
 */

import { describe, it, expect } from "vitest";
import { getSkill } from "./defs.js";

describe("getSkill", () => {
  const requiredSkills = ["interview", "doc-draft", "plain-language"];

  for (const id of requiredSkills) {
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
  }
});
