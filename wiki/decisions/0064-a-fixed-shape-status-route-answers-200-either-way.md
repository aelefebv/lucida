---
type: Decision
title: "A fixed-shape status route reports the storage backend and answers 200 either way"
description: "An opt-in route, mounted only when LUCIDA_STATUS_PATH is set, runs one trivial query through the storage backend under a two-second timeout and renders the outcome in one fixed JSON shape for an external monitor. It answers 200 whether or not the backend does, because the monitor reads a non-200 as a status it could not read rather than a bad one. The body carries the database name alone, never a host or a credential."
tags: [lucida, decision]
source_path: wiki/decisions/0064-a-fixed-shape-status-route-answers-200-either-way.md
created: 2026-09-08
modified: 2026-09-08
---

# A fixed-shape status route reports the storage backend and answers 200 either way

Status: Accepted.

## Decision

`lucida-server::status` gains a **status route**: an HTTP route, mounted only
when `LUCIDA_STATUS_PATH` names a path, that runs one trivial query through the
storage backend the server already holds, waits at most two seconds for it, and
answers `200 OK` with this body and no other keys:

```json
{"details": {"dependencies": {"database": [
  {"resource_name": "lucida.db", "connected": true, "message": "Success"}
]}}}
```

When the query fails or times out, `connected` is `false` and `message` is
`Failure`, and the status is still `200 OK`. `database` is the label
`LUCIDA_STATUS_LABEL` sets. The resource name is the database name parsed from
`LUCIDA_DB_URL`, unless `LUCIDA_STATUS_RESOURCE_NAME` replaces it.

The route mounts on the public router half beside `/healthz`, `/readyz`, and
`/version`, and is exempt from authentication for the reason they are: an
external monitor has no session.

## Why a route at all

The three probes answer three questions: is this process alive, should it get
traffic, and which build is it. None of them asks anything of the database. A
process whose database is gone is alive and, today, ready; its next request
fails. An operator running lucida next to other services has an external monitor that
polls each one for the state of its dependencies and shows the answers side by
side, and that monitor had nothing to read from lucida.

The route answers exactly that monitor's question and no other. It is not a
change to `/readyz`, whose meaning is "route traffic here" and whose consumer is
a load balancer. Flipping readiness on a database outage would take a replica
out of rotation for a failure every replica shares, which turns one outage
into two.

## Why a fixed shape rather than a health framework

The shape above is the shape one external monitor's parser accepted, fixed in code and
pinned by a test. The alternative was a general health surface: a registry of
checks, each contributing a fragment, rendered by a template the operator
configures.

Two things argued against it. lucida has one dependency worth reporting here,
so a registry would hold one entry, and a template language for one shape is a
second configuration surface to document, validate, and keep stable. And a
shape that can vary is a shape that can drift from what the monitor parses,
with the drift discovered on the monitor's display rather than in a test. A fixed shape
is a contract a test can hold.

If a second monitor ever needs a different shape, that is a second route with
its own path, not a template in this one.

## Why 200 on failure

The external monitor distinguishes two states. A `200` with a body it can parse is a
status, good or bad, and it renders the tile from `connected`. Anything else is
a status it could not read, and it renders a read error. A route that answered
`503` when the database was down would show the outage as the wrong one of
these: the monitor would say lucida's status is unreadable when in fact it
was read perfectly well and says the database is down.

The status code therefore reports whether the route itself worked, which it
always does, and the body reports what it found. This is the opposite of the
convention `/readyz` follows, and deliberately so. A load balancer reads the
code and nothing else. The external monitor reads the body and treats the code
as transport.

## Why the check is one query with a short timeout

The handler runs a single trivial query through the backend's own pool. It
opens no connection of its own, so the answer is about the database the server
is actually talking to, over the connections its stores use. A check that made
its own connection could succeed while every store failed, or fail on a
connection limit the stores never hit.

Two seconds is the ceiling because an external monitor polls on its own schedule and
must not hang on a hung database. It is shorter than either backend's own
acquire deadline, so it is this timeout that answers and not the pool's, and a
pool with no free connection is reported as disconnected rather than making the
monitor wait thirty seconds to learn nothing.

