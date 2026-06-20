-- Viewer-proposed saved views (#702): a third visibility, 'proposed', a
-- viewer's bid to share that stays out of the shared list but surfaces to
-- editors for review (approve -> 'shared', reject -> 'personal').
--
-- Additive + reversible: 'proposed' is stored in the existing visibility TEXT
-- column (no schema change, no CHECK constraint, no backfill — pre-existing
-- rows are 'shared'/'personal' and read back unchanged). The editor review
-- queue lists EVERY proposed row in a workspace; this partial index, mirroring
-- the personal-owner one, lets that workspace-scoped query short-circuit to
-- just the pending proposals instead of scanning every saved view.
CREATE INDEX idx_workspace_saved_views_proposed
    ON workspace_saved_views(workspace_id, created_by)
    WHERE visibility = 'proposed';
