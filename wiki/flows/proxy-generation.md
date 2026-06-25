---
type: Flow
title: "Flow: Proxy Generation (S5)"
description: "coarse/detail (ADR 0039-0041)."
tags: [lucida, flow]
source_path: wiki/flows/proxy-generation.md
created: 2026-04-18
modified: 2026-06-25
---

# Flow: Proxy Generation (S5)

Status: Historical / legacy bridge. The default fallback model is chunk-only
coarse/detail (ADR 0039-0041). Proxy generation remains documented here only
for the opt-in compatibility path and for understanding older code.

How a `WellProxy3D` or `FieldProxy3D` request travels from the renderer's "I want this proxy" through the server's bounded-concurrency generator, the per-dataset on-disk cache, and back as a binary frame the renderer can drop into a proxy atlas.

## Setup

After a dataset opens, [lucida-server](../systems/crates/lucida-server.md) kicks off best-effort background pre-generation for `(T=0, C=0)` of every advertised entity (in `handle_open_remote_dataset`). The renderer's [Planning Domain](../systems/subsystems/planning-domain.md) also issues on-demand requests when the user moves into a new timepoint or channel.

## Trace: on-demand request

1. **Renderer decides it wants a proxy** — [Planning Domain](../systems/subsystems/planning-domain.md) in well-as-proxy or proxy-fallback mode adds a `MissingProxy { entity, kind, t, c }` to the wanted-set delta. TickCoordinator emits an `AssetMessage::AssetRequest` over the WebSocket.
2. **Wire**: `{type: "asset_request", dataset_id, entity_id, kind, t, c}`.
3. **Server** ([lucida-server](../systems/crates/lucida-server.md) `handler.rs`):
   - At the `AssetRequest` call site, look up the dataset's `ServerBinding`, gate on `legacy_proxy_enabled`, and clone its `ProxyGenerator` (dropping the request with a log line if no binding exists). `serve_asset_request` itself receives the `&Arc<ProxyGenerator>` — the binding lookup is *not* inside it.
   - Inside `serve_asset_request`: construct `ProxySpec { entity_id, kind, t, c, target_long_axis: 128 }`.
   - `generator.request(spec, priority=1).await` — see steps 4–7 below.
   - Encode binary frame (`encode_proxy_frame`).
   - Send to the requesting client's unicast channel.
4. **Generator** ([lucida-server](../systems/crates/lucida-server.md) `proxy::ProxyGenerator`):
   - **Dedup check**: if another in-flight request matches `spec`, await its future. (Many clients can request the same proxy; only one generation runs.)
   - **Cache check** ([lucida-server](../systems/crates/lucida-server.md) `ProxyCache::get`): if a proxy for this `spec` exists on disk and the header validates (algorithm version + source content hash), return it. No generation runs.
   - **Concurrency permit**: acquire a permit from the bounded semaphore (size from `ProxyConfig::concurrency`, default `num_cpus / 2`).
   - **Pre-fetch source chunks** (`build_server_proxy_source`): determine which source chunks the spec's entity needs at the spec's `(t, c)`, fetch them from `CachedStore`, decode storage compression, populate an in-memory `ServerProxySource`.
   - **Synchronous generation**: call [lucida-proxy](../systems/crates/lucida-proxy.md)'s `generate_proxy(manifest, spec, source)` — pure compute, returns a `ProxyAsset` (header + voxels).
   - **Cache write**: atomic write to disk under `{cache_root}/{url_hash16 hex}/{entity}/{kind}/T{:05}_C{:03}.bin`.
   - **Return** the asset to the awaiting requesters.
5. **Server encodes binary frame**:
   ```
   [client_id u32 LE][key_len u16 LE][key bytes][header 64][voxels u16 row-major]
   ```
   Key is `proxy/{entity_id}/{kind_str}/T{:05}_C{:03}` where `kind_str` is `WellProxy3D` or `FieldProxy3D` (literal strings — see `proxy_kind_str`).
