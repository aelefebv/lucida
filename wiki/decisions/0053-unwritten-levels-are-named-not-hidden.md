---
type: Decision
title: "Unwritten levels are named, not hidden"
description: "A declared pyramid level with no chunks written is detected by a relative origin-chunk probe, kept in the pyramid, and reported as a warning that degrades dataset health."
tags: [lucida, decision]
source_path: wiki/decisions/0053-unwritten-levels-are-named-not-hidden.md
created: 2026-08-11
modified: 2026-08-11
---

# Unwritten levels are named, not hidden

Status: Accepted (issue #904).

## Decision

A pyramid level that a store declares but never wrote chunks for is **detected at import,
kept in the pyramid, and named** — in the open-progress trail as a warning, in
`DatasetSourceHealth.messages`, and as a `Degraded` aggregate health status.

Detection is a **relative** test, not an absolute one. At import, the origin chunk of every
declared level is probed concurrently — one HEAD per level, a single round trip. A level is
called unwritten only when its origin is absent **while at least one sibling level's origin
is present**. When no level has an origin chunk, nothing is reported.

The probe is asked once per **multiscale geometry**, not once per member: a collection's
tiles share one multiscale, and whether an export finished is a property of the export.

## Why

Zarr says a missing chunk reads as `fill_value`. A level that was declared and never
written is therefore legal, complete, and entirely zero. Lucida serves it correctly and the
screen goes black.

That is the failure [intention.md](../../intention.md) names: nothing rendered is *wrong*,
but the reading a user takes from it is. Measured on the dataset in #904, every surface
agreed the dataset was fine — the layer's `Detail` control defaults to the finest level, so
the black canvas was the *default* view rather than a deep-zoom edge case; auto-contrast
resolved to a degenerate `0–0` window; and `lucida dataset health` said `healthy`. A user
reads that as "my data is dark". [ADR 0045](0045-tolerant-ome-attribute-placement.md) opened
these stores and explicitly left this consequence unsolved; this is that follow-up.

The hard part is detecting it without paying for it. Proving a level empty means listing its
chunk prefix, and the remote-first open path is exactly what #899/#901 are trying to make
fast. A single-chunk probe is affordable but, on its own, not trustworthy: a legitimately
sparse dataset may have no chunk at the origin either, and a warning that fires on healthy
data is worse than no warning.

Comparing levels is what makes one probe trustworthy. Levels cover the same extent, so
genuinely sparse data is sparse at the same spatial origin on *every* level; a level bare
while its sibling is populated is an export that stopped early. That asymmetry is the
signal, and it costs nothing extra to read — the probes were already being issued. It also
fails safe in the two ways that matter: a store we cannot read accuses nothing, and a
metadata-only store (including most of this repo's own fixtures) stays silent, because
absence everywhere is not evidence of a partial write.

Keeping the level is forced rather than chosen. A level's index doubles as its on-disk
directory name, and every consumer indexes levels positionally, so dropping one silently
misaligns every chunk key after it — trading a visible wrong reading for an invisible one.

Health has to *move*, not merely gain a line. `Degraded` beside a black viewport is the
whole point; a message appended under a `healthy` banner is the same silence with more
words.

## Considered options

**Exhaustively list each level's chunk prefix.** Definitive, and rejected on cost: it is an
unbounded number of requests per level on the path that most needs to be cheap, to answer a
question that is almost always "yes, it's written".

**One `list` request per level with an early stop.** Cheaper than a scan and genuinely
conclusive, unlike a point probe. Rejected because it needs `storage.objects.list`, which a
reader granted only `objects.get` does not have — it would make datasets that open today
start reporting a store error, and lucida's remote users are commonly given exactly that
narrower grant. A HEAD needs no permission the open path does not already use.

**Probe the origin chunk and warn whenever it is absent (no sibling comparison).** The
obvious form, and what the issue first proposed. Rejected: it fires on legitimately sparse
data, and it would have fired on nearly every fixture in this repo's own test suite — a
warning that common is one nobody reads.

**Drop the empty level from the pyramid so the coarser one stays resident.** Attractive
because it fixes the picture rather than describing it. Rejected on the positional-index
hazard above. It also over-reaches: an unwritten level is a defect in the data, and quietly
reshaping the pyramid hides the defect instead of reporting it.

**Detect at serve time by counting fill responses instead of probing at import.** Zero extra
requests, and definitive — the server already distinguishes not-found from data. Rejected
as the primary mechanism because it can only speak *after* the user has stared at a black
screen, and it needs a live channel that does not exist. Worth revisiting as a complement.

**Treat it as purely an export defect and do nothing.** Defensible — the data is broken and
we cannot fix it. Rejected because reporting `healthy` over a blank viewport is our claim,
not the exporter's.

## Consequences

- An open costs one extra HEAD per declared level, issued concurrently, once per geometry.
  Measured on #904's dataset: 4 → 6 metadata reads, no wall-clock regression.
- `ServerBinding` carries typed `ImportWarning`s rather than flattened strings, so health can
  act on a warning's kind. Other warning kinds stay informational and leave status alone.
- `combine_health` became a symmetric worst-of. It previously looked for `Degraded` only in
  its right-hand argument, so a degraded source cache folded against a healthy
  generated-coarse reported `healthy` — a pre-existing hole this decision would have
  inherited.
- A level written *everywhere except* its origin chunk is reported as unwritten. Accepted:
  the message describes what was observed and points at re-export, and the shape is
  vanishingly rare next to the partial export it catches.
- A dataset with exactly one declared level is never checked, since there is no sibling to
  compare against. Accepted: with one level there is no coarser fallback to preserve, and
  the all-fill case is indistinguishable from an empty dataset.
- The absurd-chunk-geometry question #904 also raised — a level whose single chunk
  decompresses to gigabytes — is untouched here.

## Related

- [Tolerant OME attribute placement](0045-tolerant-ome-attribute-placement.md) — opened these
  stores and deferred this consequence
- [Dataset-open reads go through the source cache](0046-dataset-open-reads-through-the-source-cache.md)
  — why the probe goes through `CachedStore` and is counted
- [Debug surface dispositions](0052-debug-surface-dispositions.md) — why `lucida dataset health`
  is the durable surface this reports to
- lucida-store::unwritten — owns the probe and the sibling comparison
- Issue #904
