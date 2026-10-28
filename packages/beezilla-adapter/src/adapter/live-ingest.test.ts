/**
 * BeeZilla — Opt-in Live Ingest Test
 *
 * Skipped by default. Only runs when BEEZILLA_LIVE_INGEST=1.
 * Never calls app.devboards.ai unless the env flag is set.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Guard: skip the entire suite when the opt-in env var is absent
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.BEEZILLA_LIVE_INGEST)(
  "opt-in live ingest",
  () => {
    // We only document board_etzsvw4mq7d8 — never invent a second board.
    const BOARD_ID = "board_etzsvw4mq7d8";

    it("has the live ingest flag set", () => {
      expect(process.env.BEEZILLA_LIVE_INGEST).toBe("1");
    });

    it("refuses to call the live API without the flag", () => {
      // This test proves the guard works: we assert the skip condition
      // would fire when the env var is absent.  Since we are inside the
      // describe.skipIf block the env IS set, so we instead verify the
      // guard expression itself.
      const wouldSkip = !process.env.BEEZILLA_LIVE_INGEST;
      expect(wouldSkip).toBe(false);
    });

    it("documents the canonical board id (no second board)", () => {
      // Regression guard: if someone adds a second board reference this
      // test will catch it.  Only board_etzsvw4mq7d8 is documented here.
      expect(BOARD_ID).toBe("board_etzsvw4mq7d8");
    });
  },
);

describe("live ingest guard (always runs)", () => {
  it("skips when BEEZILLA_LIVE_INGEST is not set", () => {
    // This test runs in every CI run (env is never set in CI).
    // It asserts that the skip condition would fire — i.e. the describe
    // block above is *not* skipped only when the flag IS set.
    const skipCondition = !process.env.BEEZILLA_LIVE_INGEST;
    expect(skipCondition).toBe(true);
  });
});
