---
type: Crate
title: "lucida-proxy"
description: "Historical proxy-generation crate deleted under ADR-0043."
tags: [lucida, crate, historical]
source_path: wiki/systems/crates/lucida-proxy.md
created: 2026-04-18
modified: 2026-07-16
---

# lucida-proxy

Status: **Retired and deleted (2026-07-16).** This page preserves the old
design for archaeology only. [ADR-0043](../../decisions/0043-superseded-server-surfaces-sunset.md)
removed the crate, its server modules, wire types, and web lane; source/generated
coarse-detail chunks are the sole supported path.

Pure-compute proxy generation. Given a `DatasetManifest` plus caller-supplied source-volume bytes, produces a `ProxyAsset` — a small low-resolution placeholder volume that stands in for either a single tile's downsampled image (`TileProxy3D`) or an aggregated group composed of many tiles (`GroupProxy3D`).

This crate has **no I/O and no async**. Storage, fetching, and caching live in [lucida-server](lucida-server.md)'s `proxy/` module. The split is deliberate — see below.

## Why proxies exist

When a collection dataset zooms out so a single group projects to ≤80 screen pixels, fetching every tile's detail chunks is wasted bandwidth. The renderer instead asks for one `GroupProxy3D` per visible channel, gets back a coarse aggregate, and draws that. As the user zooms in, planning crosses the next threshold and switches to per-tile detail. The proxy fills the gap between "no data yet" and "full detail" without making the renderer wait.

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
- `source.rs` — `ProxySourceData` trait (synchronous), `TileVolume`, `SourceError`

## Interactions

- **Direct caller**: [lucida-server](lucida-server.md) `proxy::ProxyGenerator` invokes `generate_proxy` after pre-fetching all source chunks.
- **Inputs**: a `DatasetManifest` (from [lucida-content](lucida-content.md)) and a `ProxySpec` (entity_id, kind, t, c, target_long_axis).
- **Outputs**: a `ProxyAsset` containing the 64-byte header and a `Vec<u16>` voxel buffer in `[Z, Y, X]` row-major.

## Invariants

- **`source_content_hash` is a metadata fingerprint, not a voxel-byte hash.**
  It covers the contributing entity ids/kinds, transforms, multiscale
  geometry, and `(t, c)` selectors. The cache therefore invalidates when that
  generation geometry changes, but cannot detect byte-only source replacement
  under identical metadata. `algorithm_version` is bumped when generation
  semantics change so old cached proxies are rejected.
- **Output dtype is always `u16`**. The on-the-wire frame from the server is `[client_id u32 LE][key_len u16 LE][key][header 64][voxels u16 row-major]` — see `lucida-server/src/handler.rs:encode_proxy_frame`.
- **Output dims are `[Z, Y, X]` only**. T and C are encoded in the cache key, not in the voxel buffer. One proxy = one (entity, kind, t, c) tuple.

## Gotchas

- **`target_long_axis` is a soft cap on the longest output dimension**, not an exact size. Aspect ratio is preserved.
- **`ProxyKind::TileProxy3D` is also used for bare `Image` entities** (singles), not just collection tiles. The server's catalog enumeration in `handler.rs` advertises `TileProxy3D` for `EntityKind::Image | Tile` and `GroupProxy3D` for `EntityKind::Group`. The generator falls back to TileProxy semantics for non-Group entities.
