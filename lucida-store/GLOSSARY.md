# lucida-store Glossary

**ImportResult** -- Three-part output of `import_dataset()`: ContentGraph + ClientFetchDescriptor + ServerBindingSeed.

**ServerBindingSeed** -- Serializable per-dataset metadata the server needs to build its operational binding. Contains per-image axes, store prefixes, and storage codecs. No live resources.

**ImageBindingSeed** -- Per-image server-side metadata: axes_names (for chunk key mapping), store_prefix (for plate FOV routing), storage_codecs (on-disk codec chain).

**StorageCodecInfo** -- Per-level codec metadata as stored in OME-Zarr. Not wire format -- the server may transcode.

**ParsedMultiscales** -- Intermediate parse result: axes_json, axes_names, and level_entries extracted from OME multiscales JSON.

**LevelEntry** -- Intermediate per-level metadata: on-disk path and 5D scale from coordinate transforms.

**ArrayMeta** -- Deserialized from a level's zarr.json: shape, data_type, chunk_grid, codecs.

**chunk_key_to_store_path** -- Maps a canonical 5D chunk key (`"level/t/c/z/y/x"`) to an on-disk Zarr path, filtering to only the axes present in the dataset.
