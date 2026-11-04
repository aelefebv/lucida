# A fixed-shape status route reports the storage backend and answers 200 either way

Status: Accepted.

## Context

`/healthz`, `/readyz`, and `/version` say whether the process is alive, whether
it should get traffic, and which build it is. None asks anything of the
database, so a process whose database is gone looks alive and ready until its
next request fails. An operator running lucida beside other services may have an
external monitor that polls each one for the state of its dependencies, and that
monitor had nothing to read from lucida.

## Decision

When `LUCIDA_STATUS_PATH` names a path, `lucida-server/src/status.rs` mounts a
route on the public, unauthenticated router half beside the probes. It runs one
trivial query through the storage backend's pool, waits at most two seconds, and
always answers `200 OK` with one fixed JSON shape carrying a label, a resource
name, `connected`, and `Success` or `Failure`. Unset means no route.

The status code says whether the route worked, and the body says what it found.
The targeted monitor renders a parseable `200` as a status, good or bad, and
anything else as a read error, so a `503` would show a database outage as an
unreadable status.

The resource name is the database name alone, parsed from `LUCIDA_DB_URL`,
unless `LUCIDA_STATUS_RESOURCE_NAME` replaces it. The route is public, so the
body carries nothing about where the database lives or how to reach it. A
connection string that names no database stops the boot until the override names
one, since libpq's fallback would be the user name.

The query goes through the pool the stores use, so the answer is about their
connections. Two seconds is shorter than either backend's pool acquire deadline,
so this timeout answers and not the pool's.

Bad configuration stops the boot and names the variable: a path without a
leading slash, a path the router cannot take, a path a probe already answers on,
or a label or resource name that is set but blank.

## Rejected alternatives

- Flip `/readyz` to 503 when the database is down. Readiness is a load
  balancer's signal, and a failure every replica shares would drain them all at
  once.
- A general health framework with pluggable checks and a configurable shape. One
  check and one consumer need no registry or template language, and a shape that
  can vary can drift from what the monitor parses. A fixed shape is a contract a
  test can hold. A second monitor gets a second route.
- Answer 503 on failure. The monitor would render a read error instead of an
  outage.
- Report the redacted connection string. Redaction keeps the host, and a public
  route may not show it.
- Open a dedicated connection for the check. It could succeed while every store
  failed, or fail on a limit the stores never hit.
- Report object storage or external listings too. They are not dependencies of
  the server staying up.
