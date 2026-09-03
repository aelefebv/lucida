---
type: Decision
title: "PostgreSQL is selectable, and the alias stops at the parser"
description: "A postgres:// connection string now starts a server. postgresql:// is accepted as a second spelling of the same scheme and rewritten during parsing, so one backend keeps one name everywhere past the door."
tags: [lucida, decision]
source_path: wiki/decisions/0059-postgresql-is-selectable-and-the-alias-stops-at-the-parser.md
created: 2026-09-03
modified: 2026-09-03
---

# PostgreSQL is selectable, and the alias stops at the parser

Status: Accepted.

## Decision

`Scheme` gains a `Postgres` variant, `Scheme::ALL` gains its entry, and
`storage::open` gains its arm. [ADR 0055](0055-storage-backend-selected-by-connection-string.md)
described this as the bounded change adding a backend costs, and it was.
`PostgresStorageBackend` already had six accessors shaped like the trait, so it
became a `StorageBackend` without a query moving.

**One scheme answers to two spellings.** `DatabaseUrl::parse` rewrites
`postgresql` to the canonical `postgres` on the way through. Past that point one
backend has one name: the dispatch matches a single variant, the startup log
prints one spelling, and the backend compares a prefix it knows.

## Why accept two spellings

PostgreSQL's own documentation gives `postgres://` and `postgresql://` as
equivalent, libpq takes either, and connection strings get copied between
tools that disagree about which to emit. A deployer who pastes the spelling
their platform hands them gets a server that refuses to start, and the fix is
deleting three characters from a string that looks correct.

Refusing one spelling is defensible only where the two mean different things.
Here they do not.

## Why the alias is not a variant

The alternative was `Scheme::Postgresql` beside `Scheme::Postgres`, both
dispatching to the same backend.

Two variants for one backend makes every `match` on `Scheme` answer the same
question twice, and the compiler cannot tell that the two arms have to agree.
`Scheme::ALL` would advertise both, so the unsupported-scheme error would offer
a reader a choice that is not one. The startup log would print whichever the
deployer typed, so two deployments of the same backend would not grep alike.

Passing the alias through to the backend was the other alternative, and it
loses to the same argument one level down. A backend strips its scheme prefix
by literal match, which is why parsing already lowercases `SQLITE://`. An alias
that survived parsing is one more spelling every backend has to know about.

## What a failed boot says

The three ways a database fails to come up now all end the process with a
message that names what the server tried to reach:

- The connection string is a backend this build does not have. Configuration
  refuses it, names `LUCIDA_DB_URL`, and lists the schemes that work.
- The server is unreachable, or refuses the credentials. `storage::open`
  returns a connect failure after three seconds, the pool's acquire timeout
  rather than sqlx's thirty-second default. The platform restarting the process
  is the retry loop, and a long in-process one only delays the message an
  operator is waiting for.
- The migrations cannot run. `storage::open` returns a migrate failure, and no
  request is ever served against a half-built schema.

Every one of them carries the redacted connection string, never the raw one.
ADR 0055 put that in `StorageError` before any backend needed it, and
PostgreSQL is the backend it was written for.

**Redaction has two places to look, because a PostgreSQL string has two places
to put a password.** The userinfo before the `@` is the familiar one. The other
is the query string, where sqlx reads `user` and `password`, so a connection
string with no `@` in it at all can still carry a secret. Looking only at
userinfo prints that password in the startup log.

## Consequences

- **`Scheme::ALL`'s promise now depends on the machine.** ADR 0055 named a test
  that opens every entry, which proves a dispatch arm reaches a backend that
  comes up rather than one that merely compiles. A backend that needs a server
  cannot be opened where there is none, so that case skips PostgreSQL on a
  developer's laptop. `LUCIDA_TEST_POSTGRES_REQUIRED` in continuous
  integration is what keeps the promise from shrinking into a claim about
  SQLite alone.
- **The PostgreSQL driver stops being dead weight.** [ADR 0058](0058-postgresql-shares-the-sql-and-duplicates-the-rust.md)
  noted that compiling it into every build bought only the conformance cases,
  because nothing selected the backend. It is now the second thing a deployment
  can run on.
- **SQLite is untouched and stays the default.** An unset `LUCIDA_DB_URL` still
  means `sqlite://lucida.db`. Nothing about the SQLite path was edited to make
  room for the second backend.
- **Surviving a restart is a claim, not a property.** ADR 0055 took the
  decision because a container platform gives a process an ephemeral
  filesystem, and a single-writer file cannot serve two replicas. Both reasons
  assume the state is still there when the process comes back, so that is
  something this decision owes rather than something it inherits.
- **Concurrent starts were already handled.** ADR 0058 pinned sqlx's
  `pg_advisory_lock` around a migration run. Two replicas rolling out at once
  are now something that happens rather than something a test simulates, and
  nothing had to change for it.

## Related

- [The storage backend is selected by a connection string](0055-storage-backend-selected-by-connection-string.md) — the seam this fills in, and the promise about `Scheme::ALL` this qualifies
- [PostgreSQL shares the SQL and duplicates the Rust](0058-postgresql-shares-the-sql-and-duplicates-the-rust.md) — the six ports this makes reachable, and the condition it set for reaching them
- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — the `LUCIDA_*` contract a new accepted value extends without breaking