## Why the body carries the database name and nothing else

A route on the public half is a route anyone can read. Its body may not carry
anything from the connection string that says where the database lives or how
to reach it: no scheme, no host, no port, no user, no password, no query string.
The one thing an operator does need is a way to tell environments apart on a
display that shows several, and the database name does that.

`DatabaseUrl` gains a projection narrower than the redacted form
[ADR 0055](0055-storage-backend-selected-by-connection-string.md) introduced.
Redaction keeps the host, because a log line needs it. The status route needs
the name alone. For SQLite that is the file name; for PostgreSQL it is the path,
or the `dbname` parameter sqlx also accepts. A connection string that names no
database has no name to give. libpq would use the user name, which is the one
thing that must not stand in for it, and a placeholder would tell environments
apart from nothing, so the boot stops until the override names one.

The override exists for that case and for the deployment whose database name
says nothing useful. It is a plain string the operator chose, so the body can
carry nothing they did not decide to show.

## Why off by default, and why bad configuration stops the boot

Unset means off, byte for byte. With no path configured the router the module
returns is empty, and the tests reach for a candidate path and get a 404. This
is the contract [ADR 0017](0017-configurable-from-day-one-for-oss-release.md)
set for `LUCIDA_*` variables and the one the profile directory of
[ADR 0063](0063-a-profile-directory-enriches-the-principal-and-never-authenticates-it.md)
followed. A deployment that never heard of the route exposes nothing new.

Reading the variables follows the directory's split. The path treats blank as
unset, and a blank path means nothing else is read, so a template that leaves
it empty does not fail on a label nothing would render. The label and the
resource name have defaults, and for them present-and-blank is refused: the
default applies when the variable is absent, and a variable that is set to
nothing is a template that rendered nothing into it, which is the one mistake
worth reporting. A path without a leading slash, or with characters the router
would refuse, is refused at boot with a message that names the variable, rather
than left for the router to panic on with a message that names neither. So is a
path one of the three probes already answers on, the collision an operator is
most likely to type. A collision with any other route surfaces as the router's
own refusal at boot, which names the path.

## Consequences

- **The storage backend answers a ping.** `StorageBackend` gains one method,
  and both backends implement it with the same trivial statement. The
  conformance-style test in the storage module runs it against every scheme, so
  a third backend cannot ship without it.
- **The shape is a contract.** A test at the HTTP seam compares the whole body
  against a literal. Adding a key is a deliberate change to that test, not a
  side effect of a refactor.
- **Startup logs one line, the handler logs at debug.** The line names the path,
  the label, and the resource name, all three safe to print. An external monitor polling
  every few seconds does not fill the log.
- **The route reports the storage backend and nothing else.** Object storage
  and external listings have their own failure modes and are not dependencies
  of the server staying up. They are out of scope here, and a future need for
  them is a new decision.
- **No authentication and no rate limit.** The route reveals nothing, and a
  request costs one trivial query that holds a pooled connection for at most the
  timeout. A poller has an interval of its own, and this decision adds no
  second one.

## Alternatives considered

- **Flip `/readyz` to 503 when the database is down.** Rejected. Readiness is a
  load balancer's signal and a shared failure would drain every replica at once.
- **A general health framework with pluggable checks and a configurable
  shape.** Rejected, for the reasons above: one check, one consumer, and a shape
  that cannot drift.
- **Answer 503 on failure.** Rejected. The monitor would render a read error
  instead of an outage.
- **Report the redacted connection string as the resource name.** Rejected.
  Redaction keeps the host, and a public route may not show one.
- **Open a dedicated connection for the check.** Rejected. It would answer for a
  connection the stores never use.

## Related

- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — the `LUCIDA_*` contract the three variables extend, and the reason unset means off
- [The storage backend is selected by a connection string](0055-storage-backend-selected-by-connection-string.md) — the backend the route asks, and the redacted form the database name is narrower than
- [A profile directory enriches the principal and never authenticates it](0063-a-profile-directory-enriches-the-principal-and-never-authenticates-it.md) — the precedent for an opt-in seam configured by environment variables, and for telling present-and-blank apart from absent
