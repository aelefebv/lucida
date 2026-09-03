---
type: Decision
title: "One baseline schema, with honest column types"
description: "Thirteen migrations collapse into one baseline that a person can read in a sitting, and the four inconsistencies SQLite's loose typing had been hiding are resolved the same way in every table."
tags: [lucida, decision]
source_path: wiki/decisions/0057-one-baseline-schema-with-honest-column-types.md
created: 2026-09-03
modified: 2026-09-03
---

# One baseline schema, with honest column types

Status: Accepted.

## Decision

The server's schema is one **baseline**: a single migration that creates every
table, index, and constraint. The thirteen incremental migrations that preceded
it are deleted, not archived. Nothing upgrades an older database into this one.

Four conventions hold across the baseline, and the same convention holds in
every table:

- A timestamp column is `TEXT` holding RFC 3339 in UTC, written and read as
  `chrono::DateTime<Utc>` by sqlx.
- A JSON column is `TEXT` with a `json_valid` check.
- A counter the server reads as 64-bit is `BIGINT`.
- A parent-child edge declares its own `ON DELETE`, and the SQLite backend turns
  foreign-key enforcement on for every connection.

No table and no column is renamed. This is a cleanup of how values are declared,
not a change to what the server stores.

## Why collapse rather than keep the history

A migration file is worth keeping for one reason: some database out there is at
an earlier version and has to be walked forward. No deployment holds data, so
there is nothing to walk. What the thirteen files bought instead was thirteen
places to look for the shape of one table, with the current shape of
`workspace_saved_views` split across three of them, and `workspaces` across two.

The cost of that spread lands on the next backend. [ADR
0055](0055-storage-backend-selected-by-connection-string.md) made adding one a
bounded change, and [ADR 0056](0056-store-behavior-is-a-conformance-suite.md)
said what the new code has to do. Neither helps whoever has to write the second
schema, and reconstructing it from an append-only history is the largest piece
of that work. One file that states the schema is the thing to translate.

Collapsing is available exactly while no deployment holds data. Once one does,
the next collapse costs a data migration, so this is not a move to plan on
repeating.

## Why these four conventions

The typing was inconsistent because SQLite let it be. A declared type in SQLite
is a hint about affinity, never a constraint on what a column accepts, so a
column can be declared one way, written another, and read a third with nothing
in between objecting. Each convention picks the option that says what is true.

**Timestamps.** Two conventions were in use. Some tables declared `TIMESTAMP`
and let sqlx encode a `DateTime<Utc>`; others declared `TEXT` and converted by
hand in Rust on the way in and out. Both produced the same bytes, which is why
the split survived: the difference was invisible in the data and visible only in
the code.

`TEXT` beats `TIMESTAMP` because `TIMESTAMP` gives the column NUMERIC affinity,
and NUMERIC affinity converts a value that looks like a number into one. Nothing
writes such a value today, and nothing should depend on that holding. `TEXT`
describes what is stored.

The other way to store an instant in SQLite is an epoch integer, which is
smaller and sorts just as well. Text keeps two things the integer gives up.
RFC 3339 in UTC is fixed-width in its leading fields and sorts
lexicographically in chronological order, so `ORDER BY updated_at DESC` and
`WHERE expires_at <= ?` run against the stored value with no conversion on
either side. And an operator inspecting the database with `sqlite3` can read a
timestamp without doing arithmetic on it.

**JSON.** Five columns carry a serialized payload, and their JSON-ness lived
entirely in the `_json` suffix on the name. SQLite has no JSON type to declare,
so the baseline declares `TEXT` and adds `CHECK (json_valid(...))`. That is the
strongest claim SQLite can enforce, and it is the difference between a column
that holds JSON and a column that is named as though it does. Where a backend
has a real JSON type, the column takes it.

**Integer width.** `workspaces.seq` and `workspace_datasets.sort_order` are
written and read as 64-bit and were declared `INTEGER`. In SQLite the two are
the same storage, so this changes nothing here. It changes the translation:
`INTEGER` means four bytes in several other engines, and a sequence number that
silently caps at two billion is the kind of defect that surfaces years later.

**Cascades.** The bookmark and workspace tables already declared `ON DELETE
CASCADE`, and the Rust code did the cascade anyway, inside a transaction,
because SQLite ignores foreign keys unless a connection asks for them. One rule
enforced in two places is one place too many, and the hand-written place is the
one a new call site can forget. The baseline keeps the declaration and the
backend asks, so the database performs the cascade. A workspace's default saved
view moves the same way: the pointer declares `ON DELETE SET NULL` instead of
being cleared by a follow-up `UPDATE`.

## Consequences

- **An older database cannot be upgraded, and says so at startup.** sqlx
  compares the migrations it finds against the ones a database recorded, so
  opening a database created before this change reports a mismatch rather than
  proceeding. That is the right outcome, and it is only survivable because no
  deployment holds data.
- **Foreign-key enforcement is stated, not inherited.** sqlx turns the pragma on
  by default today. The backend sets it anyway, because a default is not a
  guarantee and a connection string can otherwise turn it off.
- **One foreign key is circular, and is the one thing a translation cannot copy
  line for line.** `workspaces.default_saved_view_id` points at
  `workspace_saved_views`, which points back at `workspaces`. SQLite resolves a
  foreign-key target when a row is written rather than when the table is
  created, so the cycle loads from a single file in the order written. An engine
  that resolves targets at `CREATE TABLE` rejects it, and reordering does not
  help a cycle, so that constraint has to be added afterwards with `ALTER
  TABLE`. The baseline says so at the point of declaration.
- **A stale saved view id now fails at the write.** Pointing a workspace at a
  saved view that no longer exists returns a backend error where it previously
  stored an id matching nothing. The manager checks the view belongs to the
  workspace first, so reaching this means racing a delete.
- **A JSON column now refuses text that is not JSON.** Every writer serializes
  with `serde_json`, so nothing legitimate is affected. A write that would have
  stored a truncated or empty payload fails at the write instead of failing at
  the next read.
- **One Rust type reaches every timestamp column.** `DateTime<Utc>` goes in and
  comes out, and the conversion helpers that stood between them are gone.
- **The conformance suites did not change.** They assert what a caller sees
  through a store trait, and none of this is visible there. Cascade behavior is
  the exception worth naming: a suite can see that a deleted bookmark stops
  matching a dataset query, but not whether an attachment row survived it, so
  that one is checked beside the SQLite store instead.

## Related

- [The storage backend is selected by a connection string](0055-storage-backend-selected-by-connection-string.md) — the seam this schema is being made translatable for
- [Store behavior is a conformance suite](0056-store-behavior-is-a-conformance-suite.md) — the safety net that made a schema-wide change checkable
- [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md) — where the first of the collapsed migrations came from
