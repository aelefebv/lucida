---
type: Decision
title: "Tolerant OME attribute placement"
description: "The metadata reader accepts OME blocks at both attributes.ome.<block> and attributes.<block>, never mixing the two, and explains what it looked for when neither is present."
tags: [lucida, decision]
source_path: wiki/decisions/0044-tolerant-ome-attribute-placement.md
created: 2026-08-09
modified: 2026-08-09
---

# Tolerant OME attribute placement

Status: Accepted (issue #903).

## Decision

Lucida reads every OME metadata block (`multiscales`, `omero`, `labels`, `image-label`,
`plate`, `well`) from either of two places in a Zarr v3 group's `zarr.json`:

- `attributes.ome.<block>` — the OME-Zarr 0.5 namespaced placement, and
- `attributes.<block>` — the top-level placement inherited from the 0.4 conventions.

The two are **never mixed**. When `attributes.ome` is present and is an object, it is the
sole source; a stray same-named top-level key can never silently satisfy a block for a
conformant 0.5 group. Only when the namespace is absent — or is present but not an object,
e.g. a bare version string — does the reader fall back to the top level. Resolution is one
helper in `lucida-store::parse`; no call site chooses a placement for itself.

Lucida remains **Zarr v3 only**. This decision is about where OME attributes sit inside a
v3 `zarr.json`, not about reading Zarr v2 stores (`.zattrs` / `.zarray`), which stays
unsupported.

When a block is absent from both placements, the error names both spellings that were
checked and lists the attribute keys the group actually carries — or says the path is a
Zarr array and points at the parent group.

## Why

OME-Zarr 0.5 introduced the `ome` namespace at the same time as the move to Zarr v3, but
the two changes reached writers at different speeds. Real stores exist that are valid Zarr
v3 and carry `attributes.multiscales` with `"version": "0.4"` inside — a shape that is
strictly conformant to neither revision, yet completely unambiguous to read.

Refusing those stores buys nothing. The placement carries no information: the same keys,
the same sub-schemas, one level of nesting apart. A viewer that can obviously read the
metadata and declines to on a technicality fails the [runs-anywhere-and-open](../principles/runs-anywhere-and-open.md)
promise — the user's response is to rewrite metadata to satisfy us, which is work we
imposed rather than work the format required.

Crucially, tolerance here is cheap because nothing downstream had to bend. The store that
prompted this carries seven axes; the two non-canonical ones were already pinned by the
existing axis classifier, and its chunk layout was already accepted by the existing
byte-layout rule. The placement was the whole of the gap.

The no-mixing rule is what keeps tolerance from costing correctness. Reading each block
independently from whichever placement happens to have it would let a 0.5 group silently
pick up a stale top-level `multiscales` left behind by a converter — exactly the
"wrong-but-plausible metadata" failure the [viewer's correctness-first bar](../../intention.md)
forbids. Choosing the *namespace*, not the *block*, keeps each group's metadata internally
consistent.

## Considered options

**Read only the 0.5 namespaced placement (the prior behavior).** Rejected: it turns a
readable store into an unopenable one, and the diagnosis ("no ome.multiscales") named an
internal pointer rather than anything a user could act on. Defensible as a spec-purity
stance, but lucida is a viewer, not a validator — a store we can read correctly, we should.

**Fall back per block rather than per namespace.** Simpler to write and more permissive.
Rejected for the mixing hazard above: a group half-migrated to 0.5 would be read from both
revisions at once, with no signal that it happened. Per-namespace resolution costs one
extra lookup and removes the failure mode entirely.

**Detect the revision from the declared `version` string and branch on it.** Rejected
because the version field is exactly what these stores get wrong — the one in question
declares `"0.4"` inside a Zarr v3 group. Trusting a self-report to decide how to read the
document that contains it inverts the reliable and unreliable signals. Structure is
observable; the version claim is not trustworthy.

**Accept the store but reject it later, when the placement implies an unsupported
feature.** Rejected as speculative: no such feature exists. The 0.4-style placement does
not imply 0.4 semantics for anything lucida consumes.

## Consequences

- Stores that pair Zarr v3 with the 0.4-style attribute placement open, including
  collections (`plate` / `well`), labels, and channel display metadata.
- Conformant 0.5 stores are unaffected: the namespace still wins whenever it exists.
- A group carrying non-OME top-level attributes named `plate` or `multiscales` would now
  be read as OME metadata. Accepted: those keys are OME-defined, and the alternative
  (namespace-only) has the larger, demonstrated cost.
- Opening a store is no longer evidence its pyramid has data. The store that prompted this
  declares a level 0 with no chunks written; lucida will render it as fill value, which is
  correct Zarr semantics and a defect in the data. Surfacing empty levels is a separate
  concern, not solved here.
- The 0.4-style placement is **read, not written**. Lucida's own writer continues to emit
  the 0.5 namespaced form.

## Related

- [Runs anywhere and open](../principles/runs-anywhere-and-open.md) — the promise this serves
- lucida-store::parse — owns placement resolution and the missing-block diagnostic
- Issue #903
