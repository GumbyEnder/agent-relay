import { describe, it, expect } from "vitest";
import { civilianProgress } from "./history.js";

describe("civilianProgress", () => {
  it("maps ready→running to 'Starting work'", () => {
    expect(civilianProgress("ready", "running")).toBe("Starting work");
  });

  it("maps running→review to 'Working on it'", () => {
    expect(civilianProgress("running", "review")).toBe("Working on it");
  });

  it("maps running→done to 'Ready for you'", () => {
    expect(civilianProgress("running", "done")).toBe("Ready for you");
  });

  it("maps running→needs_human to 'Needs your input'", () => {
    expect(civilianProgress("running", "needs_human")).toBe("Needs your input");
  });

  it("maps needs_human→running to 'Back to work'", () => {
    expect(civilianProgress("needs_human", "running")).toBe("Back to work");
  });

  it("maps blocked→running to 'Unblocked'", () => {
    expect(civilianProgress("blocked", "running")).toBe("Unblocked");
  });

  it("maps ready→needs_human to 'Needs your input'", () => {
    expect(civilianProgress("ready", "needs_human")).toBe("Needs your input");
  });

  it("maps running→blocked to 'Blocked'", () => {
    expect(civilianProgress("running", "blocked")).toBe("Blocked");
  });

  it("maps review→done to 'Completed'", () => {
    expect(civilianProgress("review", "done")).toBe("Completed");
  });

  it("maps inbox→running to 'Starting work'", () => {
    expect(civilianProgress("inbox", "running")).toBe("Starting work");
  });

  it("maps inbox→ready to 'Ready to start'", () => {
    expect(civilianProgress("inbox", "ready")).toBe("Ready to start");
  });

  it("falls back to 'In progress' for unknown transitions", () => {
    expect(civilianProgress("done", "inbox")).toBe("In progress");
    expect(civilianProgress("blocked", "review")).toBe("In progress");
  });

  it("never uses 'mission' or 'claim' jargon", () => {
    const columns: Array<"inbox" | "ready" | "running" | "needs_human" | "review" | "done" | "blocked"> = [
      "inbox", "ready", "running", "needs_human", "review", "done", "blocked",
    ];
    for (const from of columns) {
      for (const to of columns) {
        const note = civilianProgress(from, to);
        expect(note.toLowerCase()).not.toContain("mission");
        expect(note.toLowerCase()).not.toContain("claim");
      }
    }
  });
});
