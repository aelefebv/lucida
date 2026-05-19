---
created: 2026-05-19
modified: 2026-05-19
---

# Generated Coarse

`lucida-server/src/generated.rs` — server-managed derived pyramid levels for datasets that do not already contain a usable source coarse level. Generated coarse is not a proxy asset. It is advertised as a generated multiscale level, requested with the normal `chunk_request` message, and delivered with the normal chunk binary frame.

## Model

The client resolves two chunk tiers:

- **detail** — source-backed only, defaults to the finest selectable source level unless the user explicitly chooses another source level.
- **coarse** — an explicit source coarse level when available; otherwise a generated coarse level planned and owned by the server.

Generated levels are append-only metadata from the client's point of view. The server emits `GeneratedAvailabilityUpdate` deltas with level metadata and per-chunk readiness. The client merges those deltas into its generated availability catalog and planning snapshot.

## Serving Contract

Generated coarse chunks use the same request key shape as source chunks: `{level}/{t}/{c}/{z}/{y}/{x}`.

- If bytes are ready, `serve_generated_chunk_request` returns the normal chunk frame: `[client_id u32 LE][key_len u16 LE][dataset/image/key][payload]`.
- If bytes are not ready, the server returns `GeneratedChunkStatus` (`pending`, `failed_transient`, `failed_permanent`, or `unavailable`).
- `pending` is not a failure. The CPU cache clears the in-flight request and will re-request on a later submit after readiness changes.

## Materialization

`GeneratedCoarseService` schedules visible, predicted, and background work. Viewer-interest hints can reprioritize queued work and cancel stale running work, so temporal or Z scrubbing does not leave generation stuck behind obsolete chunks.

Materialized chunks are written through `DerivedChunkCache`. On-disk writes are atomic, readiness indexes are persisted, and the cache can recover ready chunks on reopen. Disk budget eviction withdraws missing ready chunks by publishing an `unavailable` readiness delta.

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
