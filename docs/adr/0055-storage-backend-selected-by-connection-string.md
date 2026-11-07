# The storage backend is selected by a connection string

Status: Accepted. Supersedes
[ADR 0015](0015-server-stored-bookmarks-and-auth-seam.md) on the choice of
database and nothing else.

## Context

The server keeps its records in a set of stores: login sessions, pending
authentications, bearer tokens, CLI token authorizations, bookmarks, workspaces,
and more. `SqliteSessionStore` used to open the database, run the migrations,
and lend its pool to the others, so SQLite sat in public signatures and a second
backend had nowhere to plug in. ADR 0015 rejected Postgres as overkill for one
process on one machine. That condition no longer holds everywhere lucida runs: a
container platform gives a process an ephemeral filesystem unless someone
attaches a volume, and a single-writer file cannot serve two replicas.

## Decision

A storage backend owns the connection, runs the migrations, and hands out every
store. It is an object-safe trait chosen once at startup by matching the scheme
of `LUCIDA_DB_URL`, the shape
[ADR 0017](0017-configurable-from-day-one-for-oss-release.md) set for
authentication providers. The scheme names the backend and the rest of the
string belongs to it. Unset means `sqlite://lucida.db`, so lucida still runs
with no configuration, and SQLite stays the default.

The schemes are `sqlite` and `postgres`. The parser accepts `postgresql` and
rewrites it to `postgres`, so past parsing one backend has one name: the
dispatch matches one variant, the log prints one spelling, and no backend ever
sees the alias.

Parsing checks the scheme against one list, `Scheme::ALL`, so the dispatch has
no unknown-backend arm and the unsupported-scheme error names exactly what the
server accepts. `LUCIDA_DB_PATH` is gone with no alias. An old bare path left in
`LUCIDA_DB_URL` fails startup because it has no scheme.

Startup fails fast. An unsupported scheme, a server that does not answer within
a 3 s acquire timeout, or a migration that cannot run each end the process with
a message naming the target. The platform restarting the process is the retry
loop. Every printed connection string is redacted in both the userinfo and the
query string, because sqlx reads a password from either.

## Rejected alternatives

- A second concrete type beside each SQLite store, chosen by a flag at every
  construction site. Every later backend would then touch every site that reads
  or writes a row. A self-hosted open-source server should let someone add
  another database in one pull request, and that needs a seam to put it in.
- Refusing the `postgresql` spelling. PostgreSQL and libpq treat the two as
  equivalent, and connection strings get copied between tools that disagree.
  Refusing one makes sense only where they mean different things.
- `Scheme::Postgresql` as a second variant. Every `match` would answer the same
  question twice with nothing forcing the arms to agree, `Scheme::ALL` would
  advertise a choice that is not one, and two deployments of one backend would
  log differently.
- Passing the alias through to the backend. Backends strip their prefix by
  literal match, so every backend would have to know every alias.
- Keeping `LUCIDA_DB_PATH` as an alias. lucida is pre-1.0 and the migration is
  one line. A half-honored old name is how a server opens the wrong database.
- sqlx's default 30 s connect wait. A long in-process retry only delays the
  message an operator is waiting for.

## Consequences

The test that opens every `Scheme::ALL` entry can reach PostgreSQL only where a
server runs, so it skips on a laptop. CI requires it, as
[ADR 0058](0058-postgresql-shares-the-sql-and-duplicates-the-rust.md) describes.
