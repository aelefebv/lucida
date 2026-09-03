---
type: Decision
title: "PostgreSQL shares the SQL and duplicates the Rust"
description: "A second backend costs one more Rust implementation per store trait and no second copy of the SQL, because numbered placeholders mean the same thing on both engines; the schema is the one thing that has to be written twice."
tags: [lucida, decision]
source_path: wiki/decisions/0058-postgresql-shares-the-sql-and-duplicates-the-rust.md
created: 2026-09-03
modified: 2026-09-03
---

# PostgreSQL shares the SQL and duplicates the Rust

Status: Accepted.

## Decision

A store trait gains a second Rust implementation for PostgreSQL, beside the
SQLite one, holding the binding and the row mapping. The **SQL text is not
duplicated with it**: the statements move into a module the two implementations
share, written with numbered placeholders, and both run the same characters.

Where the engines genuinely differ, a backend runs a statement of its own. Row
locking has no SQLite spelling, so a PostgreSQL implementation reaching for one
writes its own text and says why. The rule is to share by default and diverge
where sharing would be a lie.

The schema is the exception, and it is written twice:
`lucida-server/migrations/sqlite/` and `lucida-server/migrations/postgres/`. A
column declaration cannot be shared between an engine with a timestamp type and
one without.

**PostgreSQL is not selectable at runtime.** `Scheme` gains no variant and
`storage::open` gains no arm, because `PostgresStorageBackend` serves one of the
six stores and [ADR 0055](0055-storage-backend-selected-by-connection-string.md)
promises that every scheme reaches a backend that comes up. That holds until the
remaining five stores land.

## What the port measured

The pending-authentication store is the smallest of the six: three methods, and
68 lines of code before this change. The counts below are what the port cost
when it landed, not a claim about the code as it stands later.

| | Straight port | After sharing |
| --- | --- | --- |
| Lines per implementation | 68 | 55 |
| Lines identical between them | 59 | 49 |
| Lines that differ | 9 | 6 |
| Of those, lines carrying SQL | 3 | 0 |

The six lines that still differ are the pool type and the type name. Nothing
else about the two implementations is distinguishable. What they share is one
module of 13 lines: three statements and the function that turns a driver error
into a store error.

When the port started, the six SQLite implementations held 2,494 lines of code,
86 queries, and 245 `?` placeholders between them. Sharing the SQL is what keeps
that last number from being paid a second time.

## Why numbered placeholders travel

SQLite writes a placeholder as `?` and PostgreSQL writes it as `$1`, which is the
difference the spike existed to settle. The numbered form is the one that works
on both. sqlx's SQLite driver reads the number out of the parameter name and
binds argument N to `$N`, so a statement written PostgreSQL's way runs unchanged
on SQLite — including a placeholder used twice, and placeholders out of order.
SQLite's bare `?` has no PostgreSQL counterpart, so the translation only runs one
way.

That behavior is now load-bearing for the SQLite path that ships, and it belongs
to sqlx rather than to SQLite, so a test pins it rather than a comment claiming
it. `numbered_placeholders_bind_by_number`, beside the SQLite backend, writes a
row and reads it back through placeholders given out of order, which matches only
if the numbers won over the positions.

The alternative was a rewriter: keep `?` in the shared text and renumber it at
the PostgreSQL call site. That needs a SQL lexer to be correct, because a `?` can
sit inside a string literal, and because `?`, `?|`, and `?&` are PostgreSQL's
JSON containment operators. The baseline just gave five columns the `JSONB` type,
so those operators are the natural next query rather than a hypothetical one.

Writing one implementation generic over the engine was the other alternative.
sqlx offers `Any`, which erases the driver at runtime, but its type mapping is
the intersection of every driver it supports and does not carry the timestamp
type every table here depends on. Writing the store generic over `Database`
instead means a trait bound for every type any query binds or decodes, at every
method. Neither buys more than the shared statements do.

