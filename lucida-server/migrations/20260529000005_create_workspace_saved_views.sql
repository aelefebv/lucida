-- Workspace-scoped saved views.
--
-- Unlike global bookmarks, these belong to exactly one workspace and store
-- workspace-local dataset ids in the SavedView payload. Source URLs are
-- intentionally not indexed here; the workspace dataset table owns source
-- identity.

CREATE TABLE workspace_saved_views (
    id              TEXT PRIMARY KEY NOT NULL,
    workspace_id    TEXT NOT NULL,
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    view_json       TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_saved_views_workspace_updated
    ON workspace_saved_views(workspace_id, updated_at DESC);

