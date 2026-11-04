# Unwritten levels are named, not hidden

Status: Accepted.

## Context

Zarr reads a missing chunk as `fill_value`, so a pyramid level that a store
declares but never wrote is legal and entirely zero. lucida served it correctly
and the screen went black, while auto-contrast collapsed to a 0 to 0 window and
`lucida dataset health` said `healthy`. The layer's detail control defaults to
the finest level, so the black canvas was the default view.
[ADR 0045](0045-tolerant-ome-attribute-placement.md) opened these stores and
left this unsolved. Proving a level empty means listing its chunk prefix, which
the remote open path cannot afford.

## Decision

An unwritten level is detected at import, kept in the pyramid, and named: a
warning in the open-progress trail, a line in `DatasetSourceHealth.messages`,
and a `Degraded` health status.

Detection is relative. Import probes the origin chunk of every declared level
concurrently, one small metadata read per level. A level is unwritten only when
its origin chunk is absent while the origin chunk of a level whose footprint
lies inside it is present. Absence everywhere reports nothing. The probe runs
once per multiscale geometry, not once per collection member.
`lucida-store/src/unwritten.rs` documents the test, including the sharded case.

The level stays because consumers address levels by position, so dropping one
misaligns every level after it. The health status moves, because a message under
a `healthy` banner is the same silence with more words.

## Rejected alternatives

- List each level's chunk prefix. Definitive, but an unbounded number of
  requests per level on the path that most needs to be cheap.
- One early-stopping `list` request per level. Conclusive, but it needs list
  permission, and readers granted only object get are common. A HEAD needs
  nothing the open path does not already use.
- Warn whenever the origin chunk is absent. It fires on legitimately sparse data
  and on nearly every fixture in the test suite.
- Compare levels without the containment test. It assumes every origin chunk
  covers the same patch, which is false whenever chunk size and scale do not
  move together, and it accuses healthy sparse data.
- Drop the empty level so a coarser one stays resident. It fixes the picture but
  breaks positional indexing, and it hides a data defect instead of reporting
  it.
- Count fill responses at serve time. Free and definitive, but it can speak only
  after the user has stared at a black screen. Worth revisiting as a complement.
- Do nothing, since it is an export defect. Reporting `healthy` over a blank
  viewport is lucida's claim, not the exporter's.

## Consequences

A level written everywhere except its origin chunk is reported as unwritten. A
single-level pyramid has no witness and is never checked. Label pyramids are not
probed, because that would add a round trip per label on a path that already
samples label discovery to stay affordable.
