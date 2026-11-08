-- Set the bookmark tables aside. Workspace saved views hold saved views now,
-- and no code reads or writes these tables any more.
--
-- They are renamed rather than dropped, so the rows survive. A bookmark row
-- names dataset URLs and no workspace, and a workspace saved view must
-- belong to exactly one workspace, so converting them takes a decision about
-- where each one belongs. A later change can convert the archived rows or
-- drop the tables. The server counts the rows before this runs and logs the
-- count as `storage.migrate.bookmarks_archived`.
--
-- SQLite rewrites the child table's foreign key to follow the renamed
-- parent, and the indexes move with their tables.
ALTER TABLE bookmarks RENAME TO archived_bookmarks;
ALTER TABLE bookmark_datasets RENAME TO archived_bookmark_datasets;
