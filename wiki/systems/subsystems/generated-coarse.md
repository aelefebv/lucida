---
type: Subsystem
title: "Generated Coarse"
description: "lucida-server/src/generated_coarse/ — server-managed derived pyramid levels for datasets that do not already contain a usable source coarse level."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/generated-coarse.md
created: 2026-05-19
modified: 2026-07-17
---

# Generated Coarse

`lucida-server/src/generated_coarse/` owns server-managed derived pyramid levels for datasets that do not already contain a usable source coarse level. The directory makes the implementation's five runtime boundaries explicit: `planning.rs`, `scheduler.rs`, `cache.rs`, `materialize.rs`, and `availability.rs`. Generated coarse is not a proxy asset. It is advertised as a generated multiscale level, requested with the normal `chunk_request` message, and delivered with the normal chunk binary frame.

## Model

The client resolves two chunk tiers:

- **detail** — source-backed only, defaults to the finest selectable source level unless the user explicitly chooses another source level.
- **coarse** — an explicit source coarse level when available; otherwise a generated coarse level planned and owned by the server.

Generated levels are append-only metadata from the client's point of view. The server emits `GeneratedAvailabilityUpdate` (the `ServerMessage` variant) carrying a `GeneratedAvailabilityDelta` payload with level metadata and per-chunk readiness. The client merges those deltas into its generated availability catalog and planning snapshot.

## Serving Contract

Generated coarse chunks use the same request key shape as source chunks: `{level}/{t}/{c}/{z}/{y}/{x}`.

- If bytes are ready, `serve_generated_chunk_request` returns the normal chunk frame: `[client_id u32 LE][key_len u16 LE][dataset/image/key][payload]`.
- If bytes are not ready, the server returns `GeneratedChunkStatus` (`pending`, `failed_transient`, `failed_permanent`, or `unavailable`). `GeneratedChunkStatus` (in [lucida-protocol](../crates/lucida-protocol.md) `generated_coarse.rs`) is five **unit** variants — the fifth is `Ready`, which carries no payload; it only signals that bytes exist. The materialized bytes themselves ride a *different*, server-only enum: `DerivedChunkLookup::Ready(GeneratedReadyBytes)` (`lucida-server/src/generated_coarse/cache.rs`), which `serve_generated_chunk_request` matches on to emit the chunk frame. Don't conflate the two.
- `pending` is not a failure. The CPU cache clears the in-flight request and will re-request on a later submit after readiness changes.

## Materialization

`GeneratedCoarseService` schedules visible, predicted, and background work. Viewer-interest hints can reprioritize queued work and cancel stale running work, so temporal or Z scrubbing does not leave generation stuck behind obsolete chunks.

Generated levels downsample all spatial axes, including Z, so a single-level 3D source still gets a genuinely coarse 3D context level. Generated chunk dimensions are chosen to map roughly to the selected source level's chunk footprint; this avoids one generated chunk forcing a huge multi-chunk source read.

Generated chunks are materialized chunk-locally: the server maps the requested output chunk back to the overlapping source cuboid, fetches only the source chunks that intersect that cuboid, normalizes source samples into the u16 working range, max-pools the region so sparse bright structures survive downsampling, and writes the generated chunk in the source dtype's wire format. This keeps single-level large sources from forcing a full-volume allocation just to satisfy minimap/coarse context.

Missing source Zarr chunks are treated as zero fill on both the normal source chunk path and the generated-source read path. Sparse OME-Zarrs therefore do not turn empty regions into transient fetch failures.

Materialized chunks are written through `DerivedChunkCache`. On-disk writes are atomic; the temporary-file guard owns the open handle so cleanup closes it before unlinking (including on Windows). Readiness indexes are persisted and can recover ready chunks on reopen. The runtime status index remains capped, but a canonical key beyond that cap is still served and scheduler-deduplicated by an exact-size disk lookup using bounded per-level identity and expected-byte metadata. The cache never learns an expected length from the file it is validating.

Level and chunk-status cardinality are also capped across all `DerivedChunkCache` instances owned by one workspace manager, rather than granting the full limit to every loaded dataset. Cache-state permits make existing-key transitions free and release capacity only when the last clone of the shared cache state is dropped. A valid exact-size disk chunk remains directly servable when no status slot is available. If the cache root is unwritable and the cache has fallen back to memory only, the same denial returns explicit resource backpressure instead of acknowledging and discarding ready bytes.

