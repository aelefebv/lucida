-- Private per-user headless viewer state.
--
-- This is not presence. It persists a saved-view-shaped payload for a
-- user/profile inside one workspace so CLI and Python clients can keep a
-- current headless view across short-lived invocations.

CREATE TABLE workspace_viewer_profiles (
    workspace_id TEXT NOT NULL,
    user_email   TEXT NOT NULL,
    profile      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    seed_source  TEXT,
    view_json    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_email, profile),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_viewer_profiles_workspace_user
    ON workspace_viewer_profiles(workspace_id, user_email, updated_at DESC);
