-- Optimistic concurrency for durable per-user viewer profiles. Revision 1 is
-- assigned to every existing row; successful compare-and-swap updates advance
-- it exactly once.

ALTER TABLE workspace_viewer_profiles
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
