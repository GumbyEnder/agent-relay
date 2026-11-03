/**
 * BeeZilla — Catalog guard tests.
 *
 * These tests enforce that the skill-pull catalog correctly excludes
 * github and railway for civilian document jobs (SOW, letter), and
 * that the SOW cost envelope carries the cost-driver flag.
 */

import { describe, it, expect } from "vitest";
import { pullForJob, type JobType } from "./pull.js";
import { sowEnvelope } from "./envelope.js";

// ---------------------------------------------------------------------------
// pullForJob — github / railway exclusions
// ---------------------------------------------------------------------------

const EXCLUDED_SKILLS = ["github", "railway"];

describe("pullForJob", () => {
  it.each(["sow" as const, "letter" as const])(
    "%s job must NOT include github or railway",
    (job) => {
      const skills = pullForJob(job);

      for (const excluded of EXCLUDED_SKILLS) {
        expect(
          skills,
          `${job} pulled ${excluded} but it should be excluded`,
        ).not.toContain(excluded);
      }
    },
  );

  it("website job MAY include github and railway", () => {
    const skills = pullForJob("website");

    // Website pulls the full catalog; at minimum it should not fail
    // and should return at least as many skills as the civilian path.
    const sowSkills = pullForJob("sow");
    expect(skills.length).toBeGreaterThanOrEqual(sowSkills.length);
  });

  it("returns a non-empty array for every job type", (job: JobType) => {
    for (const j of ["sow", "letter", "website"] as JobType[]) {
      const skills = pullForJob(j);
      expect(skills).toBeInstanceOf(Array);
      expect(skills.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// sowEnvelope — cost driver flag
// ---------------------------------------------------------------------------

describe("sowEnvelope", () => {
  it("verifyIsCostDriver must be true", () => {
    const envelope = sowEnvelope();
    expect(envelope.verifyIsCostDriver).toBe(true);
  });

  it("display is a non-empty string", () => {
    const envelope = sowEnvelope();
    expect(typeof envelope.display).toBe("string");
    expect(envelope.display.length).toBeGreaterThan(0);
  });
});
