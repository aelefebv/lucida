# lucida-protocol Architecture

Fetch and registration types shared between store (producer) and clients (consumers). Depends only on `lucida-content`.

## Module Map

```
lib.rs        re-exports
fetch.rs      ClientFetchDescriptor, WireFormat, per-mode descriptor types
register.rs   RegisterDataset
```

## Key Types

`ClientFetchDescriptor` is an enum by access mode:
- **Proxied** -- server resolves storage paths, client only sees wire format per image
- **Direct** -- client resolves paths itself (future, needs level paths + store prefix)
- **Local** -- filesystem access for Python headless (same addressing as Direct)

`RegisterDataset` bundles a `ContentGraph` + `ClientFetchDescriptor`. This is the application-level message for dataset registration. It intentionally excludes server-private binding state.

`WireFormat` describes what byte encoding the client should expect: Raw, Lz4, or Zstd, each carrying a `DataType`.

## Design Rules

- No scene state, no storage, no runtime resources.
- Everything is `Serialize + Deserialize`.
- Only Proxied mode is implemented in phase 1.
