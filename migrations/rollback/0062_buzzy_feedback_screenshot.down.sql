-- Rollback for 0062: the picture goes, the report stays.
ALTER TABLE buzzy_feedback
  DROP CONSTRAINT IF EXISTS buzzy_feedback_screenshot_size;

ALTER TABLE buzzy_feedback
  DROP COLUMN IF EXISTS screenshot;
