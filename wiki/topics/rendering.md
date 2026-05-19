---
created: 2026-05-07
modified: 2026-05-19
---

# Topic: Rendering

The chunk pipeline cluster — everything from "the planner decided this chunk is wanted" to "the shader sampled it." Roughly half the wiki by article count, because the renderer is genuinely the largest sub-architecture in Lucida.

This page is a curated index. Articles live in their canonical homes (`systems/`, `decisions/`, `flows/`, `gotchas/`); follow `[[wiki-links]]` for the content.

## Start here

- [[flows/chunk-lifecycle]] — concrete trace from "planner says wanted" → atlas slot → shader sample

## Subsystems

- [[planning-domain]] — wanted-set computation, detail/coarse tier selection, lane-based priority formula
- [[cpu-cache]] — sole chunk fetch path; tiered LRU eviction; decode pool dispatch; drain to GPU
- [[generated-coarse]] — server-managed derived coarse pyramid levels served through normal chunk requests
- [[minimap]] — separate low-resolution spatial context path with its own lane and resources
- [[gpu-residency]] — tiered chunk atlases (slice/volume), indirection, descriptor buffer, semantic fallback chain
- [[worker-protocol]] — typed `postMessage` contract for cold/hot/delta state between main thread and GPU worker
- [[scene-state-and-epochs]] — typed epoch counters drive the tick coordinator's frame fast-path
- [[layout-system]] — registered layouts; placement rebuilds invalidate render dependencies
- [[multichannel-and-colormaps]] — per-channel state, 15 LUTs, composite key naming

## Crate ownership

- [[lucida-web]] — owns the React orchestration layer, the GPU worker, and the renderer
- [[lucida-core]] — owns the Scene model and command vocabulary that drive what gets rendered (shared with server, CLI, Python)

## Why decisions were made

- [[decisions/0003-gpu-on-dedicated-worker]] — all WebGPU runs in `gpu.worker.ts` via `OffscreenCanvas` transfer
- [[decisions/0004-multi-pool-atlases]] — historical proxy atlases keyed by `(dataset, kind, slotDims, channel)` for plate FPS
- [[decisions/0007-wasm-scene-as-source-of-truth]] — Scene state lives in WASM; JS is a thin orchestration layer
- [[decisions/0008-cpu-cache-as-sole-fetch-path]] — `SharedChunkQueue` deleted; `CpuCache` is the only path
- [[decisions/0009-pull-based-raf-with-typed-dirty]] — RAF loop with `interactiveDirty` (immediate) and `residencyDirty` (33ms throttle)
- [[decisions/0010-temporal-runway-not-implemented]] — GPU-side runway not pursued; CPU-side runway + scrubbing eviction is sufficient
- [[decisions/0039-chunk-only-coarse-detail-residency]] — fallback/residency becomes explicit `detail` and `coarse` chunk tiers
- [[decisions/0040-generated-coarse-as-derived-pyramid-levels]] — generated coarse levels are derived pyramid levels served through the chunk path
- [[decisions/0041-clean-two-source-chunk-tier-renderer]] — renderer binds explicit detail/coarse tier sources

## Cross-cutting flows

- [[flows/chunk-lifecycle]] — planner decides "wanted" → CPU cache fetch+decode → GPU upload → atlas write → indirection → shader render
- [[flows/proxy-generation]] — historical opt-in proxy bridge; default fallback is chunk-only coarse/detail

## Gotchas hit while working in this area

- [[gotchas/upload-budgets-per-frame]] — 16 MB main view, 2 MB minimap; non-linear behavior at limits
- [[gotchas/worker-eviction-async-reporting]] — worker posts `chunksEvicted` async; main-thread send-tracking must reconcile
- [[gotchas/minimap-render-key]] — minimap skips render when key matches; new visual inputs must extend the key
- [[gotchas/proxy-priority-not-honored]] — historical proxy bridge gotcha
- [[gotchas/app-tsx-hook-order]] — App.tsx hook order is load-bearing; callback refs break circular deps
- [[gotchas/wasm-rebuild-after-rust-changes]] — `npm run build:wasm` is the second half of every Rust change that touches Scene
