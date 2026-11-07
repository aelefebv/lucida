//! The one path a source chunk takes from its key to the bytes one wire
//! request is served.
//!
//! [`read_chunk`] resolves the location, reads it through the cached store
//! (whole, or out of its shard), decodes, fills an absent chunk, and slices
//! out the wire timepoint and channel. On a regridded level it assembles the
//! declared chunk from the stored chunks under it. The chunk handler and
//! coarse generation both call it and do none of these steps themselves.

use lucida_content::ImageId;
use lucida_protocol::ServerPhase;
use lucida_store::cache::{CachedStore, SourceReadTiming, TimedRead};
use lucida_store::import_types::Regrid;
use lucida_store::layout::ChunkByteLayout;
use lucida_store::source_limiter::{ReaderId, RequestLabel};

use crate::binding::{
    ChunkLocation, ChunkResolver, LevelInfo, parse_level_from_chunk_key, parse_t_c_from_chunk_key,
};
use crate::decode::{DecodeError, StorageCompression, decode_storage_bytes};
use crate::open_diagnostics::is_not_found;
use crate::timing::RequestProbe;

/// What one chunk key reads as.
#[derive(Debug, PartialEq, Eq)]
pub enum ChunkRead {
    /// The object store held the chunk. These are the bytes one wire request
    /// for the key is served: decoded, and cut down to the key's timepoint
    /// and channel when the on-disk chunk bundles several.
    Present(Vec<u8>),
    /// The object store held nothing at the chunk's location. That is sparse
    /// data rather than a failure, and the chunk reads as `len` bytes of
    /// fill: one wire chunk's worth of zeros. The fill is built on demand by
    /// [`ChunkRead::into_bytes`], so a caller that only needs to know the
    /// chunk is absent never allocates it.
    Absent { len: usize },
}

impl ChunkRead {
    /// The bytes to serve, whether the object store held them or not.
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            ChunkRead::Present(bytes) => bytes,
            ChunkRead::Absent { len } => vec![0; len],
        }
    }
}

