import { describe, it, expect } from "vitest";
import { createJob, listJobs, completeJob, JOB_TEMPLATES } from "./catalog.js";

describe("job catalog", () => {
  it("creates a legal job for one user", () => {
    const j = createJob("bz_a", { template: "legal", problem: "Need a demand letter" });
    expect(j.userId).toBe("bz_a");
    expect(j.template).toBe("legal");
    expect(j.completedAt).toBeNull();
    expect(JOB_TEMPLATES).toContain("legal");
  });

  it("lists only that user's jobs", () => {
    const a = createJob("u1", { problem: "A" });
    const b = createJob("u2", { problem: "B" });
    const list = listJobs([a, b], "u1");
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(a.id);
  });

  it("hideCompleted filters finished jobs", () => {
    const open = createJob("u1", { problem: "open" });
    const done = completeJob(createJob("u1", { problem: "done" }));
    expect(listJobs([open, done], "u1", { hideCompleted: true })).toEqual([open]);
    expect(listJobs([open, done], "u1", { hideCompleted: false })).toHaveLength(2);
  });
});
