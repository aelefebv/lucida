---
created: 2026-04-18
modified: 2026-06-25
---

# lucida-protocol

Wire-level types shared between [[lucida-server]] and any client (web, CLI, Python). This crate is intentionally thin — it owns nothing computational, only the on-the-wire shapes of dataset-open events, fetch descriptors, dataset-open/health diagnostics, generated availability metadata, legacy asset catalogs, and legacy asset requests.

The lower-level message envelopes (`ClientMessage`, `ServerMessage`, `ChunkMessage`, `PresenceState`) live in [[lucida-core]]'s `protocol.rs` because they reference camera and view types. This crate carries the dataset-shape pieces that [[lucida-store]] produces and clients consume.

## Why a separate crate

Two reasons:

1. **No circular dependency.** [[lucida-store]] needs to produce wire types but can't depend on [[lucida-core]] (which would pull in WASM-only modules and the full Scene model). [[lucida-core]] re-exports from this crate so downstream consumers see one cohesive API.
2. **Wire stability.** Pulling these types out makes the wire surface easier to audit when bumping the protocol. A diff on `lucida-protocol/src/` is the place to look for "did the wire format change?"

## Module map

- `register.rs` — `DatasetOpened { manifest, fetch, catalog }`. The full payload broadcast when the server opens a dataset.
- `fetch.rs` — `FetchSource` enum: `Proxied`, `Direct`, and `Local` are all implemented, each with its own descriptor struct (`Local` = local filesystem / Python headless). `WireFormat` enum whose variants each carry a `{ data_type: DataType }` payload (`Raw`, `Lz4`, `Zstd`), plus `ProxiedImageSpec`.
- `diagnostics.rs` — dataset-open progress/failure/success diagnostics plus runtime source/cache health snapshots.
- `generated.rs` — `GeneratedAvailabilitySnapshot`, `GeneratedAvailabilityDelta`, generated level summaries, and per-chunk status updates.
- `asset.rs` — legacy `AssetCatalog`, `ProxyAvailability`, `AssetCatalogDelta`. Re-exports `ProxyKind` (`WellProxy3D`, `FieldProxy3D`) via `pub use lucida_proxy::ProxyKind` (defined in lucida-proxy/src/spec.rs).
- `asset_request.rs` — legacy `AssetMessage::AssetRequest { dataset_id, entity_id, kind, t, c }`.

All six modules are re-exported via `pub use` so consumers do `use lucida_protocol::*;`.

## Interactions

- [[lucida-store]] **constructs** these types from imported dataset metadata.
- [[lucida-server]] **broadcasts** them in `ServerMessage::CommandBroadcast` (for `DatasetOpened`), `ServerMessage::GeneratedAvailabilityUpdate`, and legacy `ServerMessage::AssetCatalogUpdate`.
- Clients ([[lucida-web]], [[lucida-cli]], [[lucida-py]]) **consume** them — the web client mirrors `manifestTypes.ts` and routes `FetchSource` into the [[chunk-lifecycle]].

## Invariants

- **`ContentSource` (JS/TS) is distinct from `FetchSource` (wire)** — the rename in commit `c1d982d` and clarification in `1718e9a` made this explicit. The wire envelope carries `FetchSource`; the web client wraps it in a `ContentSource` class for in-browser fetch orchestration. Don't conflate them. See [[decisions/0006-content-source-vs-fetch-source]].
- **Generated availability deltas are client-visible runtime state.** They are not document commands or saved-view payload. The server includes snapshots on connect and broadcasts deltas as generated coarse levels/chunks become available.
- **`AssetCatalog` is legacy proxy metadata.** The default `DatasetOpened` catalog is empty after the coarse/detail default flip. `AssetCatalogDelta` remains monotonic for compatibility.
- **Wire format names are pinned via explicit `serde` tags**, not derived from `Debug`. `ProxyKind::WellProxy3D` serializes as the literal string `"WellProxy3D"`, asserted by the `proxy_kind_str` helper in the server. Renaming a variant requires touching both ends.

## Gotchas

- **Adding a `FetchSource` variant breaks every client.** Clients exhaustively match on the enum to decide how to fetch. Use `#[serde(other)]` carefully — the safer path is to coordinate a versioned rollout.
- **The initial catalog is seeded inside `DatasetOpened`, not via `AssetCatalogUpdate`.** In the default path this catalog is empty; generated coarse metadata arrives through generated availability snapshots/deltas instead.
