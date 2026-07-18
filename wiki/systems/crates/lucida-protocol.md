---
type: Crate
title: "lucida-protocol"
description: "Wire-level types shared between lucida-server and any client (web, CLI, Python)."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-protocol.md
created: 2026-04-18
modified: 2026-07-16
---

# lucida-protocol

Dependency-neutral wire contracts shared by [lucida-server](lucida-server.md), [lucida-core](lucida-core.md), and clients. It owns payloads and codecs that need content ids but do not need the Scene, camera, or renderer. Renderer-coupled session envelopes stay in `lucida-core/src/protocol.rs` and re-export shared types such as `ClientId` and `ViewerInterestHint` from here.

ADR-0043 removed the asset/proxy fallback, client-originated binary relay, and unused direct/local fetch vocabulary. The surviving network is deliberately smaller: JSON session messages plus one server-to-client chunk frame.

## Why a separate crate

Three reasons:

1. **No circular dependency.** [lucida-store](lucida-store.md) needs to produce
   wire payloads but cannot depend on [lucida-core](lucida-core.md), which owns
   the full Scene model. Core re-exports common compatibility paths, while
   producers can depend directly on this leaf crate.
2. **A dependency-neutral payload layer.** Dataset, generated-availability,
   diagnostics, viewer-interest hints, and terminal failures can evolve
   without pulling the renderer model into producers.
3. **One owner for cross-language framing.** The Rust chunk-frame codec and
   `ClientId` live here. The web decoder is a generated-language mirror locked
   to the same committed bytes, rather than an independently invented format.

## Module map

- `register.rs` — `DatasetOpened { manifest, fetch, opener_client_id }`, the payload of the sequenced dataset-open command.
- `fetch.rs` — the single live `FetchSource::Proxied` server-relay descriptor, compact shared-format encoding, and `WireFormat` (`Raw`, `Lz4`, `Zstd`). “Proxied” here means ordinary chunk relay; it is not the retired asset/proxy fallback.
- `diagnostics.rs` — dataset-open progress/failure/success diagnostics plus runtime source/cache health snapshots.
- `generated_coarse.rs` — `GeneratedAvailabilitySnapshot`, `GeneratedAvailabilityDelta`, generated level summaries, and per-chunk status updates.
- `session.rs` — canonical `u32` `ClientId`, dependency-neutral session payloads (`OpenedDatasetSummary`, `PeerIdentity`, `CommandFailureCode`, `ChunkMessage`), and the complete `ViewerInterest*` family. Core re-exports these names from its envelope module for source compatibility.
- `chunk_frame.rs` — checked encoder/decoder for the one binary WebSocket frame, including explicit truncation, UTF-8, and key-length failures.

All modules are re-exported via `pub use` so consumers can use `lucida_protocol::*` or explicit module paths.

## Wire ownership map

| Contract | Canonical owner | Mirrors / consumers | Lock |
|---|---|---|---|
| Dataset, image, entity, and layout ids | `lucida-content` | Protocol, core, store, server, TypeScript strings | Manifest and session fixtures |
| Live `ClientId` | `lucida-protocol/src/session.rs` (`u32`) | Re-exported by core; `bridge.ts` validates the same domain as an exactly representable JS number | JSON goldens, bounded allocator test, chunk-frame golden, recipient-mismatch test |
| Dependency-neutral JSON payloads | `lucida-protocol` modules above, including open summary, peer identity, command failures, and chunk requests | Core envelopes, server, web, CLI, Python | Rust/web/Python shared fixtures |
| Renderer-coupled JSON envelopes | `lucida-core/src/protocol.rs` | Server and all session clients | Exhaustive `wire_goldens` vocabulary |
| Collaborative commands and saved views | `lucida-core` | Server/WASM/web/CLI/Python | Exhaustive command matrices, JSON goldens, version gates |
| Server-to-client chunk binary frame | `lucida-protocol/src/chunk_frame.rs` | Server encoder; `lucida-web/src/chunkFrame.ts` decoder | `wire-fixtures/binary/chunk_frame.json` |
| Browser renderer-worker messages | `lucida-web/src/renderer/workerProtocol.ts` | Main thread and renderer worker only; never a network frame | Worker dispatch/contract tests |
| Compact manifest/fetch mirrors | `lucida-content` + `lucida-protocol` | `manifestTypes.ts` and Python client helpers | Shared accept/reject corpus under `wire-fixtures/manifest/` |

