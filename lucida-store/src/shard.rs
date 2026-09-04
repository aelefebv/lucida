//! Reading one inner chunk out of a Zarr v3 shard.
//!
//! A shard is one object holding many inner chunks and an index that says
//! where each one sits. The viewer keeps addressing inner chunks, so the
//! chunk key, the wire, and the renderer see no shard at all. Only how an
//! inner chunk's bytes are found changes. The shard's index is read once,
//! and each inner chunk is then one range read into the object, which the
//! cached store may carry in a neighbour's request when the two lie end to
//! end and are queued for a permit together.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use crate::backend::StoreError;
use crate::cache::{CachedStore, SourceReadTiming, TimedRead};
use crate::codec::{StorageCompression, parse_codec_chain};
use crate::source_limiter::{ReaderId, RequestLabel};

/// The codec name Zarr v3 gives the sharding codec.
const SHARDING_CODEC: &str = "sharding_indexed";

/// Bytes one index entry occupies: a `u64` offset and a `u64` length.
const INDEX_ENTRY_BYTES: u64 = 16;

/// Bytes the crc32c codec appends to the index.
const CHECKSUM_BYTES: u64 = 4;

/// Where a shard keeps its index, as the metadata declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IndexLocation {
    Start,
    End,
}

/// What the sharding codec's configuration settles about every shard of a
/// level, parsed from its codec chain. Together with the shard shape from the
/// chunk grid, it fixes how an inner chunk key maps to a shard object and a
/// position, how long the index is and where it sits, and how the inner
/// chunk's bytes are decoded once read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShardLayout {
    /// The inner chunk shape, parallel to the level's axes. This is the
    /// chunk shape the viewer plans and fetches in.
    pub inner_chunk_shape: Vec<u64>,
    /// How many inner chunks a shard holds along each axis: the shard shape
    /// divided by the inner chunk shape.
    pub chunks_per_shard: Vec<u64>,
    /// The codec chain each inner chunk is stored with.
    pub inner_compression: StorageCompression,
    pub index_location: IndexLocation,
    /// Whether the index carries a crc32c checksum after its entries.
    pub index_checksum: bool,
}

impl ShardLayout {
    /// Parse a level's codec chain into its shard layout, or `Ok(None)` when
    /// the chain does not start with the sharding codec.
    ///
    /// `shard_shape` is the level's `chunk_grid` chunk shape, which for a
    /// sharded array is the shape of one shard. A chain that names the
    /// sharding codec but describes a layout this module does not read
    /// returns an error naming what it found: the sharding codec with other
    /// codecs beside it, an inner chunk shape that does not tile the shard,
    /// a nested sharding codec, an inner chain outside the codec allowlist,
    /// an index codec chain other than `bytes` optionally followed by
    /// `crc32c`, or an index location other than `start` or `end`. Every
    /// such error opens by naming the sharding codec, so an import that
    /// fails on one is classified as an unsupported codec and the layout it
    /// refused is findable in the metadata.
    pub fn from_codec_chain(
        codecs: &[serde_json::Value],
        shard_shape: &[u64],
    ) -> Result<Option<Self>, StoreError> {
        let Some(first) = codecs.first() else {
            return Ok(None);
        };
        if first.get("name").and_then(|n| n.as_str()) != Some(SHARDING_CODEC) {
            return Ok(None);
        }
        Self::parse(first, codecs, shard_shape)
            .map(Some)
            .map_err(|e| e.in_context(format!("{SHARDING_CODEC} codec")))
    }

    /// Errors name only what was found; `from_codec_chain` prefixes the
    /// codec.
    fn parse(
        first: &serde_json::Value,
        codecs: &[serde_json::Value],
        shard_shape: &[u64],
    ) -> Result<Self, StoreError> {
        if codecs.len() != 1 {
            return Err(StoreError::Metadata(format!(
                "the {SHARDING_CODEC} codec must be the only codec in the storage chain, got {} codecs",
                codecs.len(),
            )));
        }
        let config = first.get("configuration").ok_or_else(|| {
            StoreError::Metadata(format!(
                "{SHARDING_CODEC} codec missing 'configuration' object"
            ))
        })?;

        let inner_chunk_shape = parse_inner_chunk_shape(config, shard_shape)?;
        let chunks_per_shard = shard_shape
            .iter()
            .zip(&inner_chunk_shape)
            .map(|(shard, inner)| shard / inner)
            .collect();

        let inner_codecs = config
            .get("codecs")
            .and_then(|c| c.as_array())
            .ok_or_else(|| {
                StoreError::Metadata(format!(
                    "{SHARDING_CODEC} configuration missing 'codecs' array for the inner chunks"
                ))
            })?;
        if inner_codecs
            .iter()
            .any(|c| c.get("name").and_then(|n| n.as_str()) == Some(SHARDING_CODEC))
        {
            return Err(StoreError::Metadata(format!(
                "nested sharding is not supported: a {SHARDING_CODEC} codec inside another"
            )));
        }
        let inner_compression =
            parse_codec_chain(inner_codecs).map_err(|e| e.in_context("inner chunk codecs"))?;

        let index_codecs = config
            .get("index_codecs")
            .and_then(|c| c.as_array())
            .ok_or_else(|| {
                StoreError::Metadata(format!(
                    "{SHARDING_CODEC} configuration missing 'index_codecs' array"
                ))
            })?;
        let index_checksum = parse_index_codecs(index_codecs)?;

        let index_location = match config.get("index_location").and_then(|l| l.as_str()) {
            None | Some("end") => IndexLocation::End,
            Some("start") => IndexLocation::Start,
            Some(other) => {
                return Err(StoreError::Metadata(format!(
                    "index_location '{other}' not supported (use 'start' or 'end')",
                )));
            }
        };

        Ok(ShardLayout {
            inner_chunk_shape,
            chunks_per_shard,
            inner_compression,
            index_location,
            index_checksum,
        })
    }

