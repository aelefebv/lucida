---
type: Subsystem
title: "Collection Admission and Label Discovery"
description: "Strict, bounded collection metadata admission and the explicit completeness trade-off for label discovery."
tags: [lucida, subsystem, ingestion, labels]
source_path: wiki/systems/subsystems/collection-admission-and-label-discovery.md
created: 2026-07-16
modified: 2026-07-16
---

# Collection Admission and Label Discovery

Opening a collection has two different jobs with different correctness requirements:

1. Admit every declared tile's image geometry, dtype, codecs, axes, and chunk layout.
2. Discover optional OME-Zarr label groups, which can require an extra metadata request for every tile.

Lucida treats the first job as strict and the second as an explicit, observable performance trade-off. They share bounded scheduling, but label sampling can never make an invalid image tile look valid.

## Strict tile admission

`lucida-store::import` reads metadata for every declared tile with at most 32 object-store requests in flight. Completion may be out of order; assembly, error examples, and retained label order always follow declaration order.

Every tile is checked independently for:

- raw axis names, shapes, and chunk shapes, including axes later pinned away;
- compatible multiscale level structure and positive finite scales;
- supported dtype and codec chain;
- exact structural agreement where a collection requires shared geometry;
- bounded decoded and canonical chunk byte sizes.

An unreadable or incompatible tile rejects collection admission with bounded, named examples. Lucida does not clone the first readable tile's geometry onto other entries.

## Label-index discovery

Small collections probe every tile's `labels/zarr.json`. On a wide collection, sampling engages only when it avoids at least 64 metadata reads. The sample is deterministic: the first and last tile of each declared group.

A sampled group expands to all its tiles when either sample lists labels. An unusable sample—an error, malformed JSON, or an index with no usable names—is treated as suspicious, but full expansion is capped at four costly groups per import. This prevents a store-wide permission or throttling failure from recreating unbounded fan-out. The import returns one aggregated `UnusableLabelIndex` warning with example paths.

Sampling accepts one limitation: labels that exist only on unsampled interior tiles of an otherwise clean group are not discovered. Any import that leaves tiles unprobed returns a warning naming the completeness override:

```text
LUCIDA_EXHAUSTIVE_LABEL_DISCOVERY=1
```

Set it before starting the server or importer to probe every tile. Values other than an empty string or `0` enable the override.

## Retention budget

Index probing holds names only. Per-label multiscale metadata and color tables are read later, sequentially, against one budget shared across the whole dataset:

- 65,536 retained labels;
- 1,048,576 retained color entries.

Once the label budget is exhausted, later labels are not read or built. A label whose color table exceeds the remaining color budget is retained with its colors truncated to the remaining allowance. This keeps peak label memory and label-specific I/O proportional to the admitted budget rather than the collection's tile count.

## Verification

The store suite covers the exhaustive/sampled threshold, forced exhaustive discovery, interior-label expansion, unusable-index caps, deterministic diagnostics, and a cross-tile regression proving the label budget is collection-wide.

See also [lucida-store](../crates/lucida-store.md) and [Dataset Opening](../../flows/dataset-opening.md).
