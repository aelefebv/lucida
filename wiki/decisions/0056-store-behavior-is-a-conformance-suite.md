---
type: Decision
title: "Store behavior is a conformance suite"
description: "Each store trait owns one suite of observable-behavior cases that every implementation of it runs, and the divergences the first run found were resolved toward refusing rather than quietly replacing."
tags: [lucida, decision]
source_path: wiki/decisions/0056-store-behavior-is-a-conformance-suite.md
created: 2026-09-03
modified: 2026-09-03
---

# Store behavior is a conformance suite

Status: Accepted.

## Decision

Each of the six store traits owns one **conformance suite**: a set of cases
written against the trait, parameterized over an implementation, and run
against every implementation of that trait. What a suite asserts is the
trait's contract. What it leaves alone, an implementation is free to choose.

A case asserts only what a caller can observe through the trait: what you
write comes back, what you delete is gone, what should conflict does
conflict, what should cascade does cascade, what should be ordered is
ordered, and what is written together becomes visible together. It never
names a table, a column, a query plan, or which implementation is running.
A test that needs one of those is an implementation test and stays beside
its implementation.

The suites live in `lucida-server::storage`, next to the backend seam of
[ADR 0055](0055-storage-backend-selected-by-connection-string.md), because
that is the one module that already knows all six stores.

## Why not keep testing each implementation on its own

That is what the code did, and it is why the divergences below went unseen.
Four of the five paired traits were tested twice over, once per
implementation, each test asserting what its own store happened to do. Two
implementations, and no shared statement for them to disagree with. The
bookmark store had already reached for the shape this ADR generalizes,
running a few generic helpers against both; its divergence survived because
attachment order was the one thing those helpers left unpinned. Covering
each implementation is not the same thing as making them agree.

Writing the suites found three disagreements, across four traits:

- A reused primary key overwrote the row in memory and errored in SQL, in
  the login session, bearer token, and CLI token authorization stores alike.
- A second approval of a CLI token authorization re-pointed it at the new
  credential in memory and was ignored in SQL.
- A bookmark's dataset attachments came back in caller order from the
  in-memory create, in hash order from the SQLite create, and in URL order
  from either store's read path.

These are not obscure. The in-memory stores exist so handler and middleware
tests need no database, which left those tests asserting against behavior
production never exhibits.

## Why the SQL semantics won each time

Not because SQLite is the production backend. That would make the seam
decorative. In each case the SQL behavior refuses where the other quietly
replaces:

- Rejecting a reused id keeps one identity per id. Overwriting swaps one
  identity for another and reports success, which is the same shape as a
  credential-substitution bug.
- Keeping the first approval means an approved authorization cannot be
  re-pointed at a second credential or a second person.

Ordering is the exception, because neither implementation was right. Nothing
preserves the order a caller passed. SQLite has no column to keep it in, so
that order could only survive a schema change, and a bookmark's attachments
are a set rather than a list. Sorted by URL is the only order both stores
can produce today, and both read paths already returned it. The create paths
now return it too, so a write and a read agree.

## Consequences

- **A second backend inherits the suites.** Adding one is a factory and a
  name in a list per trait. ADR 0055 called adding a backend a bounded
  change; until now the bound was compile-time only, and nothing said what
  the new code had to *do*.
- **A trait's contract has one home.** The prose on the trait says what a
  method is for; the suite says what it must answer. The two used to drift.
  `PendingAuthStore::consume` documented an atomicity requirement that
  nothing checked, and the suite checks it now.
- **The workspace store's suite runs against one implementation.** Writing
  it is still worth doing. The cases are the contract rather than a
  comparison, and a second implementation costs one factory when it arrives.
- **Per-implementation tests the suites cover are gone**, not kept
  alongside. What stays beside an implementation is what only that
  implementation can be asked: the bookmark overlap query's plan, and the
  SQLite backend's file handling.
- **Nondeterminism the old tests could not see now fails.** The SQLite
  create path handed back attachments in hash-map order. Two
  per-implementation tests read that field and neither could see it: one
  attached a single URL, and the other compared the result as a set.

## Related

- [The storage backend is selected by a connection string](0055-storage-backend-selected-by-connection-string.md) — the seam these suites make verifiable
- [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md) — where the store traits and their in-memory doubles came from