    /// Map an inner chunk key to the shard that holds it and its position
    /// there.
    ///
    /// The key addresses inner chunks, so it is read in the inner chunk grid
    /// exactly as an unsharded key is read in its chunk grid, bundled `t` and
    /// `c` included. Each grid coordinate then splits into a shard coordinate
    /// and a position within the shard. `None` when the key is malformed.
    pub fn locate_inner_chunk(&self, key: &str, axes: &[String]) -> Option<ShardLocation> {
        let (level, inner) = crate::chunk_key_grid_coords(key, axes, &self.inner_chunk_shape)?;
        if inner.len() != self.chunks_per_shard.len() {
            return None;
        }
        let mut shard = Vec::with_capacity(inner.len());
        let mut position: u64 = 0;
        for (&coord, &per_shard) in inner.iter().zip(&self.chunks_per_shard) {
            shard.push(coord / per_shard);
            position = position * per_shard + coord % per_shard;
        }
        Some(ShardLocation {
            path: Path::from(crate::chunk_grid_store_path(level, &shard)),
            position: usize::try_from(position).ok()?,
        })
    }

    /// How many inner chunks one shard holds.
    pub fn inner_chunks_per_shard(&self) -> u64 {
        self.chunks_per_shard.iter().product()
    }

    /// How many bytes the index occupies at the start or the end of a shard.
    pub fn index_byte_len(&self) -> u64 {
        let entries = self.inner_chunks_per_shard() * INDEX_ENTRY_BYTES;
        if self.index_checksum {
            entries + CHECKSUM_BYTES
        } else {
            entries
        }
    }
}

/// Where one inner chunk lives: the shard object that holds it, and which
/// of the shard's index entries is its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardLocation {
    /// The shard object's path, in the same form as
    /// [`crate::chunk_key_to_store_path`] gives an unsharded chunk's. A
    /// collection tile's prefix is the caller's to add, as it is there.
    pub path: Path,
    /// The inner chunk's index in the shard, row-major over
    /// [`ShardLayout::chunks_per_shard`].
    pub position: usize,
}

/// Reads inner chunks out of shards, remembering what each shard's index
/// says.
///
/// One per binding, held beside the per-level layouts by the resolver that
/// maps a chunk key to its location. The indexes live as long as the binding
/// does, so a shard's index is read once and every later inner chunk of
/// that shard is one range read. A shard object that is not there is
/// remembered the same way, so an unwritten shard costs one read rather
/// than one per inner chunk. The cached store beneath still coalesces two
/// callers who reach a cold shard together onto one index read, so the
/// once-per-shard rule holds under concurrency as well as in sequence.
///
/// The indexes are keyed by shard path alone, so every read through one
/// cache must go to the one store its binding reads.
#[derive(Default)]
pub struct ShardIndexCache {
    indexes: Mutex<HashMap<Path, Arc<ShardIndex>>>,
}

