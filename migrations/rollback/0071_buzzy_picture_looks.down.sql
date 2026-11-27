-- Rolls back 0071: the kept descriptions go; pictures are looked at afresh on each turn.
DROP INDEX IF EXISTS buzzy_picture_looks_user;
DROP TABLE IF EXISTS buzzy_picture_looks;
