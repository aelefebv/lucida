-- Workspace previews for PostgreSQL: the SQLite migration beside this one
-- translated. Same table, columns, names, check, and cascade; read that
-- file for what a preview is.
CREATE TABLE workspace_previews (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL
        CHECK (content_type IN ('image/webp', 'image/png', 'image/jpeg')),
    size_bytes   BIGINT NOT NULL,
    image        BYTEA NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL,
    updated_by   TEXT NOT NULL
);
