# lucida-server Architecture

Tokio WebSocket server. Manages sessions, imports datasets, serves chunks.

## Module Map

```
main.rs          Axum server setup, WebSocket upgrade, broadcast channel
handler.rs       Client message dispatch, handle_open_remote_dataset, serve_chunk_from_store
session.rs       Session state (DocumentState, server_bindings, clients, history)
binding.rs       ServerBinding, ChunkResolver, StorageCompression, detect_compression
browse.rs        HTTP browse endpoint for local file discovery
```

## Key Types

**ServerBinding** -- Owns live resources for a dataset: `Arc<dyn ObjectStore>`, `ChunkResolver`, `Arc<CachedStore>`, source URL. Built from `ServerBindingSeed` + runtime resources.

**ChunkResolver** -- Pure compiled lookup. Maps `(ImageId, chunk_key)` to an object store path. Also exposes `storage_compression(image_id)` to determine per-image decompression.

**StorageCompression** -- Enum: `None`, `Lz4`, `Zstd`. Detected from the Zarr codec chain at import time via `detect_compression()`. Used by the server to decode storage bytes before sending.

**Session** -- Holds `DocumentState`, `HashMap<DatasetId, ServerBinding>`, `HashMap<ClientId, PresenceState>`, command history, sequence counter.

## Data Flow: Import

```
OpenRemoteDataset { url }
  -> backend::open(url)                         Arc<dyn ObjectStore>
  -> import::import_dataset(store, id, name)    ImportResult
  -> ChunkResolver::new(binding_seed)           compiled resolver
  -> ServerBinding { store, resolver, cache }   registered in session
  -> broadcast RegisterDataset { content, fetch }
```

## Data Flow: Chunk Serving

```
ChunkRequest { dataset_id, image_id, key }
  -> session.server_bindings.get(dataset_id)
  -> binding.resolver.resolve(image_id, key)     object store path
  -> binding.cache.get_bytes(path)               compressed storage bytes
  -> decompress(storage_compression)             raw bytes (LZ4 -> raw via lz4_flex)
  -> send binary response to client              [client_id | key_len | composite_key | raw_bytes]
```

## Wire Format Policy

- **Storage decode**: server's responsibility in proxied mode. The server reads storage bytes and decompresses (LZ4/Zstd) before sending.
- **Wire decode**: client's responsibility when wire format is compressed. Phase 1 sends `WireFormat::Raw` — clients receive raw bytes.
- The two layers are independent. The server could later choose a different wire codec (e.g., Zstd for bandwidth) without changing storage.

## Dependencies

- `lz4_flex` -- server-side LZ4 decompression
- `tracing` + `tracing-subscriber` -- structured logging (`RUST_LOG=lucida_server=info`)
