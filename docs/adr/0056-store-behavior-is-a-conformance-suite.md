# Store behavior is a conformance suite

Status: Accepted.

## Context

Most store traits have an in-memory implementation, so handler and middleware
tests need no database, beside the SQL one. Each implementation was tested on
its own, asserting whatever it happened to do. Writing shared cases found three
disagreements. A reused primary key overwrote the row in memory and errored in
SQL, in the login session, bearer token, and CLI token authorization stores. A
second approval of a CLI token authorization re-pointed it in memory and was
ignored in SQL. Bookmark attachments came back in caller, hash, or URL order
depending on the store and the path. Handler tests were asserting against
behavior production never showed.

## Decision

Each store trait owns one conformance suite, in
`lucida-server/src/storage/conformance/`, written against the trait and run
against every implementation of it. What a suite asserts is the trait's
contract. What it leaves alone, an implementation may choose.

A case asserts only what a caller can observe through the trait. It never names
a table, a column, a query plan, or which implementation is running. A test that
needs one of those is an implementation test and stays beside its
implementation. Per-implementation tests that a suite covers are deleted, not
kept alongside.

Where implementations disagreed, the behavior that refuses won over the one that
silently replaces. A reused id is rejected, because overwriting swaps one
identity for another and reports success, the same shape as a
credential-substitution bug. The first approval stands, so an approved
authorization cannot be re-pointed at another credential or person. Bookmark
attachments are sorted by URL: they are a set, SQLite has no column to keep
caller order, and URL order is the one both stores already produced on read.

## Rejected alternatives

- Keep testing each implementation separately. Covering each implementation does
  not make them agree. The bookmark store already ran a few shared helpers
  against both, and its ordering divergence survived because those helpers left
  order unpinned.
- Let the production backend's behavior define the contract. That makes the seam
  decorative. SQL won each case on its merits, and on ordering neither side was
  right.
- Preserve caller order for attachments. It needs a schema change to keep an
  order on a set.
