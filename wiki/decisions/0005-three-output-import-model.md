---
type: Decision
title: "Three-Output Import Model"
description: "lucida-store's import_dataset produces an ImportResult with three components:"
tags: [lucida, decision]
source_path: wiki/decisions/0005-three-output-import-model.md
created: 2026-04-18
modified: 2026-07-03
---

# Three-Output Import Model

## Decision

lucida-store's `import_dataset` produces an **`ImportResult`** with three components:

- **`DatasetManifest`** (from lucida-content) — what the renderer needs: entities, transforms, images, source layouts, default layout.
- **`FetchSource`** (from lucida-protocol) — how the client should fetch chunk bytes (currently always `Proxied`).
- **`ServerBindingSeed`** (defined in `lucida-store/src/import_types.rs`) — what the server needs to resolve chunk keys to object-store paths and detect storage compression.

Only `DatasetManifest` and `FetchSource` are sent on the wire (via `DatasetOpened { manifest, fetch, catalog }`). `ServerBindingSeed` is server-private — the server uses it to build a `ChunkResolver` and never broadcasts it.

## Why

The previous monolithic model conflated three audiences and had two failure modes:

1. **Server-private fields leaked to clients.** The early single-struct `AddDataset` carried storage codec details, internal paths, and other server-only state. Browsers received them and ignored them, but the wire format documented things browsers shouldn't care about.
2. **Clients had to round-trip for things they could derive.** Fetch routing was implicit in the manifest, which meant clients couldn't decide locally whether a chunk needed proxying or could be fetched directly. Splitting `FetchSource` out exposed the routing decision explicitly.

The three-output split is a single responsibility per output: manifest = "what is here," fetch = "how do I get bytes," binding seed = "what does the server need to serve them."

## Tradeoffs

- **Three types instead of one.** Imports must produce all three; serializers and tests must cover each. Acceptable because the alternative (one type with audience-tagged fields) bled boundaries.
- **`FetchSource` is currently always `Proxied`.** The variant exists for `Direct` (client-side fetch) and `Local` (in-process file access from CLI/Python), but the web client doesn't use them yet. The split is forward-looking.

## How this decision shows up in code

- `lucida-store/src/import.rs::import_dataset` returns `ImportResult { manifest, fetch, binding_seed }`.
- `lucida-server/src/dataset_open.rs::open_dataset` builds `DatasetOpened { manifest, fetch, catalog }` from the manifest and fetch (server adds the catalog from the manifest's entity list); it builds a `ChunkResolver` from the binding seed and stores it in `ServerBinding`.
- `lucida-protocol/src/register.rs::DatasetOpened` is the wire shape — manifest + fetch + catalog only, no binding seed.

## Renaming history

Captured in commit `c1d982d` and clarified in commit `1718e9a`:

- `ContentGraph → DatasetManifest`
- `ClientFetchDescriptor → FetchSource`
- `register_dataset → dataset_opened` (server event name)

The renames moved the names toward what they actually describe (the manifest is a structural blueprint; the fetch source describes a route to bytes).

## Related

- lucida-store — the import implementation
- lucida-protocol — the wire types
- lucida-content — the manifest data model
- [ContentSource (JS) vs FetchSource (wire)](0006-content-source-vs-fetch-source.md) — the JS/wire naming split