6. **Client `bridge.ts::handleBinary`** parses the frame. Key prefix `proxy/` routes it to a separate proxy promise table (not the chunk pending-fetch map).
7. **TickCoordinator** receives the proxy asset, posts a `proxyAssetData` message over [Worker Protocol](../systems/subsystems/worker-protocol.md) to the GPU worker.
8. **Worker** allocates a slot in the appropriate proxy pool (keyed by `(datasetId, kind, slotDims, channel)` — see [Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)](../decisions/0004-multi-pool-atlases.md)) and writes the voxel buffer. Updates the descriptor's proxy slot handle for that entity.
9. **Render** — next frame, the shader's [fallback chain](../systems/subsystems/gpu-residency.md#semantic-fallback-chain) now has the proxy as a candidate.

## Trace: pre-generation on dataset open

Steps 4–8 of the above run for every advertised entity at `(T=0, C=0)` with `priority=0`. Failures are logged but don't propagate — if pre-generation fails, the on-demand request will surface the failure on its own path.

## Cache invalidation

Cached proxies are validated on read by:

- **`algorithm_version`** check (in `lucida-proxy::ProxyHeader`). Bumped when the generation algorithm changes; bumping invalidates all cached proxies.
- **`source_content_hash`** — BLAKE3 of source bytes that fed generation. If the source data changes (e.g. dataset re-imported with different bytes), the hash mismatches and the cached proxy is regenerated.

## Why pre-fetch instead of letting the algorithm fetch

[lucida-proxy](../systems/crates/lucida-proxy.md) is **synchronous and runtime-agnostic** — it doesn't take a tokio runtime, doesn't know about object stores. The server side wraps it by pre-fetching all needed chunks into a `ServerProxySource` that just hands them out via a sync trait.

The alternative — letting `lucida-proxy` do its own async I/O — would couple the algorithm crate to tokio and risk `tokio::block_on` deadlocks in production. See [lucida-proxy](../systems/crates/lucida-proxy.md) for the full rationale.

## Invariants

- **Generation is async-free** ([lucida-proxy](../systems/crates/lucida-proxy.md)). All async happens in the wrapper layer ([lucida-server](../systems/crates/lucida-server.md) `proxy::ProxyGenerator`).
- **In-flight dedup is by `ProxySpec`.** Multiple concurrent requests for the same spec wait on one generation.
- **Cache reads validate the header.** Stale or wrong-algorithm proxies are rejected and regenerated.
- **The on-the-wire `ProxyKind` string is pinned** by `proxy_kind_str` rather than `Debug`. Renaming a variant requires touching both the wire-side helper and the JS client.
- **`target_long_axis` is a soft cap on the longest output dim.** Aspect ratio preserved.

## Gotchas

- **Priority parameter is currently unused.** The MVP semaphore is FIFO; `priority` is reserved for future scheduling. See the comment on `ProxyGenerator::request`.
- **Pre-generation is best-effort.** Don't rely on it for correctness; treat it as a warm-up. The on-demand path is what guarantees the proxy lands.
- **Cache directory keying is by URL hash, not `DatasetId`.** Same dataset re-opened in a new session reuses the same cache directory. Same dataset at a different URL has a different cache.
- **Bare-image entities advertise `FieldProxy3D`**, not `ImageProxy3D` (which doesn't exist). The generator falls back to FieldProxy semantics for non-Well entities.

## Related

- [lucida-proxy](../systems/crates/lucida-proxy.md) — the algorithm crate
- [lucida-server](../systems/crates/lucida-server.md) — the wrapper layer
- [GPU Residency](../systems/subsystems/gpu-residency.md) — where proxies land in the GPU
- [Planning Domain](../systems/subsystems/planning-domain.md) — what triggers proxy demand
- [Multi-Pool Atlases by (Dataset, Channel, Chunk Dims)](../decisions/0004-multi-pool-atlases.md)
