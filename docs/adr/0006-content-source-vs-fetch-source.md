# ContentSource (JS) vs FetchSource (wire)

Status: Accepted.

## Context

The client needs two things with related names: a wire description of how to fetch a dataset's bytes, and an in-browser object that does the fetching, with a pending-request table, per-image wire formats, and cancellation.

## Decision

They are two types.

`FetchSource` (Rust, `lucida-protocol/src/fetch.rs`, mirrored in `manifestTypes.ts`) is the wire envelope. It stays minimal: a discriminated union whose only variant in use is `Proxied`.

`ContentSource` (TypeScript, `lucida-web/src/pipeline/fetch/contentSource.ts`) is the in-browser fetch interface, implemented by `ProxiedContentSource`. When a dataset opens, the client registers each image's wire format with it (`registerImage`). The CPU cache calls `fetch(request, signal)`, and the `AbortSignal` cancels in-flight fetches.

The prefix marks the layer. Wire types stay serializable and free of browser state, and browser state never leaks into the wire format.

The reserved `Local` variant is also why the open command is `OpenRemoteDataset`: it leaves room for an `OpenLocalDataset` sibling that opens a path from the browser.

## Rejected alternatives

- One type for both. Either the wire format embeds promise tables and pending-request maps, or browser code inherits wire details verbatim, including reserved variants it does not use.
- The same base name with disambiguating suffixes. It implies the two are the same thing.
