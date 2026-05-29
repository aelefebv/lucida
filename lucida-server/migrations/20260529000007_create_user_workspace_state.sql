-- Personal per-user workspace dashboard state.
--
-- Sharing/membership determines access. This table only records the
-- current user's dashboard affordances: recents and personal pins.

CREATE TABLE user_workspace_state (
    user_email     TEXT NOT NULL,
    workspace_id   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_opened_at TEXT,
    pinned_at      TEXT,
    PRIMARY KEY (user_email, workspace_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_workspace_state_user_recent
    ON user_workspace_state(user_email, pinned_at, last_opened_at);
CREATE INDEX idx_user_workspace_state_workspace
    ON user_workspace_state(workspace_id);
