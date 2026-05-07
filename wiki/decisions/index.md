---
created: 2026-04-18
modified: 2026-05-07
---

# Decisions

ADR-style records of architectural choices. Numbered sequentially in the order they were captured. Each ADR records *that* a decision was made and *why* — not a fully-templated breakdown. Optional `Status` / `Considered Options` / `Consequences` sections appear only when they add genuine value.

Most articles below were originally seeded by reading the code (rationale reconstructed). Where a decision has subsequently been confirmed, refined, or extended via authoritative source material or a maintainer interview, the article notes that.

## Articles

- [[decisions/0001-document-vs-viewport-split]] — disjoint `DocumentCommand` / `ViewportCommand` enums separate shared/sequenced from local/ephemeral
- [[decisions/0002-peer-to-peer-follow-mode]] — anyone can follow anyone; server flattens chains into stars
- [[decisions/0003-gpu-on-dedicated-worker]] — all WebGPU runs in `gpu.worker.ts` via `OffscreenCanvas` transfer
- [[decisions/0004-multi-pool-atlases]] — proxy atlases keyed by `(dataset, kind, slotDims, channel)` for plate FPS
- [[decisions/0005-three-output-import-model]] — `ImportResult` splits manifest, fetch, binding seed by audience
- [[decisions/0006-content-source-vs-fetch-source]] — JS-side `ContentSource` wraps wire-side `FetchSource`
- [[decisions/0007-wasm-scene-as-source-of-truth]] — Scene state lives in WASM; JS is a thin orchestration layer
- [[decisions/0008-cpu-cache-as-sole-fetch-path]] — `SharedChunkQueue` deleted in S5; `CpuCache` is the only path
- [[decisions/0009-pull-based-raf-with-typed-dirty]] — RAF loop with `interactiveDirty` (immediate) and `residencyDirty` (33ms throttle)
- [[decisions/0010-temporal-runway-not-implemented]] — GPU-side runway not pursued; CPU-side runway + scrubbing eviction is sufficient (2026-04-17)
- [[decisions/0011-dual-handoff-on-dataset-opened]] — `DatasetOpened` event splits into WASM `apply_command` and JS `setupFetchPipeline`
- [[decisions/0012-logging-conventions]] — `tracing` spans on the server, `bridgeLog` helper on the client, `dot.scope` event names (2026-04-20)