## Interactions

- [lucida-store](lucida-store.md) **constructs** these types from imported dataset metadata.
- [lucida-server](lucida-server.md) **broadcasts** them in `ServerMessage::CommandBroadcast` (for `DatasetOpened`) and runtime generated-availability/status messages, and emits the checked chunk frame.
- Clients ([lucida-web](lucida-web.md), [lucida-cli](lucida-cli.md), [lucida-py](lucida-py.md)) **consume** them — the web client mirrors `manifestTypes.ts` and routes `FetchSource` into the [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md). The mirror is enforced, not just conventional — see the golden-fixture invariant below.

## Invariants

- **One CI entry point owns parity.** `scripts/verify-wire-contracts.sh` runs the exhaustive Rust JSON vocabulary, protocol payload/codec tests, shared compact-manifest corpus, the real TypeScript mirrors/dispatchers, the binary-frame golden, and Python's fixture inventory. CI runs that script in the dedicated “Cross-language wire contracts” job. An added enum variant, fixture, codec, or required field must be classified there before the job passes.
- **JSON fixtures are maximal and exhaustively inventoried.** `lucida-server/tests/wire_goldens.rs` builds values with real serde types, uses no-wildcard matches to make new variants a compile-time decision, and byte-locks `wire-fixtures/`. `lucida-web/src/wireGoldens.test.ts` drives the same files through production send/receive paths and independently authored TypeScript expectations. Regenerate intentional Rust changes with `REGEN_WIRE_GOLDENS=1 cargo test -p lucida-server --test wire_goldens`, then update every consumer expectation.
- **The binary frame has the same parity discipline.** Rust and TypeScript consume `wire-fixtures/binary/chunk_frame.json`. `ClientId`, the allocator, and the frame field share one `u32` domain; the codec rejects keys wider than its u16 field, length overflow, truncated input, and invalid UTF-8 instead of narrowing or partially decoding. The bridge dispatches a valid frame only after an authoritative snapshot establishes `your_id`, and only when the header matches it.
- **`ContentSource` (JS/TS) is distinct from `FetchSource` (wire)** — the rename in commit `c1d982d` and clarification in `1718e9a` made this explicit. The wire envelope carries `FetchSource`; the web client wraps it in a `ContentSource` class for in-browser fetch orchestration. Don't conflate them. See [ContentSource (JS) vs FetchSource (wire)](../../decisions/0006-content-source-vs-fetch-source.md).
- **Generated availability deltas are client-visible runtime state.** They are not document commands or saved-view payload. The server includes snapshots on connect and broadcasts deltas as generated coarse levels/chunks become available.
- **Wire format names are pinned via explicit `serde` tags**, not derived from `Debug`. Renaming or adding a variant requires touching the vocabulary fixture and each maintained client.
- **Client-originated binary frames fail closed.** The live binary direction is server to client only; clients request chunks through typed JSON.

## Gotchas

- **Adding a `FetchSource` variant breaks every client.** Clients exhaustively decide how bytes arrive. Coordinate a versioned rollout and shared fixtures rather than adding a speculative variant.
- **Do not redefine or widen `ClientId`.** Import or re-export the protocol alias. Every allocator and mirror must stay within the same `u32` domain, or JSON collaboration can admit an identity that the binary lane cannot address.
- **Generated availability is runtime metadata.** It is not a document command or saved-view field, and must not be persisted as one.
