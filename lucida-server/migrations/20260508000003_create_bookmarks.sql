-- Server-stored bookmarks for the saved-views feature. A bookmark
-- captures a `SavedView` record (camera, layouts, dataset settings…)
-- under a stable opaque id so a `#b=<id>` URL re-opens the same view
-- across sessions and users. See ADR-0015.
--
-- Schema: opaque UUID v4 PK; denormalized creator (email + display
-- name) snapshotted from the AuthPrincipal at create time; ISO-8601
-- created_at; `view_json` carrying the full SavedView as a serialized
-- blob. The view shape is owned by `lucida-core` and evolves by
-- `SavedView::v` version-bump; storing JSON keeps schema evolution out
-- of the migration system.
--
-- The dataset-overlap query ("show me bookmarks for any of these
-- dataset URLs") is the hot read path for the sidebar. URLs live in a
-- side table rather than embedded in the JSON blob via JSON1: works on
-- every SQLite build and turns the overlap query into a plain index
-- scan (idx_bookmark_datasets_url) instead of forcing a per-row JSON
-- parse. `bookmarks::store::tests` asserts via `EXPLAIN QUERY PLAN`
-- that the index is used.
--
-- Indexes:
-- * created_by — supports filter-by-creator and "list this user's
--   bookmarks".
-- * dataset_url on the side table — load-bearing for the any-overlap
--   SELECT.

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
