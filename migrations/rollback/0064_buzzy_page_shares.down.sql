-- Rolls back 0064: every page link stops working and the copies go with the table.
DROP INDEX IF EXISTS buzzy_page_shares_live;
DROP INDEX IF EXISTS buzzy_page_shares_user;
DROP TABLE IF EXISTS buzzy_page_shares;
