---
type: Topic
title: "Topic: Storage and Import"
description: "How datasets get from a user-pasted URL to a planning-domain-ready manifest."
tags: [lucida, topic]
source_path: wiki/topics/storage-and-import.md
created: 2026-05-07
modified: 2026-07-06
---

# Topic: Storage and Import

How datasets get from a user-pasted URL to a planning-domain-ready manifest. Covers the storage abstraction, the OME-Zarr import pipeline, the three-way split of import outputs (manifest / fetch / binding seed), and the wire envelope.

This page is a curated index. Articles live in their canonical homes; follow the links for the content.

## Start here

- [lucida-store](../systems/crates/lucida-store.md) — storage abstraction over `object_store`; OME-Zarr import producing the three-output `ImportResult`
- [Flow: Dataset Opening](../flows/dataset-opening.md) — concrete trace: user pastes URL → server import → `DatasetOpened` broadcast → WASM ingest + JS fetch pipeline → first chunks render

## Crate ownership

- [lucida-store](../systems/crates/lucida-store.md) — import pipeline, codec abstraction, server-side chunk serving, storage backend routing, and server-private binding seeds
- [Generated Coarse](../systems/subsystems/generated-coarse.md) — server-managed derived coarse pyramid levels cached outside source storage
- [lucida-proxy](../systems/crates/lucida-proxy.md) — opt-in/non-default pure-compute proxy generation (still compiled and wired); no I/O, no async
- [lucida-protocol](../systems/crates/lucida-protocol.md) — wire types: `DatasetOpened`, `FetchSource`, `AssetCatalog`, `AssetMessage`
- [lucida-content](../systems/crates/lucida-content.md) — pure data model for `DatasetManifest` (entities, transforms, images, layouts)

## Why decisions were made

- [Three-Output Import Model](../decisions/0005-three-output-import-model.md) — `ImportResult` splits manifest, fetch, binding seed by audience (which client/server gets what)
- [ContentSource (JS) vs FetchSource (wire)](../decisions/0006-content-source-vs-fetch-source.md) — JS-side `ContentSource` wraps wire-side `FetchSource`; don't conflate them
- [Dual Hand-off on DatasetOpened (WASM + JS)](../decisions/0011-dual-handoff-on-dataset-opened.md) — `DatasetOpened` event splits into WASM `apply_command` and JS `setupFetchPipeline`
- [Canonical dataset URL form](../decisions/0042-canonical-dataset-url-form.md) — one string-level URL normalization governs `DatasetId` hashing, proxy-cache naming, and wire-vs-display form (`lucida-content::url`)

## Cross-cutting flows

- [Flow: Dataset Opening](../flows/dataset-opening.md) — full trace from URL paste through first chunks rendered
- [Flow: Dataset Diagnostics](../flows/dataset-diagnostics.md) — `backend::open` failure-category trace; the cross-surface model for import/open failures

## Gotchas hit while working in this area

- [Wire chunk keys: t/c are voxel coords, z/y/x are chunk-grid coords](../gotchas/wire-chunk-key-conventions.md) — wire chunk keys split asymmetrically: `t/c` are voxel coords, `z/y/x` are chunk-grid coords. The divide-and-slice for `t/c` happens server-side
- [Non-canonical axes are pinned to index 0](../gotchas/non-canonical-axes.md) — OME-Zarr axes outside `{t,c,z,y,x}` (e.g. CZI `m` mosaic) are silently pinned to index 0; only the first slice is visible
- [Blosc support is a deliberately narrow subset](../gotchas/blosc-support.md) — Blosc decoder supports a deliberately narrow subset (Blosc1 + zstd inner + typesize ∈ {1,2,4}); everything else is rejected at import time
- [Explicit Translations Are in Physical Units; Lucida Composes in Voxels](../gotchas/stage-translations-are-microns.md) — OME-Zarr stores explicit tile translations in physical units; `lucida-store` converts to voxels at import
