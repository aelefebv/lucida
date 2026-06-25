---
created: 2026-05-19
modified: 2026-06-25
---

# Generated Coarse

`lucida-server/src/generated.rs` — server-managed derived pyramid levels for datasets that do not already contain a usable source coarse level. Generated coarse is not a proxy asset. It is advertised as a generated multiscale level, requested with the normal `chunk_request` message, and delivered with the normal chunk binary frame.

## Model

The client resolves two chunk tiers:

- **detail** — source-backed only, defaults to the finest selectable source level unless the user explicitly chooses another source level.
- **coarse** — an explicit source coarse level when available; otherwise a generated coarse level planned and owned by the server.

Generated levels are append-only metadata from the client's point of view. The server emits `GeneratedAvailabilityUpdate` (the `ServerMessage` variant) carrying a `GeneratedAvailabilityDelta` payload with level metadata and per-chunk readiness. The client merges those deltas into its generated availability catalog and planning snapshot.

## Serving Contract

Generated coarse chunks use the same request key shape as source chunks: `{level}/{t}/{c}/{z}/{y}/{x}`.

- If bytes are ready, `serve_generated_chunk_request` returns the normal chunk frame: `[client_id u32 LE][key_len u16 LE][dataset/image/key][payload]`.
- If bytes are not ready, the server returns `GeneratedChunkStatus` (`pending`, `failed_transient`, `failed_permanent`, or `unavailable`). The enum has a 5th variant, `Ready(bytes)`, used internally when materialized bytes are available.
- `pending` is not a failure. The CPU cache clears the in-flight request and will re-request on a later submit after readiness changes.

## Materialization

`GeneratedCoarseService` schedules visible, predicted, and background work. Viewer-interest hints can reprioritize queued work and cancel stale running work, so temporal or Z scrubbing does not leave generation stuck behind obsolete chunks.

Generated levels downsample all spatial axes, including Z, so a single-level 3D source still gets a genuinely coarse 3D context level. Generated chunk dimensions are chosen to map roughly to the selected source level's chunk footprint; this avoids one generated chunk forcing a huge multi-chunk source read.

Generated chunks are materialized chunk-locally: the server maps the requested output chunk back to the overlapping source cuboid, fetches only the source chunks that intersect that cuboid, normalizes source samples into the u16 working range, max-pools the region so sparse bright structures survive downsampling, and writes the generated chunk in the source dtype's wire format. This keeps single-level large sources from forcing a full-volume allocation just to satisfy minimap/coarse context.

Missing source Zarr chunks are treated as zero fill on both the normal source chunk path and the generated-source read path. Sparse OME-Zarrs therefore do not turn empty regions into transient fetch failures.

Materialized chunks are written through `DerivedChunkCache`. On-disk writes are atomic, readiness indexes are persisted, and the cache can recover ready chunks on reopen. The generated-cache identity includes the generator version; when materialization semantics change, bumping that version prevents stale persisted failures or bytes from poisoning the new generator. Disk budget eviction withdraws missing ready chunks by publishing an `unavailable` readiness delta.

`GeneratedCoarseService` is tied to a live server binding, not to the durable workspace record. When a live workspace is archived or idle-evicted, the workspace manager calls `shutdown`, which clears queued generated work, wakes worker loops so they exit, persists readiness indexes, and leaves any already materialized derived-cache bytes on disk for later lazy restore.

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

## Related

- [[decisions/0039-chunk-only-coarse-detail-residency]]
- [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- [[decisions/0041-clean-two-source-chunk-tier-renderer]]
- [[planning-domain]]
- [[cpu-cache]]
- [[gpu-residency]]
