import { describe, it, expect } from "vitest";
import { typicalRange, UNCONFIRMED } from "./honesty.js";

describe("typicalRange", () => {
  it("does not invent a number with fewer than two amounts", () => {
    expect(typicalRange([]).display).toBe(UNCONFIRMED);
    expect(typicalRange([{ amountUsd: 500 }]).display).toBe(UNCONFIRMED);
    expect(typicalRange([{ url: "https://example.com" }]).invented).toBe(false);
  });

  it("uses only provided amounts when two or more exist", () => {
    const r = typicalRange([
      { amountUsd: 400, url: "a" },
      { amountUsd: 1000, url: "b" },
    ]);
    expect(r.display).toBe("about $400–$1000");
    expect(r.invented).toBe(false);
  });
});