impl ShardIndexCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the inner chunk at `location` from `store`.
    ///
    /// The bytes come back as stored, for the caller to decode with
    /// [`ShardLayout::inner_compression`], exactly as [`CachedStore::get_bytes`]
    /// returns an unsharded chunk. An inner chunk the index marks absent, or
    /// one in a shard object that is not there, answers with the not-found
    /// error a missing object would, so the caller's fill path serves it
    /// unchanged.
    ///
    /// The timing covers the index read too when this call performed it,
    /// so a cold shard's first inner chunk reports both round trips.
    ///
    /// `reader` and `label` mean what they mean for [`CachedStore::get_bytes`].
    pub async fn read_inner_chunk(
        &self,
        store: &CachedStore,
        layout: &ShardLayout,
        location: &ShardLocation,
        reader: ReaderId,
        label: RequestLabel,
    ) -> TimedRead {
        let shard = &location.path;
        let (index, index_timing) = match self
            .resolve_index(store, layout, shard, reader, label)
            .await
        {
            Ok(found) => found,
            Err(failed) => return failed,
        };
        let range = match index.entry(location.position) {
            Ok(Some(range)) => range,
            Ok(None) => {
                return TimedRead {
                    result: Err(unwritten(shard, location.position)),
                    timing: index_timing,
                };
            }
            Err(error) => {
                return TimedRead {
                    result: Err(error),
                    timing: index_timing,
                };
            }
        };
        let read = store.get_range(shard, range, reader, label).await;
        TimedRead {
            result: read.result,
            timing: index_timing.followed_by(read.timing),
        }
    }

    /// The shard's index, remembered from an earlier call or read from the
    /// object now and remembered. The timing is the read's, or nothing when
    /// no read happened. A shard object that is not there is an index with
    /// nothing written, not a failure; any other error is returned as the
    /// read that failed.
    async fn resolve_index(
        &self,
        store: &CachedStore,
        layout: &ShardLayout,
        shard: &Path,
        reader: ReaderId,
        label: RequestLabel,
    ) -> Result<(Arc<ShardIndex>, SourceReadTiming), TimedRead> {
        if let Some(index) = self.indexes.lock().unwrap().get(shard) {
            return Ok((Arc::clone(index), SourceReadTiming::default()));
        }

        let len = layout.index_byte_len();
        let read = match layout.index_location {
            IndexLocation::Start => store.get_range(shard, 0..len, reader, label).await,
            IndexLocation::End => store.get_suffix(shard, len, reader, label).await,
        };
        let index = match read.result {
            Ok(bytes) => match ShardIndex::parse(&bytes, layout, shard) {
                Ok(index) => index,
                Err(error) => {
                    return Err(TimedRead {
                        result: Err(error),
                        timing: read.timing,
                    });
                }
            },
            Err(object_store::Error::NotFound { .. }) => ShardIndex::Missing,
            Err(error) => {
                return Err(TimedRead {
                    result: Err(error),
                    timing: read.timing,
                });
            }
        };
        let index = Arc::clone(
            self.indexes
                .lock()
                .unwrap()
                .entry(shard.clone())
                .or_insert(Arc::new(index)),
        );
        Ok((index, read.timing))
    }
}

/// The answer for an inner chunk nothing was written for, in the shape the
/// fill path already handles.
fn unwritten(shard: &Path, position: usize) -> object_store::Error {
    object_store::Error::NotFound {
        path: shard.to_string(),
        source: format!("inner chunk {position} of shard {shard} was not written").into(),
    }
}

/// What a shard's index says about the shard's inner chunks.
enum ShardIndex {
    /// The shard object is not there, so no inner chunk in it was written.
    Missing,
    /// Two words per inner chunk, offset then length, in the shard's
    /// row-major inner chunk order. Kept as the on-disk pairs rather than
    /// ranges so an index costs in memory what it costs on disk.
    Written(Vec<u64>),
}

/// Both words of an entry for an inner chunk that was never written.
const ABSENT: u64 = u64::MAX;

impl ShardIndex {
    /// Parse the index bytes of `shard`, checking that they are the length
    /// the layout says, that the checksum holds when the layout has one,
    /// and that every written entry names a range that fits in a `u64`.
    fn parse(
        bytes: &Bytes,
        layout: &ShardLayout,
        shard: &Path,
    ) -> Result<ShardIndex, object_store::Error> {
        let expected = layout.index_byte_len();
        if bytes.len() as u64 != expected {
            return Err(shard_error(format!(
                "shard index of {shard} is {} bytes, expected {expected}",
                bytes.len()
            )));
        }
        let entries_len = (layout.inner_chunks_per_shard() * INDEX_ENTRY_BYTES) as usize;
        let (entries, checksum) = bytes.split_at(entries_len);
        if layout.index_checksum {
            let recorded = u32::from_le_bytes(checksum.try_into().expect("four checksum bytes"));
            if crc32c::crc32c(entries) != recorded {
                return Err(shard_error(format!(
                    "shard index of {shard} does not match its crc32c checksum"
                )));
            }
        }
        let entries: Vec<u64> = entries
            .as_chunks::<8>()
            .0
            .iter()
            .map(|word| u64::from_le_bytes(*word))
            .collect();
        for (position, &[offset, len]) in entries.as_chunks::<2>().0.iter().enumerate() {
            let written = !(offset == ABSENT && len == ABSENT);
            if written && offset.checked_add(len).is_none() {
                return Err(shard_error(format!(
                    "shard index of {shard} places inner chunk {position} past the end of any object"
                )));
            }
        }
        Ok(ShardIndex::Written(entries))
    }

    /// The byte range of the inner chunk at `position`, `None` when nothing
    /// was written for it, and an error for a position the shard does not
    /// have.
    fn entry(&self, position: usize) -> Result<Option<Range<u64>>, object_store::Error> {
        let entries = match self {
            ShardIndex::Missing => return Ok(None),
            ShardIndex::Written(entries) => entries,
        };
        let Some(entry) = entries.get(position * 2..position * 2 + 2) else {
            return Err(shard_error(format!(
                "inner chunk position {position} is outside a shard of {} inner chunks",
                entries.len() / 2
            )));
        };
        let (offset, len) = (entry[0], entry[1]);
        if offset == ABSENT && len == ABSENT {
            return Ok(None);
        }
        Ok(Some(offset..offset + len))
    }
}

