# lucida-server Glossary

**ServerBinding** -- Operational runtime binding for a dataset. Owns ObjectStore handle, ChunkResolver, and CachedStore. Built from ServerBindingSeed + live resources.

**ChunkResolver** -- Compiled per-dataset key-to-path mapper. Contains per-image resolvers keyed by ImageId. Exposes `resolve(image_id, key)` for path mapping and `storage_compression(image_id)` for decompression decisions. Pure, synchronous, no I/O.

**StorageCompression** -- What compression a stored image uses: None, Lz4, or Zstd. Detected from the Zarr v3 codec chain at import time. The server decompresses before sending to clients.

**ImageResolver** -- Internal per-image state within ChunkResolver: axes_names, optional store_prefix, and storage compression type.

**Session** -- Server-side session state: DocumentState (content graphs), server_bindings (per-dataset ServerBinding), clients (per-client presence), command history with sequence numbers.
