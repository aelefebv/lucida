-- A workspace document records the generation of a source it was built
-- from. Keep this on the membership (not the global locator row): separate
-- workspaces may observe the same mutable locator at different times.
ALTER TABLE workspace_datasets ADD COLUMN source_revision TEXT;