/// An error from the shard itself rather than from the backend: an index
/// that is not what the metadata declares. Surfaced through the cached
/// store's error type so a caller triages it beside the backend's own.
fn shard_error(message: String) -> object_store::Error {
    object_store::Error::Generic {
        store: "shard",
        source: message.into(),
    }
}

/// The inner chunk shape from the sharding configuration, checked to tile
/// the shard exactly.
fn parse_inner_chunk_shape(
    config: &serde_json::Value,
    shard_shape: &[u64],
) -> Result<Vec<u64>, StoreError> {
    let inner: Vec<u64> = config
        .get("chunk_shape")
        .and_then(|s| s.as_array())
        .ok_or_else(|| {
            StoreError::Metadata(format!(
                "{SHARDING_CODEC} configuration missing 'chunk_shape' array"
            ))
        })?
        .iter()
        .map(|v| {
            v.as_u64().ok_or_else(|| {
                StoreError::Metadata(format!(
                    "{SHARDING_CODEC} chunk_shape entry {v} is not a non-negative integer"
                ))
            })
        })
        .collect::<Result<_, _>>()?;
    if inner.len() != shard_shape.len() {
        return Err(StoreError::Metadata(format!(
            "{SHARDING_CODEC} chunk_shape has {} axes but the shard shape {shard_shape:?} has {}",
            inner.len(),
            shard_shape.len(),
        )));
    }
    for (axis, (&i, &s)) in inner.iter().zip(shard_shape).enumerate() {
        if i == 0 || s % i != 0 {
            return Err(StoreError::Metadata(format!(
                "{SHARDING_CODEC} chunk_shape {inner:?} does not tile the shard shape {shard_shape:?} on axis {axis}",
            )));
        }
    }
    Ok(inner)
}

