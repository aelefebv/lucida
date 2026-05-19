---
created: 2026-05-07
modified: 2026-05-19
---

# Topic: Storage and Import

How datasets get from a user-pasted URL to a planning-domain-ready manifest. Covers the storage abstraction, the OME-Zarr import pipeline, the three-way split of import outputs (manifest / fetch / binding seed), and the wire envelope.

This page is a curated index. Articles live in their canonical homes; follow `[[wiki-links]]` for the content.

## Start here

- [[lucida-store]] — storage abstraction over `object_store`; OME-Zarr import producing the three-output `ImportResult`
- [[flows/dataset-opening]] — concrete trace: user pastes URL → server import → `DatasetOpened` broadcast → WASM ingest + JS fetch pipeline → first chunks render

## Crate ownership

- [[lucida-store]] — import pipeline, codec abstraction, server-side chunk serving (per the in-flight redesign in PRD #148)
- [[generated-coarse]] — server-managed derived coarse pyramid levels cached outside source storage
- [[lucida-proxy]] — historical/legacy pure-compute proxy generation; no I/O, no async
- [[lucida-protocol]] — wire types: `DatasetOpened`, `FetchSource`, `AssetCatalog`, `AssetMessage`
- [[lucida-content]] — pure data model for `DatasetManifest` (entities, transforms, images, layouts)

## Why decisions were made

- [[decisions/0005-three-output-import-model]] — `ImportResult` splits manifest, fetch, binding seed by audience (which client/server gets what)
- [[decisions/0006-content-source-vs-fetch-source]] — JS-side `ContentSource` wraps wire-side `FetchSource`; don't conflate them
- [[decisions/0011-dual-handoff-on-dataset-opened]] — `DatasetOpened` event splits into WASM `apply_command` and JS `setupFetchPipeline`

## Cross-cutting flow

- [[flows/dataset-opening]] — full trace from URL paste through first chunks rendered

## Gotchas hit while working in this area

- [[gotchas/wire-chunk-key-conventions]] — wire chunk keys split asymmetrically: `t/c` are voxel coords, `z/y/x` are chunk-grid coords. The divide-and-slice for `t/c` happens server-side
- [[gotchas/non-canonical-axes]] — OME-Zarr axes outside `{t,c,z,y,x}` (e.g. CZI `m` mosaic) are silently pinned to index 0; only the first slice is visible
- [[gotchas/blosc-support]] — Blosc decoder supports a deliberately narrow subset (Blosc1 + zstd inner + typesize ∈ {1,2,4}); everything else is rejected at import time
- [[gotchas/stage-translations-are-microns]] — OME-Zarr stores stage positions in microns; `lucida-store` converts to voxels at import
