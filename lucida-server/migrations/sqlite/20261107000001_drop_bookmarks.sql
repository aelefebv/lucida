-- Drop the bookmark tables. Workspace saved views hold saved views now.
--
-- A bookmark row names dataset URLs and no workspace, and a workspace saved
-- view must belong to exactly one workspace, so no row converts without a
-- guess about where it belongs. The rows are dropped instead. The server
-- counts them before this runs and logs the count as
-- `storage.migrate.bookmarks_dropped`.
--
-- The side table goes first: it references the other.
DROP TABLE bookmark_datasets;
DROP TABLE bookmarks;
