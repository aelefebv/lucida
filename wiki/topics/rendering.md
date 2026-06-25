---
type: Topic
title: "Topic: Rendering"
description: "The chunk pipeline cluster — everything from \"the planner decided this chunk is wanted\" to \"the shader sampled it.\" Roughly half the wiki by article count, because the renderer is genuinely the largest sub-architectur…"
tags: [lucida, topic]
source_path: wiki/topics/rendering.md
created: 2026-05-07
modified: 2026-06-25
---

# Topic: Rendering

The chunk pipeline cluster — everything from "the planner decided this chunk is wanted" to "the shader sampled it." Roughly half the wiki by article count, because the renderer is genuinely the largest sub-architecture in Lucida.

This page is a curated index. Articles live in their canonical homes (`systems/`, `decisions/`, `flows/`, `gotchas/`); follow the links for the content.

## Start here

- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md) — concrete trace from "planner says wanted" → atlas slot → shader sample

## Subsystems

- [Planning Domain](../systems/subsystems/planning-domain.md) — wanted-set computation, detail/coarse tier selection, lane-based priority formula
- [CPU Cache](../systems/subsystems/cpu-cache.md) — sole chunk fetch path; tiered LRU eviction; decode pool dispatch; drain to GPU
- [Generated Coarse](../systems/subsystems/generated-coarse.md) — server-managed derived coarse pyramid levels served through normal chunk requests
- [Minimap](../systems/subsystems/minimap.md) — separate low-resolution spatial context path with its own lane and resources
- [GPU Residency](../systems/subsystems/gpu-residency.md) — tiered chunk atlases (slice/volume), indirection, descriptor buffer, semantic fallback chain
- [Upload Pipeline](../systems/subsystems/upload-pipeline.md) — the CPU → GPU hand-off half of the pipeline (`pipeline/upload/`), split out from the former orchestrator
- [Worker Protocol](../systems/subsystems/worker-protocol.md) — typed `postMessage` contract for cold/hot/delta state between main thread and GPU worker
- [Scene State and Epochs](../systems/subsystems/scene-state-and-epochs.md) — typed epoch counters drive the tick coordinator's frame fast-path
- [Layout System](../systems/subsystems/layout-system.md) — registered layouts; placement rebuilds invalidate render dependencies
- [Multi-Channel and Colormaps](../systems/subsystems/multichannel-and-colormaps.md) — per-channel state, 15 LUTs, composite key naming

## Crate ownership

- [lucida-web](../systems/crates/lucida-web.md) — owns the React orchestration layer, the GPU worker, and the renderer
- [lucida-core](../systems/crates/lucida-core.md) — owns the Scene model and command vocabulary that drive what gets rendered (shared with server, CLI, Python)

## Why decisions were made

- [All GPU Work on a Dedicated Web Worker](../decisions/0003-gpu-on-dedicated-worker.md) — all WebGPU runs in `gpu.worker.ts` via `OffscreenCanvas` transfer
- [Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)](../decisions/0004-multi-pool-atlases.md) — opt-in proxy atlases keyed by `(dataset, kind, slotDims, channel)` for plate FPS
- [WASM Scene as Source of Truth](../decisions/0007-wasm-scene-as-source-of-truth.md) — Scene state lives in WASM; JS is a thin orchestration layer
- [CpuCache as Sole Fetch Path](../decisions/0008-cpu-cache-as-sole-fetch-path.md) — `SharedChunkQueue` deleted; `CpuCache` is the only path
- [Pull-Based RAF Render Loop with Typed Dirty Flags](../decisions/0009-pull-based-raf-with-typed-dirty.md) — RAF loop with `interactiveDirty` (immediate) and `residencyDirty` (33ms throttle)
- [GPU-Side Temporal Lookahead — Won't Implement](../decisions/0010-temporal-runway-not-implemented.md) — GPU-side runway not pursued; CPU-side runway + scrubbing eviction is sufficient
- [Chunk-only coarse/detail residency](../decisions/0039-chunk-only-coarse-detail-residency.md) — fallback/residency becomes explicit `detail` and `coarse` chunk tiers
- [Generated coarse as derived pyramid levels](../decisions/0040-generated-coarse-as-derived-pyramid-levels.md) — generated coarse levels are derived pyramid levels served through the chunk path
- [Clean two-source chunk-tier renderer](../decisions/0041-clean-two-source-chunk-tier-renderer.md) — renderer binds explicit detail/coarse tier sources

### Rendering-refactor band (0023–0038)

- [Minimap Lane with Highest Priority](../decisions/0023-minimap-lane-with-highest-priority.md) — minimap gets its own highest-priority lane in the planner
- [Catalog Degradation Steps One Tier at a Time](../decisions/0024-catalog-degrade-one-tier-at-a-time.md) — catalog degradation steps down one tier at a time
- [`cpuCache.ts` split into `pipeline/fetch/` modules](../decisions/0032-cpucache-split-into-pipeline-fetch.md) — `cpuCache.ts` split into `pipeline/fetch/` modules
- [Typed `FetchError` + injectable `RetryPolicy` at the fetch boundary](../decisions/0033-typed-fetch-error.md) — typed `FetchError` + injectable `RetryPolicy` at the fetch boundary
- [`orchestrator.ts` split into `pipeline/upload/` modules](../decisions/0034-orchestrator-split-into-pipeline-upload.md) — `orchestrator.ts` split into `pipeline/upload/` modules
- [`gpu.worker.ts` split into `renderer/` subdirectories](../decisions/0035-gpu-worker-split-into-renderer-subdirectories.md) — `gpu.worker.ts` split into `renderer/` subdirectories
- [Descriptor byte-layout single source of truth + WGSL ↔ TS lock test](../decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test.md) — descriptor byte-layout single source of truth + WGSL ↔ TS lock test
- [Delivery state as a CpuCache sidecar](../decisions/0037-delivery-state-as-cpucache-sidecar.md) — delivery state moves to a CpuCache sidecar
- [Budgeted proxy GPU residency](../decisions/0038-budgeted-proxy-gpu-residency.md) — budgeted GPU residency for proxy chunks

## Cross-cutting flows

- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md) — planner decides "wanted" → CPU cache fetch+decode → GPU upload → atlas write → indirection → shader render
- [Flow: Proxy Generation (S5)](../flows/proxy-generation.md) — opt-in/non-default proxy bridge (still compiled and wired); the default fallback is chunk-only coarse/detail

## Gotchas hit while working in this area

- [Upload Budgets Are Per-Frame and Per-Path](../gotchas/upload-budgets-per-frame.md) — 16 MB main view, 2 MB minimap; non-linear behavior at limits
- [Worker Eviction Reporting Is Async](../gotchas/worker-eviction-async-reporting.md) — worker posts `chunksEvicted` async; main-thread send-tracking must reconcile
- [Minimap Skip-When-Stationary via Render Key](../gotchas/minimap-render-key.md) — minimap skips render when key matches; new visual inputs must extend the key
- [Proxy Generator Priority Is Not Honored Yet](../gotchas/proxy-priority-not-honored.md) — opt-in/non-default proxy bridge gotcha
- [App.tsx Hook Order and Callback Refs](../gotchas/app-tsx-hook-order.md) — App.tsx hook order is load-bearing; callback refs break circular deps
- [WASM Rebuild After Rust Changes](../gotchas/wasm-rebuild-after-rust-changes.md) — `npm run build:wasm` is the second half of every Rust change that touches Scene
