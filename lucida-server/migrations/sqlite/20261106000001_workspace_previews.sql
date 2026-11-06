-- One preview image per workspace, for its card on the dashboard.
--
-- The viewer captures what it rendered and uploads it, so the server stores
-- bytes it never decodes. It sniffs the type from the leading bytes before
-- the write, and the check below holds the column to the same allowlist.
--
-- The row outlives an archive, so a restore brings the preview back, and
-- goes with the workspace when the workspace row is deleted.
CREATE TABLE workspace_previews (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL
        CHECK (content_type IN ('image/webp', 'image/png', 'image/jpeg')),
    size_bytes   BIGINT NOT NULL,
    image        BLOB NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT NOT NULL
);
