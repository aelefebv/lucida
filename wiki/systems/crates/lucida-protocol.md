---
type: Crate
title: "lucida-protocol"
description: "Wire-level types shared between lucida-server and any client (web, CLI, Python)."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-protocol.md
created: 2026-04-18
modified: 2026-07-03
---

# lucida-protocol

Wire-level types shared between [lucida-server](lucida-server.md) and any client (web, CLI, Python). This crate is intentionally thin — it owns nothing computational, only the on-the-wire shapes of dataset-open events, fetch descriptors, dataset-open/health diagnostics, generated availability metadata, legacy asset catalogs, and legacy asset requests.

The lower-level message envelopes (`ClientMessage`, `ServerMessage`, `ChunkMessage`, `PresenceState`) live in [lucida-core](lucida-core.md)'s `protocol.rs` because they reference camera and view types. This crate carries the dataset-shape pieces that [lucida-store](lucida-store.md) produces and clients consume.

## Why a separate crate

Two reasons:

1. **No circular dependency.** [lucida-store](lucida-store.md) needs to produce wire types but can't depend on [lucida-core](lucida-core.md) (which would pull in WASM-only modules and the full Scene model). [lucida-core](lucida-core.md) re-exports from this crate so downstream consumers see one cohesive API.
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

- [lucida-store](lucida-store.md) **constructs** these types from imported dataset metadata.
- [lucida-server](lucida-server.md) **broadcasts** them in `ServerMessage::CommandBroadcast` (for `DatasetOpened`), `ServerMessage::GeneratedAvailabilityUpdate`, and legacy `ServerMessage::AssetCatalogUpdate`.
- Clients ([lucida-web](lucida-web.md), [lucida-cli](lucida-cli.md), [lucida-py](lucida-py.md)) **consume** them — the web client mirrors `manifestTypes.ts` and routes `FetchSource` into the [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md). The mirror is enforced, not just conventional — see the golden-fixture invariant below.

## Invariants

- **The covered JSON payload families are locked by golden fixtures.** `wire-fixtures/` at the repo root holds committed JSON for: session envelopes (every `ClientMessage`/`ServerMessage` variant, every web-live `DocumentCommand`, and the open/health diagnostics the envelopes carry), `DatasetOpened` (single + plate manifests, all `FetchSource` variants), generated-availability snapshots/deltas, the `ChunkRequest`/`AssetRequest` JSON request envelopes, and a one-exemplar-per-variant enum vocabulary. `lucida-server/tests/wire_goldens.rs` constructs the same values with the real serde types and asserts byte-for-byte equality (regenerate after an intentional change with `REGEN_WIRE_GOLDENS=1 cargo test -p lucida-server --test wire_goldens`); it also runs a required-key deletion harness (loosening a required field forces a reviewed edit to a per-fixture pointer list) and exhaustive no-wildcard matches so adding a message/command/enum variant is a compile error until it is wired in the lock file — to fixtures, or to an explicit exclusion that stands out in review (the compiler forces the edit; the exclusion itself is a review-visible diff, not a compiler guarantee). `lucida-web/src/wireGoldens.test.ts` parses the SAME files through the web's real consumption paths (`Bridge` dispatch and senders, `ProxiedContentSource` requests, the `manifestTypes.ts` shapes, the generated-availability catalog) against exhaustive TS-authored expectations, so a field rename on either side fails one of the two suites instead of surfacing as silent `undefined` in the browser — the same lock-test framing as the [descriptor byte-layout lock](../../decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test.md), applied to the JSON boundary. Both suites run under the standard commands (`cargo test --workspace --all-features`, `cd lucida-web && pnpm test`); no dedicated CI job. **Known limits:** the binary chunk/proxy frames are NOT covered here (the proxy header is locked by `lucida-web/src/pipeline/fetch/wireProtocol.test.ts`); `ChunkMessage::ChunkFetch` is deliberately excluded — it is currently unproduced wire vocabulary (nothing in the repo sends it; the server accepts and ignores it); and a **newly added** serde-skipped field that no fixture populates is invisible to the lock — the fixtures are kept "maximal" (every optional field populated somewhere) as the discipline that keeps that gap reviewable.
- **`ContentSource` (JS/TS) is distinct from `FetchSource` (wire)** — the rename in commit `c1d982d` and clarification in `1718e9a` made this explicit. The wire envelope carries `FetchSource`; the web client wraps it in a `ContentSource` class for in-browser fetch orchestration. Don't conflate them. See [ContentSource (JS) vs FetchSource (wire)](../../decisions/0006-content-source-vs-fetch-source.md).
- **Generated availability deltas are client-visible runtime state.** They are not document commands or saved-view payload. The server includes snapshots on connect and broadcasts deltas as generated coarse levels/chunks become available.
- **`AssetCatalog` is legacy proxy metadata.** The default `DatasetOpened` catalog is empty after the coarse/detail default flip. `AssetCatalogDelta` remains monotonic for compatibility.
- **Wire format names are pinned via explicit `serde` tags**, not derived from `Debug`. `ProxyKind::WellProxy3D` serializes as the literal string `"WellProxy3D"`, asserted by the `proxy_kind_str` helper in the server. Renaming a variant requires touching both ends.

## Gotchas

- **Adding a `FetchSource` variant breaks every client.** Clients exhaustively match on the enum to decide how to fetch. Use `#[serde(other)]` carefully — the safer path is to coordinate a versioned rollout.
- **The initial catalog is seeded inside `DatasetOpened`, not via `AssetCatalogUpdate`.** In the default path this catalog is empty; generated coarse metadata arrives through generated availability snapshots/deltas instead.
