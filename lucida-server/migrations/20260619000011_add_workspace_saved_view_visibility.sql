-- Personal saved views (#699): a per-member private layer alongside shared views.
--
-- Additive + reversible: existing rows were all shared, so the new column
-- defaults to 'shared' and reads back as SavedViewVisibility::Shared with no
-- backfill. The ownership predicate (shared OR created_by = caller) is keyed on
-- created_by, which already holds the normalized AuthPrincipal.email, so the
-- partial index below lets the filtered list short-circuit a member's own
-- personal rows without a full scan.

ALTER TABLE workspace_saved_views
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';

CREATE INDEX idx_workspace_saved_views_personal_owner
    ON workspace_saved_views(workspace_id, created_by)
    WHERE visibility = 'personal';
