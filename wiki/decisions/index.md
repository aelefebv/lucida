---
created: 2026-04-18
modified: 2026-04-18
---

# Decisions

ADR-style records of architectural choices. Each article captures: the decision, the alternatives considered, the reason for the choice, and (where relevant) the date and what would cause us to revisit.

Articles below are **derived from code analysis** unless explicitly marked otherwise — the rationale is reconstructed. If you have authoritative context, run `/repo-wiki-update` to enrich them.

## Articles

- [[document-vs-viewport-split]] — disjoint `DocumentCommand` / `ViewportCommand` enums separate shared/sequenced from local/ephemeral
- [[peer-to-peer-follow-mode]] — anyone can follow anyone; server flattens chains into stars
- [[gpu-on-dedicated-worker]] — all WebGPU runs in `gpu.worker.ts` via `OffscreenCanvas` transfer
- [[multi-pool-atlases]] — proxy atlases keyed by `(dataset, kind, slotDims, channel)` for plate FPS
- [[three-output-import-model]] — `ImportResult` splits manifest, fetch, binding seed by audience
- [[content-source-vs-fetch-source]] — JS-side `ContentSource` wraps wire-side `FetchSource`
- [[wasm-scene-as-source-of-truth]] — Scene state lives in WASM; JS is a thin orchestration layer
- [[cpu-cache-as-sole-fetch-path]] — `SharedChunkQueue` deleted in S5; `CpuCache` is the only path
- [[pull-based-raf-with-typed-dirty]] — RAF loop with `interactiveDirty` (immediate) and `residencyDirty` (33ms throttle)
- [[temporal-runway-not-implemented]] — GPU-side runway not pursued; CPU-side runway + scrubbing eviction is sufficient (2026-04-17)
- [[dual-handoff-on-dataset-opened]] — `DatasetOpened` event splits into WASM `apply_command` and JS `setupFetchPipeline`
- [[logging-conventions]] — `tracing` spans on the server, `bridgeLog` helper on the client, `dot.scope` event names (2026-04-20)
