-- Rollback of 0060: whiteboards are no longer kept in the account.
-- Each browser still has its own copy (localStorage "bz.board.<id>"), so the Talk page
-- keeps working from those; boards drawn only on another computer are gone.
DROP TABLE IF EXISTS buzzy_whiteboard_versions;
DROP TABLE IF EXISTS buzzy_whiteboards;
