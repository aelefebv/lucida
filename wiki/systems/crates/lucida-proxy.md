---
type: Crate
title: "lucida-proxy"
description: "using source or generated pyramid levels (coarseDetailEnabled defaults true);"
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-proxy.md
created: 2026-04-18
modified: 2026-06-25
---

# lucida-proxy

Status: Fallback path, still wired. The default model is chunk-only coarse/detail
using source or generated pyramid levels (`coarseDetailEnabled` defaults true);
this crate stays wired as the proxy fallback when that path can't serve.

Pure-compute proxy generation. Given a `DatasetManifest` plus caller-supplied source-volume bytes, produces a `ProxyAsset` — a small low-resolution placeholder volume that stands in for either a single field's downsampled image (`FieldProxy3D`) or an aggregated well composed of many fields (`WellProxy3D`).

This crate has **no I/O and no async**. Storage, fetching, and caching live in [lucida-server](lucida-server.md)'s `proxy/` module. The split is deliberate — see below.

## Why proxies exist

When a plate dataset zooms out so a single well projects to ≤80 screen pixels, fetching every field's detail chunks is wasted bandwidth. The renderer instead asks for one `WellProxy3D` per visible channel, gets back a coarse aggregate, and draws that. As the user zooms in, planning crosses the next threshold and switches to per-field detail. The proxy fills the gap between "no data yet" and "full detail" without making the renderer wait.

See [Planning Domain](../subsystems/planning-domain.md) for the threshold logic and [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md) for the end-to-end flow.

## Why pure compute, with the I/O wrapper outside

Two separate problems push in the same direction:

1. **The algorithm is testable as a function** — feed it a `DatasetManifest` plus an in-memory volume, get a `ProxyAsset`. No fixtures of buckets, no mock stores.
2. **The runtime concerns differ between callers.** The server uses tokio + a bounded semaphore + an LRU disk cache. Future callers (e.g. an offline batch generator) might want rayon and disk-only output. Keeping the algorithm runtime-agnostic preserves both options.

The trade-off: callers must pre-fetch all source chunks into a `ProxySourceData` impl before invoking `generate_proxy`. The server does this in `ServerProxySource` ([lucida-server](lucida-server.md)'s `proxy/server_source.rs`). The MVP has [priority parameters that aren't yet honored](../../gotchas/proxy-priority-not-honored.md).

## Module map

- `lib.rs` — re-exports the public API
- `spec.rs` — `ProxyAsset`, `ProxyHeader`, `ProxyKind`, `ProxySpec`, `ProxyDtype`, `ALGORITHM_VERSION`
- `generate.rs` — `generate_proxy` and `GenerateError`
- `header.rs` — 64-byte binary header (`read_header`/`write_header`); includes `algorithm_version` and `source_content_hash` for cache invalidation
- `source.rs` — `ProxySourceData` trait (synchronous), `FieldVolume`, `SourceError`

## Interactions

- **Direct caller**: [lucida-server](lucida-server.md) `proxy::ProxyGenerator` invokes `generate_proxy` after pre-fetching all source chunks.
- **Inputs**: a `DatasetManifest` (from [lucida-content](lucida-content.md)) and a `ProxySpec` (entity_id, kind, t, c, target_long_axis).
- **Outputs**: a `ProxyAsset` containing the 64-byte header and a `Vec<u16>` voxel buffer in `[Z, Y, X]` row-major.

## Invariants

- **`source_content_hash` in the header is the BLAKE3 of the source bytes** that fed generation. The server cache uses it to invalidate stale proxies if the source dataset changes. `algorithm_version` is bumped on any algorithm change so old cached proxies are rejected.
- **Output dtype is always `u16`**. The on-the-wire frame from the server is `[client_id u32 LE][key_len u16 LE][key][header 64][voxels u16 row-major]` — see `lucida-server/src/handler.rs:encode_proxy_frame`.
- **Output dims are `[Z, Y, X]` only**. T and C are encoded in the cache key, not in the voxel buffer. One proxy = one (entity, kind, t, c) tuple.

## Gotchas

- **`target_long_axis` is a soft cap on the longest output dimension**, not an exact size. Aspect ratio is preserved.
- **`ProxyKind::FieldProxy3D` is also used for bare `Image` entities** (singles), not just plate fields. The server's catalog enumeration in `handler.rs` advertises `FieldProxy3D` for `EntityKind::Image | Field` and `WellProxy3D` for `EntityKind::Well`. The generator falls back to FieldProxy semantics for non-Well entities.
