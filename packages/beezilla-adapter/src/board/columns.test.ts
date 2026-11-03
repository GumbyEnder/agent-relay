import { describe, it, expect } from "vitest";
import { SHOP_TO_CIVILIAN, CIVILIAN_COLUMNS } from "./columns.js";

describe("civilian board columns", () => {
  it("has exactly four civilian columns", () => {
    expect(CIVILIAN_COLUMNS).toEqual([
      "Waiting",
      "Working",
      "Needs you",
      "Done",
    ]);
  });

  it("maps shop floor without exposing inbox/ready/running", () => {
    expect(SHOP_TO_CIVILIAN.inbox).toBe("Waiting");
    expect(SHOP_TO_CIVILIAN.ready).toBe("Waiting");
    expect(SHOP_TO_CIVILIAN.running).toBe("Working");
    expect(SHOP_TO_CIVILIAN.needs_human).toBe("Needs you");
    expect(SHOP_TO_CIVILIAN.review).toBe("Done");
  });
});
