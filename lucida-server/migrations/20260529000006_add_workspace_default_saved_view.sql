-- Optional pointer to the shared saved view a workspace should apply on
-- bare /w/:workspace_id opens.

ALTER TABLE workspaces
ADD COLUMN default_saved_view_id TEXT;

