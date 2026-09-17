import { describe, it, expect } from "vitest";
import {
  BEEZILLA_HONCHO_WORKSPACE,
  factAllowed,
  isForbiddenHonchoText,
} from "./honcho.js";

describe("Honcho LTM map", () => {
  it("uses a workspace separate from Frodo", () => {
    expect(BEEZILLA_HONCHO_WORKSPACE).toBe("beezilla-clients");
    expect(BEEZILLA_HONCHO_WORKSPACE).not.toMatch(/frodo/i);
  });

  it("rejects wallet and model ids", () => {
    expect(isForbiddenHonchoText("wallet balance $12")).toBe(true);
    expect(isForbiddenHonchoText("model_id gpt-4")).toBe(true);
    expect(factAllowed("Prefers morning visits")).toBe(true);
  });
});