/// Why a chunk read produced no bytes.
#[derive(Debug, thiserror::Error)]
pub enum ChunkReadError {
    /// The image is not in the binding, so the key has no location.
    #[error("unknown image {0}")]
    UnknownImage(ImageId),
    /// The object store answered with something other than the bytes or an
    /// absence: revoked access, a backend fault, an unreachable service.
    #[error("object store read failed: {0}")]
    ObjectStore(#[source] object_store::Error),
    /// The bytes came back and the storage compression would not undo, or
    /// undid them to the wrong size.
    #[error("decode failed: {0}")]
    Decode(#[source] DecodeError),
}

/// Read the wire chunk for `chunk_key` of `image_id`.
///
/// `reader` is the fairness class the backend read is charged to, and
/// `label` attributes a wait behind the source-read cap to a request, not
/// only a client.
///
/// `probe` is the timing row of the request this read serves, if any. The
/// read marks its dispatch, read, and decompress phases itself, because
/// only the store knows how the read stretch was spent. A read with no
/// browser bracket, such as generation, passes `None`.
pub async fn read_chunk(
    resolver: &ChunkResolver,
    store: &CachedStore,
    image_id: &ImageId,
    chunk_key: &str,
    reader: ReaderId,
    label: RequestLabel,
    mut probe: Option<&mut RequestProbe>,
) -> Result<ChunkRead, ChunkReadError> {
    let level_info = resolver
        .level_info(image_id, parse_level_from_chunk_key(chunk_key))
        .unwrap_or_else(unsliced_level_info);
    if let Some(regrid) = &level_info.regrid {
        return read_regridded_chunk(
            resolver,
            store,
            image_id,
            chunk_key,
            &level_info,
            regrid,
            reader,
            label,
            probe,
        )
        .await;
    }
    let location = resolver
        .resolve(image_id, chunk_key)
        .ok_or_else(|| ChunkReadError::UnknownImage(image_id.clone()))?;

    tracing::trace!(image = %image_id, key = chunk_key, path = %location.path(), "reading chunk");
    if let Some(probe) = probe.as_deref_mut() {
        probe.mark(ServerPhase::Dispatch);
    }
    let read = read_location(resolver, store, &location, reader, label).await;
    if let Some(probe) = probe.as_deref_mut() {
        // The cached store owns this stretch of the row: only it knows whether
        // this request led the single flight or waited on someone else's read.
        probe.record_read(read.timing);
    }
    let storage_bytes = match read.result {
        Ok(bytes) => bytes,
        Err(e) if is_not_found(&e) => {
            return Ok(ChunkRead::Absent {
                len: level_info.chunk_byte_layout.canonical_byte_size,
            });
        }
        Err(e) => return Err(ChunkReadError::ObjectStore(e)),
    };

    let wire = decode_wire_chunk(&storage_bytes, &level_info, chunk_key);
    if let Some(probe) = probe {
        probe.mark(ServerPhase::Decompress);
    }
    Ok(ChunkRead::Present(wire?))
}

async fn read_location(
    resolver: &ChunkResolver,
    store: &CachedStore,
    location: &ChunkLocation<'_>,
    reader: ReaderId,
    label: RequestLabel,
) -> TimedRead {
    match location {
        ChunkLocation::Object(path) => store.get_bytes(path, reader, label).await,
        ChunkLocation::InnerChunk { layout, location } => {
            resolver
                .shard_indexes()
                .read_inner_chunk(store, layout, location, reader, label)
                .await
        }
    }
}

/// Decode one stored chunk and cut out the key's timepoint and channel.
///
/// A chunk that decodes to another size than its stored chunk shape holds is
/// an error, not bytes to serve: the client reads every chunk at the declared
/// shape, so it would draw garbage or fail on a short buffer.
fn decode_wire_chunk(
    storage_bytes: &[u8],
    level_info: &LevelInfo,
    chunk_key: &str,
) -> Result<Vec<u8>, ChunkReadError> {
    let raw = decode_storage_bytes(storage_bytes, level_info.compression)
        .map_err(ChunkReadError::Decode)?;
    tracing::debug!(
        key = chunk_key,
        compressed = storage_bytes.len(),
        decompressed = raw.len(),
        compression = ?level_info.compression,
        "chunk decoded"
    );
    let expected = level_info.chunk_byte_layout.on_disk_byte_size;
    if expected > 0 && raw.len() != expected {
        return Err(ChunkReadError::Decode(DecodeError::WrongSize {
            expected,
            actual: raw.len(),
        }));
    }
    let (wire_t, wire_c) = parse_t_c_from_chunk_key(chunk_key);
    Ok(slice_wire_chunk(
        raw,
        &level_info.chunk_byte_layout,
        wire_t,
        wire_c,
    ))
}

/// One declared chunk of a regridded level, assembled from the stored chunks
/// it overlaps. The part past the stored level is fill, and so is any stored
/// chunk that was never written.
#[allow(clippy::too_many_arguments)]
async fn read_regridded_chunk(
    resolver: &ChunkResolver,
    store: &CachedStore,
    image_id: &ImageId,
    chunk_key: &str,
    stored: &LevelInfo,
    regrid: &Regrid,
    reader: ReaderId,
    label: RequestLabel,
    mut probe: Option<&mut RequestProbe>,
) -> Result<ChunkRead, ChunkReadError> {
    let served_len = regrid.chunk_byte_layout.canonical_byte_size;
    let axes = resolver
        .axes_names(image_id)
        .ok_or_else(|| ChunkReadError::UnknownImage(image_id.clone()))?;
    let Some(plan) = RegridPlan::new(chunk_key, axes, stored, regrid) else {
        return Ok(ChunkRead::Absent { len: served_len });
    };

    if let Some(probe) = probe.as_deref_mut() {
        probe.mark(ServerPhase::Dispatch);
    }
    let sources = plan.stored_chunks();
    let mut locations = Vec::with_capacity(sources.len());
    for source in &sources {
        let location = resolver
            .resolve(image_id, &source.key)
            .ok_or_else(|| ChunkReadError::UnknownImage(image_id.clone()))?;
        locations.push(location);
    }
    let reads = futures_util::future::join_all(
        locations
            .iter()
            .map(|location| read_location(resolver, store, location, reader, label)),
    )
    .await;
    if let Some(probe) = probe.as_deref_mut() {
        // Every stored read was this request's, so all of them go on its row.
        let timing = reads
            .iter()
            .map(|read| read.timing)
            .reduce(SourceReadTiming::followed_by)
            .unwrap_or_default();
        probe.record_read(timing);
    }

    let mut out = vec![0_u8; served_len];
    let mut any_present = false;
    for (source, read) in sources.iter().zip(reads) {
        let storage_bytes = match read.result {
            Ok(bytes) => bytes,
            Err(e) if is_not_found(&e) => continue,
            Err(e) => return Err(ChunkReadError::ObjectStore(e)),
        };
        let wire = decode_wire_chunk(&storage_bytes, stored, &source.key)?;
        plan.copy(source, &wire, &mut out);
        any_present = true;
    }
    if let Some(probe) = probe {
        probe.mark(ServerPhase::Decompress);
    }
    Ok(if any_present {
        ChunkRead::Present(out)
    } else {
        ChunkRead::Absent { len: served_len }
    })
}

/// Where one declared chunk of a regridded level lies, in samples of the
/// level, on the canonical `z`, `y`, and `x` axes.
struct RegridPlan {
    level: u64,
    t: u64,
    c: u64,
    /// The declared chunk's origin.
    origin: [u64; 3],
    /// The declared chunk's shape, which the served bytes are laid out in.
    served: [u64; 3],
    /// The declared chunk clipped to the stored level, so it spans
    /// `origin..end`.
    end: [u64; 3],
    /// The stored chunk shape.
    stored: [u64; 3],
    sample_bytes: usize,
}

/// One stored chunk that a declared chunk overlaps.
struct StoredSource {
    key: String,
    /// Its position in the stored chunk grid.
    grid: [u64; 3],
}

impl RegridPlan {
    /// `None` when the declared chunk lies wholly past the stored level or
    /// the key is malformed. Either way it reads as fill.
    fn new(chunk_key: &str, axes: &[String], stored: &LevelInfo, regrid: &Regrid) -> Option<Self> {
        let parts: Vec<u64> = chunk_key
            .split('/')
            .map(|part| part.parse().ok())
            .collect::<Option<_>>()?;
        let [level, t, c, z, y, x] = parts[..] else {
            return None;
        };
        let along = |shape: &[u64], name: &str| {
            axes.iter()
                .position(|axis| axis.eq_ignore_ascii_case(name))
                .and_then(|index| shape.get(index).copied())
                .unwrap_or(1)
                .max(1)
        };
        if t >= along(&regrid.stored_shape, "t") || c >= along(&regrid.stored_shape, "c") {
            return None;
        }
        let spatial = ["z", "y", "x"];
        let served = spatial.map(|name| along(&regrid.chunk_shape, name));
        let stored_chunk = spatial.map(|name| along(&stored.chunk_shape, name));
        let extent = spatial.map(|name| along(&regrid.stored_shape, name));
        let origin = [
            z.checked_mul(served[0])?,
            y.checked_mul(served[1])?,
            x.checked_mul(served[2])?,
        ];
        if (0..3).any(|axis| origin[axis] >= extent[axis]) {
            return None;
        }
        let end = std::array::from_fn(|axis| (origin[axis] + served[axis]).min(extent[axis]));
        let served_samples = served.iter().product::<u64>() as usize;
        Some(RegridPlan {
            level,
            t,
            c,
            origin,
            served,
            end,
            stored: stored_chunk,
            sample_bytes: regrid.chunk_byte_layout.canonical_byte_size / served_samples,
        })
    }

    fn stored_chunks(&self) -> Vec<StoredSource> {
        let range = |axis: usize| {
            self.origin[axis] / self.stored[axis]..=(self.end[axis] - 1) / self.stored[axis]
        };
        let mut sources = Vec::new();
        for gz in range(0) {
            for gy in range(1) {
                for gx in range(2) {
                    sources.push(StoredSource {
                        key: format!("{}/{}/{}/{gz}/{gy}/{gx}", self.level, self.t, self.c),
                        grid: [gz, gy, gx],
                    });
                }
            }
        }
        sources
    }

    /// Copy the part of one stored chunk that the declared chunk covers into
    /// `out`, one run along `x` per row.
    fn copy(&self, source: &StoredSource, wire: &[u8], out: &mut [u8]) {
        let base: [u64; 3] = std::array::from_fn(|axis| source.grid[axis] * self.stored[axis]);
        let lo: [u64; 3] = std::array::from_fn(|axis| self.origin[axis].max(base[axis]));
        let hi: [u64; 3] =
            std::array::from_fn(|axis| self.end[axis].min(base[axis] + self.stored[axis]));
        let run = (hi[2] - lo[2]) as usize * self.sample_bytes;
        for z in lo[0]..hi[0] {
            for y in lo[1]..hi[1] {
                let src = ((z - base[0]) * self.stored[1] + (y - base[1])) * self.stored[2]
                    + (lo[2] - base[2]);
                let dst = ((z - self.origin[0]) * self.served[1] + (y - self.origin[1]))
                    * self.served[2]
                    + (lo[2] - self.origin[2]);
                let src = src as usize * self.sample_bytes;
                let dst = dst as usize * self.sample_bytes;
                // The size check in `decode_wire_chunk` makes both ranges
                // fit; a binding that skips it gets fill rather than a panic.
                if let (Some(from), Some(to)) =
                    (wire.get(src..src + run), out.get_mut(dst..dst + run))
                {
                    to.copy_from_slice(from);
                }
            }
        }
    }
}

/// Cut the key's timepoint and channel out of a decoded on-disk chunk that
/// bundles several. A range the bytes cannot satisfy passes the chunk
/// through whole; the zero-size layout from [`unsliced_level_info`] relies
/// on that.
fn slice_wire_chunk(
    mut raw: Vec<u8>,
    layout: &ChunkByteLayout,
    wire_t: u64,
    wire_c: u64,
) -> Vec<u8> {
    let (offset, size) = layout.slice_range(wire_t, wire_c);
    if size > 0 && offset.checked_add(size).is_some_and(|end| end <= raw.len()) {
        raw.truncate(offset + size);
        raw.drain(..offset);
    }
    raw
}

/// Stand-in for a level the binding does not describe: the object's bytes
/// are the wire chunk as-is, and an absent chunk fills to nothing. Import
/// describes every level, so only a key naming a level the binding lacks or
/// a test fixture built without levels reaches this.
fn unsliced_level_info() -> LevelInfo {
    LevelInfo {
        level_index: 0,
        compression: StorageCompression::None,
        chunk_shape: Vec::new(),
        chunk_byte_layout: ChunkByteLayout {
            canonical_byte_size: 0,
            on_disk_byte_size: 0,
            byte_stride_t: 0,
            byte_stride_c: 0,
            chunk_size_t: 1,
            chunk_size_c: 1,
        },
        shard: None,
        regrid: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use lucida_protocol::{PHASE_UNSET, TimingRowFamily, TimingRowOutcome};
    use lucida_store::import_types::ServerBindingSeed;
    use lucida_store::shard::{IndexLocation, ShardLayout};
    use object_store::ObjectStore;
    use object_store::path::Path;

    use super::*;
    use crate::test_fixtures::{
        DelayedStore, FailingStore, StoreFailure, four_byte_level, image_seed,
    };
    use crate::timing::TimingBuffer;

    const IMAGE: &str = "img";

    fn image_id() -> ImageId {
        ImageId(IMAGE.into())
    }

    fn channel_bundled_level() -> LevelInfo {
        LevelInfo {
            level_index: 0,
            compression: StorageCompression::None,
            chunk_shape: vec![1, 2, 1, 1, 2],
            chunk_byte_layout: ChunkByteLayout {
                canonical_byte_size: 4,
                on_disk_byte_size: 8,
                byte_stride_t: 0,
                byte_stride_c: 4,
                chunk_size_t: 1,
                chunk_size_c: 2,
            },
            shard: None,
            regrid: None,
        }
    }

    /// Two timepoints of two samples per on-disk chunk: the same eight bytes
    /// as [`channel_bundled_level`], bundled along `t` instead of `c`.
    fn timepoint_bundled_level() -> LevelInfo {
        LevelInfo {
            chunk_shape: vec![2, 1, 1, 1, 2],
            chunk_byte_layout: ChunkByteLayout {
                byte_stride_t: 4,
                byte_stride_c: 0,
                chunk_size_t: 2,
                chunk_size_c: 1,
                ..channel_bundled_level().chunk_byte_layout
            },
            ..channel_bundled_level()
        }
    }

    /// `level` packed two inner chunks to a shard along `x`, so a wire key's
    /// `x` of 0 to 3 names shard `x / 2`, position `x % 2`.
    fn sharded(level: LevelInfo) -> LevelInfo {
        LevelInfo {
            shard: Some(ShardLayout {
                inner_chunk_shape: level.chunk_shape.clone(),
                chunks_per_shard: vec![1, 1, 1, 1, 2],
                inner_compression: StorageCompression::None,
                index_location: IndexLocation::End,
                index_checksum: false,
            }),
            ..level
        }
    }

    /// A shard laid out as [`sharded`] declares: `chunks` in position order,
    /// `None` for an inner chunk the index marks absent.
    fn build_shard(chunks: &[Option<&[u8]>]) -> Vec<u8> {
        let mut body = Vec::new();
        let mut index = Vec::new();
        for chunk in chunks {
            let (offset, len) = match chunk {
                Some(bytes) => {
                    let offset = body.len() as u64;
                    body.extend_from_slice(bytes);
                    (offset, bytes.len() as u64)
                }
                None => (u64::MAX, u64::MAX),
            };
            index.extend_from_slice(&offset.to_le_bytes());
            index.extend_from_slice(&len.to_le_bytes());
        }
        body.extend_from_slice(&index);
        body
    }

    /// Shard 0 holds inner chunk `x = 0` and leaves `x = 1` unwritten; shard
    /// 1 holds `x = 2` and `x = 3`. Each inner chunk is two four-byte
    /// slices, one per bundled channel or timepoint.
    async fn seed_bundled_shards(store: &impl ObjectStore) {
        for (shard, chunks) in [
            ("0/c/0/0/0/0/0", [Some(&[1, 2, 3, 4, 5, 6, 7, 8][..]), None]),
            (
                "0/c/0/0/0/0/1",
                [
                    Some(&[11, 12, 13, 14, 15, 16, 17, 18][..]),
                    Some(&[21, 22, 23, 24, 25, 26, 27, 28][..]),
                ],
            ),
        ] {
            store
                .put(&Path::from(shard), build_shard(&chunks).into())
                .await
                .unwrap();
        }
    }

    fn resolver_with(levels: Vec<LevelInfo>) -> ChunkResolver {
        ChunkResolver::new(&image_seed(IMAGE, levels))
    }

    fn cached(store: impl ObjectStore) -> CachedStore {
        CachedStore::new(Arc::new(store), 1024)
    }

    async fn put_chunk(
        store: &impl ObjectStore,
        resolver: &ChunkResolver,
        key: &str,
        bytes: &[u8],
    ) {
        let location = resolver.resolve(&image_id(), key).unwrap();
        store
            .put(location.path(), bytes.to_vec().into())
            .await
            .unwrap();
    }

    async fn read(
        resolver: &ChunkResolver,
        store: &CachedStore,
        key: &str,
    ) -> Result<ChunkRead, ChunkReadError> {
        read_chunk(
            resolver,
            store,
            &image_id(),
            key,
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn present_chunk_reads_as_its_bytes() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &[1, 2, 3, 4]).await;

        let read = read(&resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap();

        assert_eq!(read, ChunkRead::Present(vec![1, 2, 3, 4]));
    }

    #[tokio::test]
    async fn absent_chunk_reads_as_one_wire_chunk_of_fill() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = cached(object_store::memory::InMemory::new());

        let read = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap();

        assert_eq!(read, ChunkRead::Absent { len: 4 });
        assert_eq!(read.into_bytes(), vec![0; 4]);
    }

    #[tokio::test]
    async fn unknown_image_has_no_location() {
        let resolver = ChunkResolver::new(&ServerBindingSeed { images: vec![] });
        let store = cached(object_store::memory::InMemory::new());

        let error = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap_err();

        assert!(matches!(error, ChunkReadError::UnknownImage(id) if id == image_id()));
    }

    #[tokio::test]
    async fn compressed_chunk_is_decoded() {
        let mut level = four_byte_level();
        level.compression = StorageCompression::Lz4;
        let resolver = resolver_with(vec![level]);
        let store = object_store::memory::InMemory::new();
        let compressed = lz4_flex::compress_prepend_size(&[7, 7, 7, 7]);
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &compressed).await;

        let read = read(&resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap();

        assert_eq!(read, ChunkRead::Present(vec![7, 7, 7, 7]));
    }

    #[tokio::test]
    async fn undecodable_bytes_are_a_decode_error() {
        let mut level = four_byte_level();
        level.compression = StorageCompression::Lz4;
        let resolver = resolver_with(vec![level]);
        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &[0, 0, 0, 0, 1, 2, 3]).await;

        let error = read(&resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap_err();

        assert!(matches!(error, ChunkReadError::Decode(_)));
    }

    #[tokio::test]
    async fn object_store_fault_is_an_error_and_not_an_absence() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = cached(FailingStore(StoreFailure::Backend));

        let error = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap_err();

        assert!(matches!(error, ChunkReadError::ObjectStore(_)));
    }

    #[tokio::test]
    async fn bundled_channel_is_sliced_out_of_the_on_disk_chunk() {
        let resolver = resolver_with(vec![channel_bundled_level()]);
        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &[1, 2, 3, 4, 5, 6, 7, 8]).await;
        let store = cached(store);

        let channel_0 = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap();
        let channel_1 = read(&resolver, &store, "0/0/1/0/0/0").await.unwrap();

        assert_eq!(channel_0, ChunkRead::Present(vec![1, 2, 3, 4]));
        assert_eq!(channel_1, ChunkRead::Present(vec![5, 6, 7, 8]));
    }

    /// A bundled channel or timepoint is sliced out of a decoded inner chunk
    /// exactly as out of an object, so bundling and sharding compose.
    #[tokio::test]
    async fn inner_chunk_is_read_out_of_its_shard_and_its_bundled_channel_or_timepoint_sliced() {
        let bundles = [
            (
                "channel",
                channel_bundled_level(),
                ["0/0/0/0/0/0", "0/0/1/0/0/0", "0/0/0/0/0/2", "0/0/1/0/0/3"],
            ),
            (
                "timepoint",
                timepoint_bundled_level(),
                ["0/0/0/0/0/0", "0/1/0/0/0/0", "0/0/0/0/0/2", "0/1/0/0/0/3"],
            ),
        ];
        let expected = [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
            [11, 12, 13, 14],
            [25, 26, 27, 28],
        ];
        for (bundle, level, keys) in bundles {
            let resolver = resolver_with(vec![sharded(level)]);
            let store = object_store::memory::InMemory::new();
            seed_bundled_shards(&store).await;
            let store = cached(store);

            for (key, expected) in keys.iter().zip(expected) {
                let read = read(&resolver, &store, key).await.unwrap();
                assert_eq!(
                    read,
                    ChunkRead::Present(expected.to_vec()),
                    "{bundle} bundle, key {key}"
                );
            }
        }
    }

    #[tokio::test]
    async fn inner_chunk_absent_from_the_index_reads_as_one_wire_chunk_of_fill() {
        let resolver = resolver_with(vec![sharded(channel_bundled_level())]);
        let store = object_store::memory::InMemory::new();
        seed_bundled_shards(&store).await;
        let store = cached(store);

        for key in ["0/0/0/0/0/1", "0/0/1/0/0/1"] {
            let read = read(&resolver, &store, key).await.unwrap();
            assert_eq!(read, ChunkRead::Absent { len: 4 }, "{key}");
        }
        assert_eq!(store.stats().backend_errors, 0);
    }

    #[tokio::test]
    async fn level_without_binding_info_passes_the_object_through() {
        let resolver = resolver_with(vec![]);
        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &[9, 8, 7]).await;

        let read = read(&resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap();

        assert_eq!(read, ChunkRead::Present(vec![9, 8, 7]));
    }

    async fn phases_for(
        resolver: &ChunkResolver,
        store: &CachedStore,
        key: &str,
    ) -> lucida_protocol::ServerTimingBatch {
        let buffer = Arc::new(TimingBuffer::new());
        let mut probe = RequestProbe::arrived(
            1,
            TimingRowFamily::Chunk,
            Instant::now(),
            Arc::clone(&buffer),
        );
        let _ = read_chunk(
            resolver,
            store,
            &image_id(),
            key,
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
            Some(&mut probe),
        )
        .await;
        probe.finish(TimingRowOutcome::Delivered);
        buffer.take_batch().expect("the read filed a row")
    }

    #[tokio::test]
    async fn present_read_marks_dispatch_read_and_decompress() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &[1, 2, 3, 4]).await;

