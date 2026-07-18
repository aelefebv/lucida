-- Records data-shape upgrades that cannot be expressed by SQLite DDL alone.
--
-- The startup upgrader still validates the persisted source identities on
-- every boot. This ledger is an audit record, not a reason to trust rows that
-- may have been imported or edited after an earlier upgrade.

CREATE TABLE lucida_data_migrations (
    name       TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
);
