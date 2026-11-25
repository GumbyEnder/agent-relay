-- Rolls back 0073: a conversation reopened from History no longer knows the pictures
-- added to it (they stay in the Library).
DROP INDEX IF EXISTS buzzy_chat_pictures_session;
DROP TABLE IF EXISTS buzzy_chat_pictures;
