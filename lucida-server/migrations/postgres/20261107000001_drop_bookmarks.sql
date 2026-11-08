-- Drop the bookmark tables for PostgreSQL: the SQLite migration beside this
-- one translated. Read that file for why the rows are dropped rather than
-- converted.
DROP TABLE bookmark_datasets;
DROP TABLE bookmarks;
