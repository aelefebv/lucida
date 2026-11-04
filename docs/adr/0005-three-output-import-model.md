# Three-Output Import Model

Status: Accepted.

## Context

Importing a dataset produces information for three audiences. The renderer needs the structure: entities, transforms, images, layouts. The client needs to know how to fetch chunk bytes. The server needs storage paths and codec details to resolve chunk keys. An earlier single `AddDataset` struct carried all three, so storage internals went over the wire to browsers that ignored them, and fetch routing was implicit in the manifest.

## Decision

`lucida-store`'s `import_dataset` returns an `ImportResult` with one part per audience:

- `DatasetManifest` (`lucida-content`): what is in the dataset.
- `FetchSource` (`lucida-protocol`): how a client gets the bytes.
- `ServerBindingSeed` (`lucida-store`): what the server needs to serve them.

Only the manifest and fetch source go on the wire, inside `DatasetOpened`. The binding seed is server-private: the server builds a `ChunkResolver` from it and never broadcasts it. Anything only the server needs belongs in the seed, never in the manifest.

`FetchSource` has `Direct` and `Local` variants beside `Proxied`, but the server emits only `Proxied` and the web client handles only that. The other variants keep room for client-side and in-process fetching without touching the manifest.

## Rejected alternatives

- One struct with fields tagged by audience. The boundary lives in comments instead of types, which is how server fields leaked to clients before.
