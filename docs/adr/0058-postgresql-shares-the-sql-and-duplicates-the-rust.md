# PostgreSQL shares the SQL and duplicates the Rust

Status: Accepted. Its point that PostgreSQL is not selectable at runtime is
superseded by [ADR 0055](0055-storage-backend-selected-by-connection-string.md),
which made it selectable once every store had a PostgreSQL implementation.

## Context

Adding PostgreSQL behind the storage seam of ADR 0055 means a second
implementation of each store trait. When the port started, the SQLite stores
held 86 queries and 245 `?` placeholders. SQLite writes a placeholder as `?` and
PostgreSQL as `$1`. The engines also differ in column types: SQLite has no
timestamp or JSON type.

## Decision

Each store trait gets a second Rust implementation for PostgreSQL, holding the
binding and the row mapping. The SQL text is not duplicated. Each store's
statements live in one module both implementations share (the `*_sql.rs` and
`sql.rs` files), written with numbered placeholders, so both run the same
characters. sqlx's SQLite driver binds argument N to `$N`, and since that
behavior belongs to sqlx rather than SQLite, a test beside the SQLite backend
pins it. A statement never mixes `$1` and `?`: the two forms bind the same
argument and return a wrong answer with no error.

Where the engines genuinely differ, such as row locking, a backend runs a
statement of its own and says why. Share by default, and diverge where sharing
would be a lie.

The schema is written twice, in `lucida-server/migrations/sqlite/` and
`lucida-server/migrations/postgres/`. The Rust type is the portable contract,
and each engine declares whichever column type maps to it. The baseline
migration headers list those conventions. Tests compare the two migrated schemas
on columns, nullability, and named indexes, and skip column types on purpose.

A JSON column binds `sqlx::types::Json` rather than casting with `$n::jsonb`,
because SQLite rejects `::` and a cast would end the sharing for that statement.

## Rejected alternatives

- Keep `?` in the shared text and renumber it for PostgreSQL. That needs a SQL
  lexer, because a `?` can sit inside a string literal and `?`, `?|`, and `?&`
  are PostgreSQL's JSON operators, which the `JSONB` columns make a likely next
  query.
- One implementation over sqlx's `Any`. Its type mapping is the intersection of
  every driver and lacks the timestamp type every table uses.
- One implementation generic over `Database`. Every type a query binds or
  decodes needs a trait bound at every method, for no gain over shared
  statements.
- One shared schema file. A column declaration cannot be shared between an
  engine with a timestamp type and one without.
- The PostgreSQL driver behind a cargo feature. Its conformance cases would
  vanish from a default `cargo test`.

## Consequences

PostgreSQL cases need a server. `LUCIDA_TEST_POSTGRES_URL` names one, and the
cases skip when it is unset or nothing answers. CI sets
`LUCIDA_TEST_POSTGRES_REQUIRED`, which turns a skip into a failure, so a service
container that never came up cannot report green.
