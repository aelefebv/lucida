-- Set the bookmark tables aside, for PostgreSQL: the SQLite migration beside
-- this one translated. Read that file for why the rows are archived rather
-- than converted or dropped.
ALTER TABLE bookmarks RENAME TO archived_bookmarks;
ALTER TABLE bookmark_datasets RENAME TO archived_bookmark_datasets;
