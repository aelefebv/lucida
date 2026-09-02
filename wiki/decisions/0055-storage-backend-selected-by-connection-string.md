---
type: Decision
title: "The storage backend is selected by a connection string"
description: "One object owns the database connection, the migrations, and all six stores; its scheme-tagged connection string in LUCIDA_DB_URL picks which one runs, superseding ADR 0015's rejection of Postgres."
tags: [lucida, decision]
source_path: wiki/decisions/0055-storage-backend-selected-by-connection-string.md
created: 2026-09-02
modified: 2026-09-02
---

# The storage backend is selected by a connection string

Status: Accepted.

## Decision

A **storage backend** owns the database connection, runs the migrations, and
hands out all six stores — login sessions, pending authentications, bearer
tokens, CLI token authorizations, bookmarks, and workspaces. It is an
object-safe trait, chosen once at startup by a `match` on the scheme of a
connection string, in the shape [ADR 0017](0017-configurable-from-day-one-for-oss-release.md)
established for authentication providers.

`LUCIDA_DB_URL` carries the connection string. Its scheme names the backend,
and the rest of the string belongs to that backend. Unset means
`sqlite://lucida.db`, so running lucida still needs no configuration.

SQLite is the only scheme this decision implements, and it stays the default.
Nothing here makes SQLite second-class.

**This supersedes [ADR 0015](0015-server-stored-bookmarks-and-auth-seam.md) on
one point.** ADR 0015 considered Postgres and rejected it as "overkill for the
deployment scale; adds operational burden." That rejection was conditional on a
deployment scale, and it was right for the scale it named: one process, one
file, one machine. The condition no longer holds everywhere lucida runs. A
deployment on a container platform gets an ephemeral filesystem unless someone
attaches a volume, and a single-writer file cannot serve more than one replica
at all. Everything else ADR 0015 decided stands, including its reasons for
SQLite, which is why SQLite remains the default rather than a fallback.

## Why a seam rather than a second database

The alternative was to add Postgres directly: a second concrete type beside each
SQLite store, and a boolean or a mode enum choosing between them at each of the
six construction sites.

Two things argued against it. The first is the one ADR 0017 already argued for
providers: without a seam, every later backend is a change to every site that
reads or writes a row, and the sites multiply as features land. The second is
that lucida is open source and self-hosted. Whoever wants MySQL, or a managed
service with its own dialect, should be able to write one implementation and
send one pull request. That is only true if there is a place for the
implementation to go.

The seam also costs almost nothing here, because the six store traits already
existed. What the code was missing was an owner for the connection.

## What was actually wrong

The connection had an owner, and it was the wrong one. `SqliteSessionStore`
opened the database, ran the migrations, and exposed its pool so the other five
stores could borrow it. That put SQLite in a public signature far from anything
about SQLite, made the session store load-bearing for bookmarks, and left no
answer to "where does the second backend plug in?"

The storage backend is that answer. `SqliteSessionStore` now takes a pool like
every other store, and nothing outside the SQLite backend names a SQLite type.

## Consequences

- **`LUCIDA_DB_PATH` is removed, with no alias.** ADR 0017 calls the `LUCIDA_*`
  names a public API and a rename a breaking change, and this is one. The break
  is deliberate. lucida is pre-1.0, and the migration is one line:
  `LUCIDA_DB_PATH=/x/y.db` becomes `LUCIDA_DB_URL=sqlite:///x/y.db`. A value
  left in the old variable is ignored rather than half-honored. An old *path*
  left in the new variable fails startup instead of silently opening the wrong
  database, because a bare path has no scheme.
- **Startup fails on a connection string this build cannot serve**, naming the
  variable and the schemes that work. Parsing happens in the configuration
  layer, so the dispatch has no unrecognized-backend arm to write.
- **The connection string is redacted wherever it is printed** — in the startup
  log and in every storage error. SQLite URLs carry no credentials, so this does
  nothing today. It is here now because the first backend that talks over a
  network would otherwise put a password in the logs of every deployment that
  adopts it.
- **Adding a backend is a bounded change**: a `Scheme` variant, a dispatch arm,
  an entry in `Scheme::ALL`, and an implementation of the trait. Every `match`
  on `Scheme` stops compiling until the new backend is handled. `Scheme::ALL`
  is the single list. Parsing searches it and the unsupported-scheme error
  names it, so what the server accepts and what it advertises cannot drift
  apart. A test opens every entry, which proves the dispatch arm reaches a
  backend that comes up rather than one that merely compiles.
- **The six stores share one connection budget and one transaction domain**, as
  they did before. That used to be a side effect of borrowing one store's pool.
  Now it is a property the backend states.
- **Tests open a database the way production does.** Three test harnesses each
  built their own pool and ran their own migrator; they now go through the
  backend, so a change to how a database opens cannot be true in production and
  false in tests.

## Related

- [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md) — superseded on the choice of database, upheld everywhere else
- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — the extension-point pattern this follows, and the `LUCIDA_*` contract this breaks once, on purpose
- [Single-Image Container with `ServeDir`](0020-single-image-with-servedir.md) — the deployment shape that exposes the ephemeral-filesystem problem
