---
created: 2026-04-18
modified: 2026-04-18
---

# lucida-protocol

Wire-level types shared between [[lucida-server]] and any client (web, CLI, Python). This crate is intentionally thin — it owns nothing computational, only the on-the-wire shapes of dataset-open events, fetch descriptors, asset catalogs, and asset requests.

The lower-level message envelopes (`ClientMessage`, `ServerMessage`, `ChunkMessage`, `PresenceState`) live in [[lucida-core]]'s `protocol.rs` because they reference camera and view types. This crate carries the dataset-shape pieces that [[lucida-store]] produces and clients consume.

## Why a separate crate

Two reasons:

1. **No circular dependency.** [[lucida-store]] needs to produce wire types but can't depend on [[lucida-core]] (which would pull in WASM-only modules and the full Scene model). [[lucida-core]] re-exports from this crate so downstream consumers see one cohesive API.
2. **Wire stability.** Pulling these types out makes the wire surface easier to audit when bumping the protocol. A diff on `lucida-protocol/src/` is the place to look for "did the wire format change?"

## Module map

- `register.rs` — `DatasetOpened { manifest, fetch, catalog }`. The full payload broadcast when the server opens a dataset.
- `fetch.rs` — `FetchSource` enum: `Proxied(ProxiedFetchDescriptor)`, with `Direct` and `Local` reserved. `WireFormat` enum (`Raw`, `Lz4`, `Zstd`) and `ProxiedImageSpec`.
- `asset.rs` — `AssetCatalog`, `ProxyAvailability`, `ProxyKind` (`WellProxy3D`, `FieldProxy3D`), `AssetCatalogDelta`.
- `asset_request.rs` — `AssetMessage::AssetRequest { dataset_id, entity_id, kind, t, c }`.

All four modules are re-exported via `pub use` so consumers do `use lucida_protocol::*;`.

## Interactions

- [[lucida-store]] **constructs** these types from imported dataset metadata.
- [[lucida-server]] **broadcasts** them in `ServerMessage::CommandBroadcast` (for `DatasetOpened`) and `ServerMessage::AssetCatalogUpdate`.
- Clients ([[lucida-web]], [[lucida-cli]], [[lucida-py]]) **consume** them — the web client mirrors `manifestTypes.ts` and routes `FetchSource` into the [[chunk-pipeline]].

## Invariants

- **`ContentSource` (JS/TS) is distinct from `FetchSource` (wire)** — the rename in commit `c1d982d` and clarification in `1718e9a` made this explicit. The wire envelope carries `FetchSource`; the web client wraps it in a `ContentSource` class for in-browser fetch orchestration. Don't conflate them. See [[decisions/content-source-vs-fetch-source]].
- **`AssetCatalog` is monotonic across `AssetCatalogDelta` merges.** The `apply_asset_catalog_delta` document command merges by entity, deduping `ProxyKind` lists. Same delta applied twice produces the same catalog. See the `apply_asset_catalog_delta_idempotent_on_repeat` test in `lucida-core/src/protocol.rs`.
- **Wire format names are pinned via explicit `serde` tags**, not derived from `Debug`. `ProxyKind::WellProxy3D` serializes as the literal string `"WellProxy3D"`, asserted by the `proxy_kind_str` helper in the server. Renaming a variant requires touching both ends.

## Gotchas

- **Adding a `FetchSource` variant breaks every client.** Clients exhaustively match on the enum to decide how to fetch. Use `#[serde(other)]` carefully — the safer path is to coordinate a versioned rollout.
- **`AssetCatalogUpdate` is reserved for S5+.** S3-era servers never emit it; the web client's handler may receive empty deltas as a sanity check (no-op). Don't rely on the server to backfill the initial catalog via deltas — the catalog is seeded inside the `DatasetOpened` event.
