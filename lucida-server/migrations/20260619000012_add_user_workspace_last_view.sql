-- Per-user "remember my last view" (#700): the last SavedView a member
-- had open in a workspace, restored on a bare /w/:id open behind a user
-- toggle.
--
-- Additive + reversible: this is the member's own dashboard/restore state,
-- keyed (with the rest of user_workspace_state) on (user_email,
-- workspace_id), so it is naturally per-user isolated and never disclosed
-- to anyone else. Existing rows had no remembered view, so the new column
-- is nullable and reads back as NULL → WorkspaceUserState.last_view = None
-- with no backfill. Recording a last view writes ONLY this column; it must
-- never touch workspaces.default_saved_view_id (the shared default lives on
-- a different table entirely).

ALTER TABLE user_workspace_state
    ADD COLUMN last_view_json TEXT;