**One statement takes one form or the other, never both.** A statement holding
`$1` and `?` together binds the same argument to both and reports no error, so it
returns a wrong answer rather than failing. The shared module says so where
someone would go to add a query.

## Why the schema is two files and the stores are not

`TEXT` holding RFC 3339 is the best a SQLite timestamp column can do, and
`TIMESTAMPTZ` is what the same column is on PostgreSQL. [ADR
0057](0057-one-baseline-schema-with-honest-column-types.md) already settled that
the column type belongs to the backend and the Rust type is the portable
contract, so this is that decision applied rather than a new one. The same
paragraph covers `JSONB` in place of `TEXT` with a `json_valid` check.

Two files can drift, so tests read a migrated database on each side and compare
what the two declare: the columns, whether each one accepts null, and the named
indexes. Column types are left out on purpose, being the one thing the
translation is allowed to change.

## Consequences

- **The remaining five ports are the Rust, not the SQL.** Each is a second
  implementation of one trait, a factory, and a name in a conformance suite's
  `when_available` list. The statements move to a shared module on the way past,
  which is where the placeholder question gets answered once per store instead
  of once per query.
- **A `JSONB` column will not accept a bound Rust `String`.** PostgreSQL refuses
  a `text` parameter for a `jsonb` column outright, and every store that writes a
  serialized payload binds exactly that today. A test records the refusal,
  because it is the one Rust-side cost the remaining ports all pay. The fix is a
  `sqlx::types::Json` bind rather than a `$6::jsonb` cast: `::` is PostgreSQL
  syntax that SQLite rejects, so casting would end the sharing for that
  statement while rebinding leaves the text alone.
- **Nothing else in the six stores is SQLite-flavored.** `ON CONFLICT ... DO
  UPDATE` appears nine times and is standard on both. `DELETE ... RETURNING`
  works on both. Grouping by a primary key while selecting columns it determines
  is legal on both. The one dialect-typed construct is a `QueryBuilder<Sqlite>`
  in the workspace admin search, and a `QueryBuilder<Postgres>` writes its own
  placeholders, so that is a type parameter rather than a rewrite.
- **Concurrent migration needed no new code.** sqlx wraps a PostgreSQL migration
  run in `pg_advisory_lock`, keyed on the database name, so two replicas starting
  at once serialize and the second finds nothing to apply. The lock is
  session-scoped, and a pool is a session, so a test opens four backends against
  one empty database and asserts the baseline is applied once — the same
  contention two processes would produce. With the lock turned off that test
  fails on a duplicate object.
- **A developer with no PostgreSQL still runs the whole suite.**
  `LUCIDA_TEST_POSTGRES_URL` names the database. Unset, unreachable, or refusing
  the role a schema of its own, the PostgreSQL cases skip and the reason goes to
  the process's own stderr rather than through the test harness, which would
  capture it and show it only on the failure it will never accompany.
- **Continuous integration cannot skip by accident.**
  `LUCIDA_TEST_POSTGRES_REQUIRED` turns a skip into a failure, and the workflow
  sets it beside the connection string. Without it, a service container that
  never came up would report green having tested nothing.
- **The PostgreSQL driver is compiled into every build.** Nothing selects the
  backend at runtime, so this buys only the conformance cases. A cargo feature
  would have made those cases invisible on a default `cargo test`, which is the
  opposite of what the skip message is for.

## Related

- [The storage backend is selected by a connection string](0055-storage-backend-selected-by-connection-string.md) — the seam this backend plugs into, and the promise that keeps PostgreSQL out of `Scheme` for now
- [Store behavior is a conformance suite](0056-store-behavior-is-a-conformance-suite.md) — the suite the PostgreSQL store had to pass, and the `when_available` list a backend that needs a server joins
- [One baseline schema, with honest column types](0057-one-baseline-schema-with-honest-column-types.md) — the column conventions the PostgreSQL baseline translates, and the Rust-type-as-contract rule it follows