        let batch = phases_for(&resolver, &cached(store), "0/0/0/0/0/0").await;

        for phase in [
            ServerPhase::Dispatch,
            ServerPhase::CacheLookup,
            ServerPhase::BackendRead,
            ServerPhase::Decompress,
        ] {
            assert_ne!(batch.column(phase)[0], PHASE_UNSET, "{phase:?} is stamped");
        }
    }

    /// Every backend read is held for a fixed delay, so the two rows are told
    /// apart by time. The lower bounds cannot fail, since a sleep never ends
    /// early; the upper bound on the second read grants a whole delay again
    /// to the overhead of one in-memory read.
    #[tokio::test]
    async fn first_read_from_a_shard_accounts_for_the_index_read_and_the_second_does_not() {
        const DELAY: Duration = Duration::from_millis(100);
        let resolver = resolver_with(vec![sharded(channel_bundled_level())]);
        let store = DelayedStore::new(DELAY);
        seed_bundled_shards(&store).await;
        let store = cached(store);
        let one_read = DELAY.as_micros() as u32;

        let first = phases_for(&resolver, &store, "0/0/0/0/0/2").await;
        let second = phases_for(&resolver, &store, "0/0/0/0/0/3").await;

        let first_read = first.column(ServerPhase::BackendRead)[0];
        let second_read = second.column(ServerPhase::BackendRead)[0];
        assert!(
            first_read >= 2 * one_read,
            "the first read carries the index read and the inner chunk read: {first_read} us"
        );
        assert!(
            (one_read..2 * one_read).contains(&second_read),
            "the second read carries the inner chunk read alone: {second_read} us"
        );
        assert_eq!(store.stats().source_reads, 3);
    }

    #[tokio::test]
    async fn absent_read_never_reaches_decompress() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = cached(object_store::memory::InMemory::new());

        let batch = phases_for(&resolver, &store, "0/0/0/0/0/0").await;

        assert_ne!(batch.column(ServerPhase::Dispatch)[0], PHASE_UNSET);
        assert_eq!(batch.column(ServerPhase::Decompress)[0], PHASE_UNSET);
    }

    #[tokio::test]
    async fn unknown_image_leaves_every_phase_past_the_lookup_unset() {
        let resolver = ChunkResolver::new(&ServerBindingSeed { images: vec![] });
        let store = cached(object_store::memory::InMemory::new());

        let batch = phases_for(&resolver, &store, "0/0/0/0/0/0").await;

        assert_eq!(batch.column(ServerPhase::Dispatch)[0], PHASE_UNSET);
        assert_eq!(batch.column(ServerPhase::Decompress)[0], PHASE_UNSET);
    }

    /// A 3×3 level of two channels, stored in 2×2 chunks of one byte per
    /// sample and served at a declared 4×4 chunk.
    fn regridded_level() -> LevelInfo {
        let layout = |bytes| ChunkByteLayout {
            canonical_byte_size: bytes,
            on_disk_byte_size: bytes,
            byte_stride_t: 0,
            byte_stride_c: 0,
            chunk_size_t: 1,
            chunk_size_c: 1,
        };
        LevelInfo {
            level_index: 0,
            compression: StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 2, 2],
            chunk_byte_layout: layout(4),
            shard: None,
            regrid: Some(Regrid {
                chunk_shape: vec![1, 1, 1, 4, 4],
                chunk_byte_layout: layout(16),
                stored_shape: vec![1, 2, 1, 3, 3],
            }),
        }
    }

    fn sample(c: u64, y: u64, x: u64) -> u8 {
        (10 * c + 3 * y + x + 1) as u8
    }

    /// One stored 2×2 chunk. The samples past the 3×3 level hold 99, which a
    /// served chunk must never contain.
    fn stored_chunk(c: u64, gy: u64, gx: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        for y in gy * 2..gy * 2 + 2 {
            for x in gx * 2..gx * 2 + 2 {
                bytes.push(if y < 3 && x < 3 { sample(c, y, x) } else { 99 });
            }
        }
        bytes
    }

    /// The declared 4×4 chunk at the origin: the 3×3 level, with fill past it
    /// and where the stored chunk at `missing` was never written.
    fn declared_picture(c: u64, missing: Option<(u64, u64)>) -> Vec<u8> {
        let mut out = vec![0; 16];
        for y in 0..3 {
            for x in 0..3 {
                if missing != Some((y / 2, x / 2)) {
                    out[(y * 4 + x) as usize] = sample(c, y, x);
                }
            }
        }
        out
    }

    async fn seed_stored_chunks(
        store: &impl ObjectStore,
        resolver: &ChunkResolver,
        missing: Option<(u64, u64)>,
    ) {
        for c in 0..2 {
            for gy in 0..2 {
                for gx in 0..2 {
                    if missing != Some((gy, gx)) {
                        let key = format!("0/0/{c}/0/{gy}/{gx}");
                        put_chunk(store, resolver, &key, &stored_chunk(c, gy, gx)).await;
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn a_regridded_chunk_is_assembled_from_the_stored_chunks_it_overlaps() {
        let resolver = resolver_with(vec![regridded_level()]);
        let store = object_store::memory::InMemory::new();
        seed_stored_chunks(&store, &resolver, None).await;
        let store = cached(store);

        for c in 0..2 {
            let read = read(&resolver, &store, &format!("0/0/{c}/0/0/0"))
                .await
                .unwrap();
            assert_eq!(read, ChunkRead::Present(declared_picture(c, None)), "c={c}");
        }
    }

    #[tokio::test]
    async fn an_unwritten_stored_chunk_reads_as_fill_inside_a_regridded_chunk() {
        let resolver = resolver_with(vec![regridded_level()]);
        let store = object_store::memory::InMemory::new();
        seed_stored_chunks(&store, &resolver, Some((1, 1))).await;

        let read = read(&resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap();

        assert_eq!(read, ChunkRead::Present(declared_picture(0, Some((1, 1)))));
    }

    #[tokio::test]
    async fn a_regridded_chunk_with_nothing_stored_under_it_reads_as_fill() {
        let resolver = resolver_with(vec![regridded_level()]);
        let store = object_store::memory::InMemory::new();
        seed_stored_chunks(&store, &resolver, None).await;
        let store = cached(store);

        // Past the stored channels, past the stored rows, and over chunks
        // that were never written.
        for key in ["0/0/2/0/0/0", "0/0/0/0/1/0"] {
            let read = read(&resolver, &store, key).await.unwrap();
            assert_eq!(read, ChunkRead::Absent { len: 16 }, "{key}");
        }
        let empty = cached(object_store::memory::InMemory::new());
        let read = read(&resolver, &empty, "0/0/0/0/0/0").await.unwrap();
        assert_eq!(read, ChunkRead::Absent { len: 16 });
    }

    #[tokio::test]
    async fn a_regridded_level_reads_its_stored_chunks_out_of_their_shards() {
        let level = LevelInfo {
            shard: Some(ShardLayout {
                inner_chunk_shape: vec![1, 1, 1, 2, 2],
                chunks_per_shard: vec![1, 1, 1, 1, 2],
                inner_compression: StorageCompression::None,
                index_location: IndexLocation::End,
                index_checksum: false,
            }),
            ..regridded_level()
        };
        let resolver = resolver_with(vec![level]);
        let store = object_store::memory::InMemory::new();
        for c in 0..2 {
            for gy in 0..2 {
                let shard = build_shard(&[
                    Some(&stored_chunk(c, gy, 0)[..]),
                    Some(&stored_chunk(c, gy, 1)[..]),
                ]);
                put_chunk(&store, &resolver, &format!("0/0/{c}/0/{gy}/0"), &shard).await;
            }
        }
        let store = cached(store);

        for c in 0..2 {
            let read = read(&resolver, &store, &format!("0/0/{c}/0/0/0"))
                .await
                .unwrap();
            assert_eq!(read, ChunkRead::Present(declared_picture(c, None)), "c={c}");
        }
    }

    #[tokio::test]
    async fn a_chunk_that_decodes_to_another_size_than_its_shape_holds_is_an_error() {
        let resolver = resolver_with(vec![four_byte_level()]);
        for bytes in [&[1, 2][..], &[1, 2, 3, 4, 5, 6][..]] {
            let store = object_store::memory::InMemory::new();
            put_chunk(&store, &resolver, "0/0/0/0/0/0", bytes).await;

            let error = read(&resolver, &cached(store), "0/0/0/0/0/0")
                .await
                .unwrap_err();

            assert!(
                matches!(
                    error,
                    ChunkReadError::Decode(DecodeError::WrongSize { expected: 4, actual })
                        if actual == bytes.len()
                ),
                "{bytes:?}: {error:?}"
            );
        }
    }
}
