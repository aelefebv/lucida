-- Slice 2 of PRD #454 (issue #475): the third table in lucida.db.
--
-- Server-stored bookmarks for the saved-views feature. A bookmark
-- captures a `SavedView` record (camera, layouts, dataset settings…)
-- under a stable opaque id so a `#b=<id>` URL can re-open the same
-- view across sessions and across users.
--
-- Schema decisions live in PRD #454 §"Bookmark schema" and ADR-0015
-- (`wiki/decisions/0015-server-stored-bookmarks-and-auth-seam.md`).
-- Short version: opaque UUID v4 PK, denormalized creator
-- (email + display name) snapshotted from the AuthPrincipal at create
-- time, ISO-8601 created_at, and `view_json` carrying the full SavedView
-- as a serialized blob. The view shape is owned by `lucida-core` and
-- evolves by `SavedView::v` version-bump; storing JSON keeps schema
-- evolution out of the migration system.
--
-- The dataset-overlap query ("show me bookmarks for any of these dataset
-- URLs") is the hot read path for the sidebar. We keep the URLs in a
-- side table rather than embedding them in the JSON blob and using the
-- JSON1 extension; the side table approach works on every SQLite build
-- and turns the overlap query into a plain index scan
-- (idx_bookmark_datasets_url) instead of forcing a per-row JSON parse.
-- The server-level test in `bookmarks::store::tests` asserts via
-- `EXPLAIN QUERY PLAN` that the index is used.
--
-- Indexes:
-- * created_by — supports filter-by-creator ("Mine only" toggle in the
--   slice 3 sidebar) and any future "list this user's bookmarks" path.
-- * dataset_url on the side table — the load-bearing index for the
--   any-overlap SELECT.

CREATE TABLE bookmarks (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    view_json       TEXT NOT NULL
);

CREATE INDEX idx_bookmarks_created_by ON bookmarks(created_by);

CREATE TABLE bookmark_datasets (
    bookmark_id TEXT NOT NULL,
    dataset_url TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, dataset_url),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE
);

CREATE INDEX idx_bookmark_datasets_url ON bookmark_datasets(dataset_url);
