# lucida-store Architecture

Storage abstraction and dataset import. Reads OME-Zarr from object stores (local, GCS, S3, HTTP) and produces structured import results.

## Module Map (import pipeline)

```
parse.rs         shared OME-Zarr parsing (read_zarr_json, parse_multiscales, read_level_metas, extract_full_res)
import.rs        import_dataset() -- entry point, dispatches plate vs single image
import_types.rs  ImportResult, ServerBindingSeed, ImageBindingSeed, StorageCodecInfo
```

## Module Map (existing)

```
backend.rs       open() -- scheme routing to ObjectStore (local, gs://, s3://, http://)
cache.rs         CachedStore -- LRU byte cache over ObjectStore
lib.rs           chunk_key_to_store_path() -- canonical 5D key to on-disk path
ingest/          TIFF-to-Zarr conversion pipeline
main.rs          CLI binary for TIFF-to-Zarr conversion
```

## Data Flow

```
ObjectStore path
  -> parse::read_zarr_json        (fetch + deserialize zarr.json)
  -> parse::parse_multiscales     (extract axes, level entries, coordinate transforms)
  -> parse::read_level_metas      (per-level shape, chunk, codec metadata)
  -> import::import_dataset       (assemble ContentGraph + fetch + binding seed)
  -> ImportResult { content, fetch, binding_seed }
```

## Key Design Decisions

- `parse.rs` provides shared OME-Zarr parsing consumed by `import.rs`.
- `ImportResult` cleanly separates canonical content, client fetch metadata, and server-private binding.
- `ServerBindingSeed` is serializable with no live resources. The server builds `ServerBinding` from it.
- Plate detection is automatic from `ome.plate` presence in root zarr.json.
- No dependency on `lucida-core`. Depends on `lucida-content` and `lucida-protocol`.
