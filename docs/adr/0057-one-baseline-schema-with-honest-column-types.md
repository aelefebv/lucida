# One baseline schema, with honest column types

Status: Accepted.

## Context

Thirteen incremental migrations had spread the shape of one table across several files, and
SQLite let column types drift, because a declared type there is an affinity hint, not a
constraint. No deployment held data, so nothing needed walking forward. A second backend
([0055](0055-storage-backend-selected-by-connection-string.md)) needed one schema it could
translate.

## Decision

The schema is one baseline migration that creates every table, index, and constraint. The
incremental migrations are deleted, and nothing upgrades an older database. Four conventions
hold in every table:

- A timestamp is `TEXT` holding RFC 3339 in UTC, read and written as `DateTime<Utc>`.
- A JSON column is `TEXT` with `CHECK (json_valid(...))`, or the engine's real JSON type.
- A counter read as 64-bit is `BIGINT`.
- A parent-child edge declares its own `ON DELETE`, and the SQLite backend turns foreign keys
  on for every connection, so the database performs the cascade.

## Rejected alternatives

- Keep the migration history. It exists to walk an old database forward, and none existed.
  This collapse is available only while no deployment holds data.
- `TIMESTAMP` columns. They give NUMERIC affinity, which converts number-like text.
- Epoch integers for instants. Smaller, but RFC 3339 text sorts chronologically as stored and
  an operator can read it in `sqlite3`.
- Cascades in Rust. The rule lived in two places, and the hand-written one is the one a new
  call site forgets.

## Consequences

A database created before the baseline fails at startup with a migration mismatch. The
circular foreign key between `workspaces` and `workspace_saved_views` cannot be copied line for
line into an engine that resolves targets at `CREATE TABLE`; it has to be added afterwards with
`ALTER TABLE`.