All revision scopes under one generated-cache root share a physical-resource ledger. Generation defaults on, and the root has one explicit 8 GiB default (`LUCIDA_GENERATED_COARSE_DISK_BUDGET_BYTES=8589934592`); omitting the override never creates an unbounded disk cache. The byte charge uses allocated blocks on Unix and conservatively charges at least 4 KiB per file or directory on every platform. A root-global 100,000-entry ceiling independently bounds inode/directory pressure, so many tiny incremental-status files cannot hide below the byte budget. Normal writes update exact file and newly-created-directory deltas in O(1); startup and explicit reconciliation use the same accounting primitive. Dataset cache-health payloads expose charged bytes, filesystem entries, and both ceilings. An eviction or enforcement failure latches that coordinator unhealthy, rejects later mutations before they reach disk, and surfaces `accounting_healthy: false` instead of reporting a zero-byte memory cache. Recovery is explicit: `reconcile_disk_accounting` rescans and fully enforces both limits before reopening writes, avoiding a rescan storm on every failed request. Resource eviction withdraws missing ready chunks by publishing an `unavailable` readiness delta.

The active generated root and the retired proxy root are separate configuration values. `LUCIDA_GENERATED_COARSE_CACHE_DIR` receives all new writes; deprecated `LUCIDA_PROXY_CACHE_DIR` is read only by the compatibility-named `clear-proxy-cache` CLI/admin operation so upgrades can remove old `.../proxies` or `/var/lib/lucida/proxy-cache` artifacts. Cleanup covers both roots, deduplicates equal roots, rejects parent/child overlap before mutation, and never deletes the SQLite file.

The generated-cache identity includes the generator version; when materialization semantics change, bumping that version prevents stale persisted failures or bytes from poisoning the new generator.

`GeneratedCoarseService` is tied to a live server binding, not to the durable workspace record. When a live workspace is archived or idle-evicted, the workspace manager calls `shutdown`, which clears queued generated work, wakes worker loops so they exit, persists readiness indexes, and leaves any already materialized derived-cache bytes on disk for later lazy restore. A source-revision replacement first persists the staged document, then aborts and joins the old service under the session lock, and only then resets availability and swaps the binding. Generated deltas also carry an implicit cache-generation identity: session state and broadcasts accept them only when the publisher's `DerivedChunkCache` is pointer-identical to the current binding. A failed persistence attempt therefore leaves the old service live, while a late old-generation publisher is rejected after a successful swap.

## Interactions

- **Planning** reads generated level metadata as coarse-only. Generated levels are excluded from detail override options and stale detail overrides clamp to source levels.
- **CPU cache** treats generated `pending` as non-failure and generated ready bytes like any other chunk.
- **GPU residency** receives generated coarse bytes as `tier: "coarse"` chunk uploads. Mismatched detail/coarse chunk shapes become separate atlas pools.
- **Debug UI** surfaces generated readiness counts, derived-cache telemetry, and sparse-detail notices so users can understand why only a few large high-resolution chunks are visible.

## Invariants

- Generated coarse never mutates source storage.
- Generated coarse is served through the chunk path, not the proxy path.
- A generated level may be selected as coarse, never as detail.
- Ready metadata must agree with bytes on disk; missing ready bytes are withdrawn with an availability delta.
- A failed root-ledger enforcement closes generated-cache writes until explicit reconciliation succeeds.
- Every disk-backed generated cache has an effective finite byte ceiling; no library or CLI default is unbounded.
- Runtime status caps bound retained identities, not the ability to serve validated derived bytes already on disk.
- Generated level and chunk-status caps are aggregate across a manager's caches and the session snapshot, not per dataset.
- Only the current binding's cache generation may publish generated availability into session state.

## Related

- [Chunk-only coarse/detail residency](../../decisions/0039-chunk-only-coarse-detail-residency.md)
- [Generated coarse as derived pyramid levels](../../decisions/0040-generated-coarse-as-derived-pyramid-levels.md)
- [Clean two-source chunk-tier renderer](../../decisions/0041-clean-two-source-chunk-tier-renderer.md)
- [Planning Domain](planning-domain.md)
- [CPU Cache](cpu-cache.md)
- [GPU Residency](gpu-residency.md)
