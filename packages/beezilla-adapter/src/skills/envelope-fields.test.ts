/**
 * BeeZilla — Envelope fields tests.
 *
 * Verifies that envelopeFields() reads the example JSON and returns the
 * expected civilian-facing shape: display starts with "about $", no model
 * ids are exposed.
 */

import { describe, it, expect } from "vitest";
import { envelopeFields } from "./envelope-fields.js";

describe("envelopeFields", () => {
  it("returns estimate_low and estimate_high from the example JSON", () => {
    const fields = envelopeFields();
    expect(fields.estimate_low).toBe(1.0);
    expect(fields.estimate_high).toBe(3.0);
  });

  it("display starts with 'about $'", () => {
    const fields = envelopeFields();
    expect(fields.display.startsWith("about $")).toBe(true);
  });

  it("noModelIds is true — civilians never see model ids", () => {
    const fields = envelopeFields();
    expect(fields.noModelIds).toBe(true);
  });

  it("display is not a JSON string or model id list", () => {
    const fields = envelopeFields();
    expect(fields.display.startsWith("{")).toBe(false);
    expect(fields.display.startsWith("[")).toBe(false);
    expect(fields.display).not.toMatch(/gpt|claude|gemini|llama/i);
  });

  it("is cached — second call returns the same reference", () => {
    const a = envelopeFields();
    const b = envelopeFields();
    expect(a).toBe(b);
  });
});
