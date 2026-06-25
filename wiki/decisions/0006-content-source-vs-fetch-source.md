---
type: Decision
title: "ContentSource (JS) vs FetchSource (wire)"
description: "Two distinct types share related-sounding names by design:"
tags: [lucida, decision]
source_path: wiki/decisions/0006-content-source-vs-fetch-source.md
created: 2026-04-18
modified: 2026-06-25
---

# ContentSource (JS) vs FetchSource (wire)

## Decision

Two distinct types share related-sounding names by design:

- **`FetchSource`** (Rust, in [lucida-protocol](../systems/crates/lucida-protocol.md)) — wire envelope describing how to fetch bytes. Currently `Proxied(ProxiedFetchDescriptor)`; reserved variants `Direct` and `Local`. The reserved `Local` variant is also why the open command is named `OpenRemoteDataset` (server-mediated) — it leaves room for a future `OpenLocalDataset` sibling for browser-side paths. See [Flow: Dataset Opening](../flows/dataset-opening.md).
- **`ContentSource`** (TypeScript, in `lucida-web/src/pipeline/fetch/contentSource.ts`) — in-browser fetch orchestrator. `ContentSource` is the interface; `ProxiedContentSource` is the concrete implementation, constructed from a `FetchSource`. It exposes `registerImage(id, wireFormat)` and `fetch(request, signal)` (the `AbortSignal` lets in-flight fetches be cancelled), returning a binary frame promise.

The split was clarified in commit `1718e9a`. The names hint at the relationship; the prefixes (`Content` vs `Fetch`) hint at the layer.

## Why two types

A single type would either:

- Force the wire format to embed in-browser concerns like promise tables and pending-request maps, or
- Force the in-browser code to inherit wire-protocol details verbatim, including reserved-but-unused variants.

By keeping `FetchSource` minimal and adding `ContentSource` as a JS-side wrapper, each layer carries only what it needs:

- `FetchSource` is a discriminated union with one variant currently in use; deserializing it is mechanical.
- `ContentSource` carries the per-image `WireFormat` mapping, the pending-fetch promise table keyed by `(level, t, c, z, y, x)`, and the routing into [`bridge.ts`](../systems/crates/lucida-web.md) for binary frames.

The `register_dataset → dataset_opened` server-event rename in commit `c1d982d` is a related cleanup — names now reflect what they do rather than mixing layer concerns.

## How this decision shows up in code

- `lucida-protocol/src/fetch.rs::FetchSource` — the wire enum.
- `lucida-web/src/manifestTypes.ts` — TS mirror of `FetchSource`.
- `lucida-web/src/pipeline/fetch/contentSource.ts` — `ContentSource` is a JS interface; `ProxiedContentSource implements ContentSource` is the concrete impl, constructed from a `FetchSource` payload (instantiated `new ProxiedContentSource(...)` in `useBridge.ts`).
- `lucida-web/src/hooks/useBridge.ts::setupFetchPipeline` — `contentSource.registerImage(image_id, wire_format)` per image after `DatasetOpened`.

## Tradeoff

- **Two near-identical names invite confusion.** Mitigated by:
  - File location: `pipeline/fetch/contentSource.ts` for JS, `lucida-protocol/src/fetch.rs` for wire.
  - Type-level: TS uses `ContentSource` (class); Rust uses `FetchSource` (enum).
- The alternative (calling them the same name with disambiguation suffixes) was worse — it implied they were the same thing.

## Related

- [lucida-protocol](../systems/crates/lucida-protocol.md) — wire types
- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md) — where ContentSource is invoked in the fetch path
- [Three-Output Import Model](0005-three-output-import-model.md) — the broader split that FetchSource is part of
