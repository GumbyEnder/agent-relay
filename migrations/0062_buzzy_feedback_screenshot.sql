-- 0062 — a screenshot on a feedback report.
--
-- 0059 built buzzy_feedback around a written report plus a consented diagnostic
-- snapshot. The tester kit adds the other half of a bug report: what the person
-- was looking at. It is stored as a data URL in the same row rather than in blob
-- storage because the whole point is that one admin read of one row reproduces
-- the report; a separate object store would add a second thing that can be
-- missing.
--
-- Nullable, and it stays that way: most reports have no picture, and the read
-- path treats NULL as "nothing to show" rather than an error. Size and type are
-- enforced at the door (SCREENSHOT_MAX, DATA_URL in feedback.ts) and again here
-- by the CHECK, so a bad value cannot arrive by any other route.
ALTER TABLE buzzy_feedback
  ADD COLUMN IF NOT EXISTS screenshot TEXT;

ALTER TABLE buzzy_feedback
  DROP CONSTRAINT IF EXISTS buzzy_feedback_screenshot_size;

ALTER TABLE buzzy_feedback
  ADD CONSTRAINT buzzy_feedback_screenshot_size
  CHECK (screenshot IS NULL OR char_length(screenshot) <= 1500000);
