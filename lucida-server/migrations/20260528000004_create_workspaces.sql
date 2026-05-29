-- Durable workspace container for collaborative sessions.
--
-- Workspaces own the shared document snapshot and dataset membership.
-- Dataset source identity is split from workspace-local membership so
-- multiple workspaces can reuse the same import/cache/generated artifacts.

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    archived_at     TEXT,
    link_access     TEXT NOT NULL DEFAULT 'restricted',
    link_role       TEXT NOT NULL DEFAULT 'viewer',
    seq             INTEGER NOT NULL DEFAULT 0,
    document_json   TEXT NOT NULL
);

CREATE INDEX idx_workspaces_created_by ON workspaces(created_by);
CREATE INDEX idx_workspaces_updated_at ON workspaces(updated_at);
CREATE INDEX idx_workspaces_archived_at ON workspaces(archived_at);

CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL,
    email        TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
    display_name TEXT NOT NULL DEFAULT '',
    added_at     TEXT NOT NULL,
    PRIMARY KEY (workspace_id, email),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_members_email ON workspace_members(email);

CREATE TABLE dataset_sources (
    id            TEXT PRIMARY KEY NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE,
    default_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE workspace_datasets (
    id                TEXT PRIMARY KEY NOT NULL,
    workspace_id      TEXT NOT NULL,
    dataset_source_id TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    added_by          TEXT NOT NULL,
    added_at          TEXT NOT NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, dataset_source_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (dataset_source_id) REFERENCES dataset_sources(id)
);

CREATE INDEX idx_workspace_datasets_workspace ON workspace_datasets(workspace_id);
CREATE INDEX idx_workspace_datasets_source ON workspace_datasets(dataset_source_id);