/// Validate the index codec chain and say whether it ends in a checksum.
/// The index is always `bytes` (little-endian), optionally followed by
/// `crc32c`; any other chain is refused by name.
fn parse_index_codecs(codecs: &[serde_json::Value]) -> Result<bool, StoreError> {
    let names: Vec<&str> = codecs
        .iter()
        .map(|c| c.get("name").and_then(|n| n.as_str()).unwrap_or("?"))
        .collect();
    let endian = codecs
        .first()
        .and_then(|c| c.get("configuration"))
        .and_then(|c| c.get("endian"))
        .and_then(|e| e.as_str());
    match (names.as_slice(), endian) {
        (["bytes"], Some("little")) => Ok(false),
        (["bytes", "crc32c"], Some("little")) => Ok(true),
        _ => Err(StoreError::Metadata(format!(
            "index_codecs {names:?} not supported (expected bytes little-endian, optionally followed by crc32c)",
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use bytes::Bytes;
    use object_store::path::Path;

    use super::*;
    use crate::cache::CachedStore;
    use crate::codec::StorageCompression;
    use crate::parse::ArrayMeta;
    use crate::source_limiter::{ReaderId, RequestLabel, SourceReadLimiter};
    use crate::test_support::CountingStore;

    fn committed_fixture(name: &str) -> String {
        format!("{}/../fixtures/ome-zarr/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// The array metadata of one level of a committed fixture, as import
    /// parses it.
    fn fixture_level_meta(name: &str, level: u32) -> ArrayMeta {
        let path = format!("{}/{level}/zarr.json", committed_fixture(name));
        serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
            .unwrap()
    }

    fn fixture_layout(name: &str, level: u32) -> Option<ShardLayout> {
        let meta = fixture_level_meta(name, level);
        ShardLayout::from_codec_chain(&meta.codecs, &meta.chunk_grid.configuration.chunk_shape)
            .unwrap()
    }

    #[test]
    fn parses_the_committed_sharded_fixture_layout() {
        let layout = fixture_layout("twin-sharded.ome.zarr", 0).expect("the fixture is sharded");
        assert_eq!(layout.inner_chunk_shape, [1, 8, 8]);
        assert_eq!(layout.chunks_per_shard, [1, 2, 2]);
        assert_eq!(layout.inner_compression, StorageCompression::Zstd);
        assert_eq!(layout.index_location, IndexLocation::End);
        assert_eq!(layout.index_byte_len(), 4 * 16 + 4);
    }

    #[test]
    fn an_unsharded_chain_is_not_a_shard_layout() {
        assert_eq!(fixture_layout("twin-unsharded.ome.zarr", 0), None);
    }

    fn axes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_inner_chunk_key_names_its_shard_and_its_position_in_the_shard() {
        let layout = fixture_layout("twin-sharded.ome.zarr", 0).unwrap();
        let cyx = axes(&["c", "y", "x"]);
        // (c=1, y=2, x=3) in 1x2x2 shards: shard (1, 1, 1), position (0, 0, 1).
        assert_eq!(
            layout.locate_inner_chunk("0/0/1/0/2/3", &cyx),
            Some(ShardLocation {
                path: Path::from("0/c/1/1/1"),
                position: 1,
            })
        );
        assert_eq!(
            layout.locate_inner_chunk("1/0/0/0/1/0", &cyx),
            Some(ShardLocation {
                path: Path::from("1/c/0/0/0"),
                position: 2,
            })
        );
    }

    /// The wire key carries the channel as a sample coordinate; an inner
    /// chunk that bundles five channels is addressed by dividing it, as an
    /// unsharded bundled chunk is.
    #[test]
    fn a_bundled_channel_key_divides_before_it_locates_the_shard() {
        let layout = ShardLayout {
            inner_chunk_shape: vec![1, 5, 1, 8, 8],
            chunks_per_shard: vec![1, 1, 1, 2, 2],
            inner_compression: StorageCompression::None,
            index_location: IndexLocation::End,
            index_checksum: true,
        };
        // c=7 is bundle 1; y=3 and x=2 fall in shard (1, 1) at position (1, 0).
        assert_eq!(
            layout.locate_inner_chunk("0/0/7/0/3/2", &axes(&["t", "c", "z", "y", "x"])),
            Some(ShardLocation {
                path: Path::from("0/c/0/1/0/1/1"),
                position: 2,
            })
        );
    }

    const READER: ReaderId = ReaderId(7);
    const LABEL: RequestLabel = RequestLabel(11);

    fn cached_store(name: &str) -> Arc<CachedStore> {
        Arc::new(CachedStore::new(
            crate::backend::open(&committed_fixture(name)).unwrap(),
            1024 * 1024,
        ))
    }

    /// Every inner chunk key of one level of the sharded twin, with the
    /// layout that level declares.
    fn sharded_twin_keys(level: u32) -> (ShardLayout, Vec<String>) {
        let meta = fixture_level_meta("twin-sharded.ome.zarr", level);
        let layout =
            ShardLayout::from_codec_chain(&meta.codecs, &meta.chunk_grid.configuration.chunk_shape)
                .unwrap()
                .unwrap();
        let grid: Vec<u64> = meta
            .shape
            .iter()
            .zip(&layout.inner_chunk_shape)
            .map(|(extent, inner)| extent.div_ceil(*inner))
            .collect();
        let mut keys = Vec::new();
        for c in 0..grid[0] {
            for y in 0..grid[1] {
                for x in 0..grid[2] {
                    keys.push(format!("{level}/0/{c}/0/{y}/{x}"));
                }
            }
        }
        (layout, keys)
    }

    async fn read_from_shard(
        shards: &ShardIndexCache,
        store: &CachedStore,
        layout: &ShardLayout,
        key: &str,
    ) -> Result<Bytes, object_store::Error> {
        let location = layout
            .locate_inner_chunk(key, &axes(&["c", "y", "x"]))
            .unwrap();
        shards
            .read_inner_chunk(store, layout, &location, READER, LABEL)
            .await
            .result
    }

    /// The primary seam. The twin fixtures hold the same samples, and both
    /// twins store each inner chunk with the same codec, so the bytes an
    /// inner chunk reads as out of its shard are the bytes the unsharded
    /// twin keeps as one object. Edge shards and edge chunks are in the
    /// walk, because 40 is not a multiple of the 16-sample shard, and 20
    /// and 10 are not multiples of the 8-sample chunk either.
    #[tokio::test]
    async fn every_inner_chunk_of_the_sharded_twin_reads_as_the_unsharded_twins_object() {
        let sharded = cached_store("twin-sharded.ome.zarr");
        let shards = ShardIndexCache::new();
        let unsharded = cached_store("twin-unsharded.ome.zarr");
        let cyx = axes(&["c", "y", "x"]);

        let mut compared = 0;
        for level in 0..3 {
            let (layout, keys) = sharded_twin_keys(level);
            for key in keys {
                let from_shard = read_from_shard(&shards, &sharded, &layout, &key)
                    .await
                    .unwrap();
                let object = crate::chunk_key_to_store_path(&key, &cyx, &layout.inner_chunk_shape);
                let from_object = unsharded
                    .get_bytes(&Path::from(object), READER, LABEL)
                    .await
                    .result
                    .unwrap();
                assert_eq!(from_shard, from_object, "chunk key {key}");
                assert!(!from_shard.is_empty(), "chunk key {key} read as nothing");
                compared += 1;
            }
        }
        assert_eq!(compared, 2 * (25 + 9 + 4));
    }

    fn fixture_layout_and_cache(
        name: &str,
        level: u32,
    ) -> (ShardLayout, ShardIndexCache, Arc<CachedStore>) {
        (
            fixture_layout(name, level).unwrap(),
            ShardIndexCache::new(),
            cached_store(name),
        )
    }

    /// The sparse fixture leaves a checkerboard of inner chunks out of every
    /// shard's index. Those read as the not-found a missing object reads as,
    /// which is the answer the fill path already serves. The cached store
    /// counts no failure for them, because the index read succeeded and
    /// nothing else was read.
    #[tokio::test]
    async fn an_inner_chunk_absent_from_the_index_reads_as_not_found_and_not_as_a_failure() {
        let (layout, shards, store) = fixture_layout_and_cache("sparse-sharded.ome.zarr", 0);
        let yx = axes(&["y", "x"]);
        for (key, written) in [
            ("0/0/0/0/0/0", true),
            ("0/0/0/0/0/1", false),
            ("0/0/0/0/1/0", false),
            ("0/0/0/0/1/1", true),
        ] {
            let location = layout.locate_inner_chunk(key, &yx).unwrap();
            let read = shards
                .read_inner_chunk(&store, &layout, &location, READER, LABEL)
                .await;
            match (written, read.result) {
                (true, Ok(bytes)) => assert!(!bytes.is_empty(), "{key}"),
                (false, Err(object_store::Error::NotFound { .. })) => {}
                (_, other) => panic!("{key}: expected written={written}, got {other:?}"),
            }
        }
        assert_eq!(store.stats().backend_errors, 0);
    }

    /// Level 2 of the sparse fixture is declared and never written, so its
    /// shard object is not there. Every inner chunk of it is then not found,
    /// as every chunk of an unwritten unsharded level is. The absence is
    /// remembered, so after the first inner chunk the rest cost no read.
    #[tokio::test]
    async fn every_inner_chunk_of_a_missing_shard_object_reads_as_not_found_after_one_read() {
        let (layout, shards, store) = fixture_layout_and_cache("sparse-sharded.ome.zarr", 2);
        let yx = axes(&["y", "x"]);
        for key in ["2/0/0/0/0/0", "2/0/0/0/0/1"] {
            let location = layout.locate_inner_chunk(key, &yx).unwrap();
            let read = shards
                .read_inner_chunk(&store, &layout, &location, READER, LABEL)
                .await;
            assert!(
                matches!(read.result, Err(object_store::Error::NotFound { .. })),
                "{key}: {:?}",
                read.result
            );
        }
        assert_eq!(
            store.stats().source_reads,
            1,
            "one read answered for the whole shard"
        );
    }

    /// A shard object built by hand: `chunks` in position order, `None` for
    /// an inner chunk left out of the index, with the index where `location`
    /// says and a crc32c checksum after its entries. Offsets are absolute in
    /// the object, so an index at the start pushes every chunk past itself.
    fn build_shard(chunks: &[Option<&[u8]>], location: IndexLocation) -> Vec<u8> {
        let index_len = chunks.len() * INDEX_ENTRY_BYTES as usize + CHECKSUM_BYTES as usize;
        let mut body = Vec::new();
        let mut entries = Vec::new();
        let base = match location {
            IndexLocation::Start => index_len as u64,
            IndexLocation::End => 0,
        };
        for chunk in chunks {
            match chunk {
                Some(bytes) => {
                    entries.extend_from_slice(&(base + body.len() as u64).to_le_bytes());
                    entries.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
                    body.extend_from_slice(bytes);
                }
                None => {
                    entries.extend_from_slice(&ABSENT.to_le_bytes());
                    entries.extend_from_slice(&ABSENT.to_le_bytes());
                }
            }
        }
        let checksum = crc32c::crc32c(&entries).to_le_bytes();
        let mut index = entries;
        index.extend_from_slice(&checksum);
        match location {
            IndexLocation::Start => [index, body].concat(),
            IndexLocation::End => [body, index].concat(),
        }
    }

    /// A 2x2 shard of raw inner chunks with position 2 left unwritten.
    const HAND_BUILT_CHUNKS: [Option<&[u8]>; 4] =
        [Some(b"first"), Some(b"second"), None, Some(b"fourth")];

    fn hand_built_layout(location: IndexLocation) -> ShardLayout {
        ShardLayout {
            inner_chunk_shape: vec![8, 8],
            chunks_per_shard: vec![2, 2],
            inner_compression: StorageCompression::None,
            index_location: location,
            index_checksum: true,
        }
    }

    async fn hand_built_cache(
        location: IndexLocation,
        delay_ms: u64,
    ) -> (ShardIndexCache, Arc<CachedStore>, Arc<CountingStore>) {
        let store = Arc::new(CountingStore::new(delay_ms));
        store
            .seed("0/c/0/0", build_shard(&HAND_BUILT_CHUNKS, location))
            .await;
        let cached = Arc::new(CachedStore::with_source_limiter(
            store.clone(),
            1024 * 1024,
            SourceReadLimiter::new(64),
        ));
        (ShardIndexCache::new(), cached, store)
    }

    async fn read_position(
        shards: &ShardIndexCache,
        store: &CachedStore,
        layout: &ShardLayout,
        position: usize,
    ) -> TimedRead {
        let location = ShardLocation {
            path: Path::from("0/c/0/0"),
            position,
        };
        shards
            .read_inner_chunk(store, layout, &location, READER, LABEL)
            .await
    }

    /// Whichever end the index is at, the cache finds it in one range read
    /// and never asks the object's length first. After that, each inner
    /// chunk is one more read, an absent one is none, and a repeat costs
    /// nothing.
    #[tokio::test]
    async fn the_index_is_read_once_per_shard_and_each_inner_chunk_is_one_range_read_with_no_head()
    {
        for location in [IndexLocation::End, IndexLocation::Start] {
            let layout = hand_built_layout(location);
            let (shards, cached, store) = hand_built_cache(location, 0).await;
            let gets = || store.get_count.load(Ordering::SeqCst);
            let heads = || store.head_count.load(Ordering::SeqCst);

            let first = read_position(&shards, &cached, &layout, 0).await;
            assert_eq!(&first.result.unwrap()[..], b"first", "{location:?}");
            assert_eq!(gets(), 2, "{location:?}: the index and the inner chunk");
            assert!(first.timing.backend_read_us.is_some());
            assert!(first.timing.permit_wait_us.is_some());

            let second = read_position(&shards, &cached, &layout, 1).await;
            assert_eq!(&second.result.unwrap()[..], b"second", "{location:?}");
            assert_eq!(gets(), 3, "{location:?}: one range read, no index");

            let absent = read_position(&shards, &cached, &layout, 2).await;
            assert!(matches!(
                absent.result,
                Err(object_store::Error::NotFound { .. })
            ));
            assert_eq!(
                gets(),
                3,
                "{location:?}: an absent inner chunk costs no read"
            );
            assert_eq!(absent.timing, SourceReadTiming::default());

            let fourth = read_position(&shards, &cached, &layout, 3).await;
            assert_eq!(&fourth.result.unwrap()[..], b"fourth", "{location:?}");
            assert_eq!(gets(), 4, "{location:?}");

            let repeat = read_position(&shards, &cached, &layout, 0).await;
            assert_eq!(&repeat.result.unwrap()[..], b"first", "{location:?}");
            assert_eq!(
                gets(),
                4,
                "{location:?}: a resident inner chunk is not re-read"
            );

            assert_eq!(heads(), 0, "{location:?}: no HEAD request");
        }
    }

    /// Several callers reaching a cold shard together still read its index
    /// once, because they coalesce on the cached store. Each distinct inner
    /// chunk is read at most once between them: neighbours admitted together
    /// may share one request, so the bound is what the once-per-shard claim
    /// rests on — an index read per caller would cost eight.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_reads_of_one_shard_share_one_index_read() {
        let layout = Arc::new(hand_built_layout(IndexLocation::End));
        let (shards, cached, store) = hand_built_cache(IndexLocation::End, 20).await;
        let shards = Arc::new(shards);

        let mut handles = Vec::new();
        for position in [0usize, 1, 3, 0, 1, 3, 0, 3] {
            let shards = Arc::clone(&shards);
            let cached = Arc::clone(&cached);
            let layout = Arc::clone(&layout);
            handles.push(tokio::spawn(async move {
                read_position(&shards, &cached, &layout, position)
                    .await
                    .result
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        let requests = store.get_count.load(Ordering::SeqCst);
        assert!(
            (2..=1 + 3).contains(&requests),
            "one index read and at most one read per distinct inner chunk, got {requests}"
        );
        assert_eq!(
            cached.stats().entry_count,
            1 + 3,
            "the index and each distinct inner chunk are resident once"
        );
        assert_eq!(store.head_count.load(Ordering::SeqCst), 0);
    }

    /// The merge, seen from the shard: two inner chunks that lie end to end
    /// in their shard, asked for while the only permit is held, reach the
    /// backend as one range request once it frees, and the second is a
    /// follower of the first.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn neighbouring_inner_chunks_queued_together_reach_the_backend_as_one_request() {
        let layout = Arc::new(hand_built_layout(IndexLocation::End));
        let store = Arc::new(CountingStore::new(0));
        store
            .seed(
                "0/c/0/0",
                build_shard(&HAND_BUILT_CHUNKS, IndexLocation::End),
            )
            .await;
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store.clone(),
            1024 * 1024,
            limiter.clone(),
        ));
        let shards = Arc::new(ShardIndexCache::new());

        // Remember the index first, so the reads below are inner chunks only.
        read_position(&shards, &cached, &layout, 3)
            .await
            .result
            .unwrap();
        let before = store.get_count.load(Ordering::SeqCst);

        let held = limiter.acquire(ReaderId(99)).await;
        let mut handles = Vec::new();
        for position in [0usize, 1] {
            let shards = Arc::clone(&shards);
            let cached = Arc::clone(&cached);
            let layout = Arc::clone(&layout);
            handles.push(tokio::spawn(async move {
                read_position(&shards, &cached, &layout, position).await
            }));
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while limiter.queued_reads() < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both inner chunk reads queued");
        drop(held);

        let first = handles.remove(0).await.unwrap();
        let second = handles.remove(0).await.unwrap();
        assert_eq!(&first.result.unwrap()[..], b"first");
        assert_eq!(&second.result.unwrap()[..], b"second");
        assert_eq!(
            store.get_count.load(Ordering::SeqCst) - before,
            1,
            "inner chunks 0 and 1 lie end to end and were read together"
        );
        let round_trips = [&first.timing, &second.timing]
            .iter()
            .filter(|timing| timing.backend_read_us.is_some())
            .count();
        assert_eq!(round_trips, 1, "one row owns the round trip");
        assert_eq!(cached.stats().coalesced, 1);
    }

    async fn cache_over_shard_bytes(shard: Vec<u8>) -> (ShardIndexCache, Arc<CachedStore>) {
        let store = Arc::new(CountingStore::new(0));
        store.seed("0/c/0/0", shard).await;
        (
            ShardIndexCache::new(),
            Arc::new(CachedStore::new(store, 1024 * 1024)),
        )
    }

    /// An index that does not match its checksum is not read around. The
    /// offsets in it would place inner chunks wherever the corruption says,
    /// and a wrong picture is the one thing the viewer must not serve. The
    /// error names the shard, and it is not a not-found, so it never
    /// becomes fill.
    #[tokio::test]
    async fn a_shard_index_that_fails_its_checksum_is_an_error_not_a_picture() {
        let layout = hand_built_layout(IndexLocation::End);
        let mut shard = build_shard(&HAND_BUILT_CHUNKS, IndexLocation::End);
        let index_start = shard.len() - layout.index_byte_len() as usize;
        shard[index_start] ^= 0x01;
        let (shards, store) = cache_over_shard_bytes(shard).await;

        let read = read_position(&shards, &store, &layout, 0).await;
        let error = read.result.unwrap_err();
        assert!(
            matches!(error, object_store::Error::Generic { .. }),
            "{error:?}"
        );
        let message = error.to_string();
        assert!(message.contains("crc32c"), "{message}");
        assert!(message.contains("0/c/0/0"), "{message}");
    }

    /// An object shorter than the index the metadata declares is not a
    /// shard of that layout. It fails the same way, naming both lengths.
    #[tokio::test]
    async fn a_shard_object_shorter_than_its_declared_index_is_an_error() {
        let layout = hand_built_layout(IndexLocation::Start);
        let (shards, store) = cache_over_shard_bytes(b"too short".to_vec()).await;

        let read = read_position(&shards, &store, &layout, 0).await;
        let error = read.result.unwrap_err();
        assert!(
            matches!(error, object_store::Error::Generic { .. }),
            "{error:?}"
        );
        let message = error.to_string();
        assert!(message.contains("9 bytes"), "{message}");
        assert!(message.contains("expected 68"), "{message}");
    }

    /// The committed sharded fixture's configuration, with one field
    /// rewritten, so each rejection is one edit away from a chain that is
    /// accepted.
    fn sharded_chain_with(edit: impl FnOnce(&mut serde_json::Value)) -> Vec<serde_json::Value> {
        let mut codecs = fixture_level_meta("twin-sharded.ome.zarr", 0).codecs;
        edit(&mut codecs[0]["configuration"]);
        codecs
    }

    fn layout_error(codecs: &[serde_json::Value]) -> String {
        ShardLayout::from_codec_chain(codecs, &[1, 16, 16])
            .unwrap_err()
            .to_string()
    }

    /// Each rejection names what it found, so a writer can find the field
    /// in their metadata.
    #[test]
    fn a_sharding_configuration_lucida_cannot_read_is_refused_by_name() {
        let nested = sharded_chain_with(|config| {
            config["codecs"] = serde_json::json!([{
                "name": "sharding_indexed",
                "configuration": {}
            }]);
        });
        assert!(layout_error(&nested).contains("nested sharding"));

        let inner_gzip = sharded_chain_with(|config| {
            config["codecs"][1] = serde_json::json!({"name": "gzip"});
        });
        assert!(layout_error(&inner_gzip).contains("gzip"));

        let sideways_index = sharded_chain_with(|config| {
            config["index_location"] = serde_json::json!("middle");
        });
        assert!(layout_error(&sideways_index).contains("middle"));

        let unknown_index_codec = sharded_chain_with(|config| {
            config["index_codecs"][1] = serde_json::json!({"name": "adler32"});
        });
        assert!(layout_error(&unknown_index_codec).contains("adler32"));

        let overhanging_inner = sharded_chain_with(|config| {
            config["chunk_shape"] = serde_json::json!([1, 12, 8]);
        });
        assert!(layout_error(&overhanging_inner).contains("does not tile"));

        let mut with_transpose = sharded_chain_with(|_| {});
        with_transpose.insert(0, serde_json::json!({"name": "transpose"}));
        // A chain that does not start with the sharding codec is not sharded.
        assert_eq!(
            ShardLayout::from_codec_chain(&with_transpose, &[1, 16, 16]).unwrap(),
            None
        );
        let mut trailing = sharded_chain_with(|_| {});
        trailing.push(serde_json::json!({"name": "gzip"}));
        assert!(layout_error(&trailing).contains("only codec"));
    }

    #[test]
    fn a_malformed_key_locates_nothing() {
        let layout = fixture_layout("twin-sharded.ome.zarr", 0).unwrap();
        let cyx = axes(&["c", "y", "x"]);
        assert_eq!(layout.locate_inner_chunk("0/0/1", &cyx), None);
        assert_eq!(layout.locate_inner_chunk("0/0/1/0/two/3", &cyx), None);
    }
}
