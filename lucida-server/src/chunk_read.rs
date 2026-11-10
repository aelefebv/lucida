//! The one path a source chunk takes from its key to the bytes one wire
//! request is served.
//!
//! [`fetch_chunk`] resolves the location and reads it through the cached
//! store, whole or out of its shard. [`FetchedChunk::decode`] decodes, fills
//! an absent chunk, and slices out the wire timepoint and channel. On a
//! regridded level it assembles the declared chunk from the stored chunks
//! under it. [`read_chunk`] does both, the decode on the [`DecodePool`]. For
//! a client that decodes the stored codecs itself, [`FetchedChunk::relayable`]
//! hands over the stored bytes instead. The chunk handler and coarse
//! generation go through these and do none of the steps themselves.

use bytes::Bytes;
use lucida_content::{ChunkKey, ImageId};
use lucida_protocol::codec::{BytesCodec, CodecSet};
use lucida_protocol::{ChunkFailureKind, ServerPhase};
use lucida_store::cache::{CachedStore, SourceReadTiming, TimedRead};
use lucida_store::codec::{ByteOrder, StorageCompression};
use lucida_store::fill::FillValue;
use lucida_store::import_types::Regrid;
use lucida_store::layout::ChunkByteLayout;
use lucida_store::source_limiter::{ReaderId, RequestLabel};

use crate::binding::{ChunkLocation, ChunkResolver, LevelInfo};
use crate::decode::{DecodeError, decode_storage_bytes};
use crate::decode_pool::DecodePool;
use crate::open_diagnostics::is_not_found;
use crate::timing::RequestProbe;
use crate::wire_chunk::saves_enough;

/// What one chunk key reads as.
#[derive(Debug, PartialEq, Eq)]
pub enum ChunkRead {
    /// The object store held the chunk. These are the bytes one wire request
    /// for the key is served: decoded, and cut down to the key's timepoint
    /// and channel when the on-disk chunk bundles several.
    Present(Vec<u8>),
    /// The object store held nothing at the chunk's location. That is sparse
    /// data rather than a failure, and the chunk reads as `len` bytes of
    /// fill: one wire chunk's worth of the array's fill value. The fill is
    /// built on demand by [`ChunkRead::into_bytes`], so a caller that only
    /// needs to know the chunk is absent never allocates it.
    Absent { len: usize, fill: FillValue },
}

impl ChunkRead {
    /// The bytes to serve, whether the object store held them or not.
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            ChunkRead::Present(bytes) => bytes,
            ChunkRead::Absent { len, fill } => fill.bytes(len),
        }
    }
}

/// Why a chunk read produced no bytes.
#[derive(Debug, thiserror::Error)]
pub enum ChunkReadError {
    /// The image is not in the binding, so the key has no location.
    #[error("unknown image {0}")]
    UnknownImage(ImageId),
    /// The image has no level of the key's index, so the key has no layout
    /// to read it by.
    #[error("image {image} has no level {level}")]
    UnknownLevel { image: ImageId, level: u32 },
    /// The object store answered with something other than the bytes or an
    /// absence: revoked access, a backend fault, an unreachable service.
    #[error("object store read failed: {0}")]
    ObjectStore(#[source] object_store::Error),
    /// The bytes came back and the storage compression would not undo, or
    /// undid them to the wrong size.
    #[error("decode failed: {0}")]
    Decode(#[source] DecodeError),
}

impl ChunkReadError {
    /// The failure as a client is told it.
    pub fn failure_kind(&self) -> ChunkFailureKind {
        match self {
            ChunkReadError::UnknownImage(_) => ChunkFailureKind::UnknownImage,
            ChunkReadError::UnknownLevel { .. } => ChunkFailureKind::UnknownLevel,
            ChunkReadError::ObjectStore(
                object_store::Error::PermissionDenied { .. }
                | object_store::Error::Unauthenticated { .. },
            ) => ChunkFailureKind::Permission,
            ChunkReadError::ObjectStore(_) => ChunkFailureKind::StorageBackend,
            ChunkReadError::Decode(e) => e.failure_kind(),
        }
    }
}

/// A source chunk read from the object store and not yet decoded.
///
/// Reading is I/O and decoding is CPU work, so the two come apart here and
/// the caller chooses the thread the decode runs on.
pub struct FetchedChunk(Fetched);

enum Fetched {
    /// The chunk reads as fill, so there is nothing to decode.
    Absent { len: usize, fill: FillValue },
    Stored {
        bytes: Bytes,
        level: LevelInfo,
        key: ChunkKey,
    },
    /// The stored chunks one declared chunk of a regridded level overlaps,
    /// with `None` for a stored chunk that was never written.
    Regridded {
        plan: RegridPlan,
        stored: LevelInfo,
        reads: Vec<(StoredSource, Option<Bytes>)>,
        len: usize,
        fill: FillValue,
    },
}

impl FetchedChunk {
    /// The stored bytes and the codecs they are in, when a client that
    /// decodes `codecs` can be sent them as they are. The client decodes them
    /// against its level's chunk size, so the stored chunk must be exactly one
    /// wire chunk, and the chain must leave its samples little-endian and in C
    /// order, as the wire carries them. A chunk that bundles timepoints or
    /// channels, a regridded one, a transposed or big-endian one, or one that
    /// saves too little of the link is `None`: decode it.
    pub fn relayable(&self, codecs: CodecSet) -> Option<(&[u8], &[BytesCodec])> {
        let Fetched::Stored { bytes, level, .. } = &self.0 else {
            return None;
        };
        let StorageCompression::Codecs(chain) = &level.compression else {
            return None;
        };
        let layout = &level.chunk_byte_layout;
        let samples_as_wired = chain.array_to_array.is_empty()
            && (chain.byte_order == ByteOrder::Little || chain.sample_size <= 1);
        (samples_as_wired
            && layout.on_disk_byte_size == layout.canonical_byte_size
            && codecs.decodes(&chain.bytes_to_bytes)
            && saves_enough(bytes.len(), layout.canonical_byte_size))
        .then_some((bytes.as_ref(), chain.bytes_to_bytes.as_slice()))
    }

    /// The bytes one wire request for the key is served, or why there are
    /// none. `probe` gets the decompress phase when there was anything to
    /// decompress.
    pub fn decode(self, probe: Option<&mut RequestProbe>) -> Result<ChunkRead, ChunkReadError> {
        let decoded = match self.0 {
            Fetched::Absent { len, fill } => return Ok(ChunkRead::Absent { len, fill }),
            Fetched::Stored { bytes, level, key } => {
                decode_wire_chunk(&bytes, &level, &key).map(ChunkRead::Present)
            }
            Fetched::Regridded {
                plan,
                stored,
                reads,
                len,
                fill,
            } => assemble_regridded_chunk(&plan, &stored, &reads, len, fill),
        };
        if let Some(probe) = probe {
            probe.mark(ServerPhase::Decompress);
        }
        decoded
    }
}

/// Read and decode the wire chunk for `chunk_key` of `image_id`, the decode
/// on the [`DecodePool`] in `reader`'s turn. For `label`, see
/// [`fetch_chunk`].
pub async fn read_chunk(
    resolver: &ChunkResolver,
    store: &CachedStore,
    image_id: &ImageId,
    chunk_key: &ChunkKey,
    reader: ReaderId,
    label: RequestLabel,
) -> Result<ChunkRead, ChunkReadError> {
    let fetched = fetch_chunk(resolver, store, image_id, chunk_key, reader, label, None).await?;
    DecodePool::global()
        .run(reader, move || fetched.decode(None))
        .await
}

/// Read the stored bytes behind `chunk_key` of `image_id`.
///
/// `reader` is the fairness class the backend read is charged to, and
/// `label` attributes a wait behind the source-read cap to a request, not
/// only a client.
///
/// `probe` is the timing row of the request this read serves, if any. The
/// read marks its dispatch and read phases itself, because only the store
/// knows how the read stretch was spent. A read with no browser bracket,
/// such as generation, passes `None`.
pub async fn fetch_chunk(
    resolver: &ChunkResolver,
    store: &CachedStore,
    image_id: &ImageId,
    chunk_key: &ChunkKey,
    reader: ReaderId,
    label: RequestLabel,
    mut probe: Option<&mut RequestProbe>,
) -> Result<FetchedChunk, ChunkReadError> {
    let Some(level_info) = resolver.level_info(image_id, chunk_key.level) else {
        return Err(if resolver.axes_names(image_id).is_some() {
            ChunkReadError::UnknownLevel {
                image: image_id.clone(),
                level: chunk_key.level,
            }
        } else {
            ChunkReadError::UnknownImage(image_id.clone())
        });
    };
    if let Some(regrid) = &level_info.regrid {
        return fetch_regridded_chunk(
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

    tracing::trace!(image = %image_id, key = %chunk_key, path = %location.path(), "reading chunk");
    if let Some(probe) = probe.as_deref_mut() {
        probe.mark(ServerPhase::Dispatch);
    }
    let read = read_location(resolver, store, &location, &level_info, reader, label).await;
    if let Some(probe) = probe {
        // The cached store owns this stretch of the row: only it knows whether
        // this request led the single flight or waited on someone else's read.
        probe.record_read(read.timing);
    }
    let fetched = match read.result {
        Ok(bytes) => Fetched::Stored {
            bytes,
            level: level_info,
            key: *chunk_key,
        },
        Err(e) if is_not_found(&e) => Fetched::Absent {
            len: level_info.chunk_byte_layout.canonical_byte_size,
            fill: level_info.fill_value,
        },
        Err(e) => return Err(ChunkReadError::ObjectStore(e)),
    };
    Ok(FetchedChunk(fetched))
}

/// `level` is the stored level the location is in. A whole stored chunk
/// is expected to move no more than its decoded size, which is what its read
/// is charged against the source-read bound.
async fn read_location(
    resolver: &ChunkResolver,
    store: &CachedStore,
    location: &ChunkLocation<'_>,
    level: &LevelInfo,
    reader: ReaderId,
    label: RequestLabel,
) -> TimedRead {
    match location {
        ChunkLocation::Object(path) => {
            let expected_len = level.chunk_byte_layout.on_disk_byte_size as u64;
            store
                .get_bytes_sized(path, expected_len, reader, label)
                .await
        }
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
    chunk_key: &ChunkKey,
) -> Result<Vec<u8>, ChunkReadError> {
    let expected = level_info.chunk_byte_layout.on_disk_byte_size;
    let raw = decode_storage_bytes(
        storage_bytes,
        &level_info.compression,
        &level_info.chunk_shape,
        expected,
    )
    .map_err(ChunkReadError::Decode)?;
    tracing::debug!(
        key = %chunk_key,
        compressed = storage_bytes.len(),
        decompressed = raw.len(),
        compression = ?level_info.compression,
        "chunk decoded"
    );
    if raw.len() != expected {
        return Err(ChunkReadError::Decode(DecodeError::WrongSize {
            expected,
            actual: raw.len(),
        }));
    }
    Ok(slice_wire_chunk(
        raw,
        &level_info.chunk_byte_layout,
        chunk_key.t,
        chunk_key.c,
    ))
}

/// The stored chunks one declared chunk of a regridded level overlaps. The
/// part past the stored level is fill, and so is any stored chunk that was
/// never written.
#[allow(clippy::too_many_arguments)]
async fn fetch_regridded_chunk(
    resolver: &ChunkResolver,
    store: &CachedStore,
    image_id: &ImageId,
    chunk_key: &ChunkKey,
    stored: &LevelInfo,
    regrid: &Regrid,
    reader: ReaderId,
    label: RequestLabel,
    mut probe: Option<&mut RequestProbe>,
) -> Result<FetchedChunk, ChunkReadError> {
    let len = regrid.chunk_byte_layout.canonical_byte_size;
    let fill = stored.fill_value;
    let axes = resolver
        .axes_names(image_id)
        .ok_or_else(|| ChunkReadError::UnknownImage(image_id.clone()))?;
    let Some(plan) = RegridPlan::new(*chunk_key, axes, stored, regrid) else {
        return Ok(FetchedChunk(Fetched::Absent { len, fill }));
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
            .map(|location| read_location(resolver, store, location, stored, reader, label)),
    )
    .await;
    if let Some(probe) = probe {
        // Every stored read was this request's, so all of them go on its row.
        let timing = reads
            .iter()
            .map(|read| read.timing)
            .reduce(SourceReadTiming::followed_by)
            .unwrap_or_default();
        probe.record_read(timing);
    }

    let mut stored_reads = Vec::with_capacity(sources.len());
    for (source, read) in sources.into_iter().zip(reads) {
        let bytes = match read.result {
            Ok(bytes) => Some(bytes),
            Err(e) if is_not_found(&e) => None,
            Err(e) => return Err(ChunkReadError::ObjectStore(e)),
        };
        stored_reads.push((source, bytes));
    }
    Ok(FetchedChunk(Fetched::Regridded {
        plan,
        stored: stored.clone(),
        reads: stored_reads,
        len,
        fill,
    }))
}

/// One declared chunk of a regridded level, assembled from the stored chunks
/// it overlaps.
fn assemble_regridded_chunk(
    plan: &RegridPlan,
    stored: &LevelInfo,
    reads: &[(StoredSource, Option<Bytes>)],
    len: usize,
    fill: FillValue,
) -> Result<ChunkRead, ChunkReadError> {
    let mut out = fill.bytes(len);
    let mut any_present = false;
    for (source, bytes) in reads {
        let Some(bytes) = bytes else { continue };
        let wire = decode_wire_chunk(bytes, stored, &source.key)?;
        plan.copy(source, &wire, &mut out);
        any_present = true;
    }
    Ok(if any_present {
        ChunkRead::Present(out)
    } else {
        ChunkRead::Absent { len, fill }
    })
}

/// Where one declared chunk of a regridded level lies, in samples of the
/// level, on the canonical `z`, `y`, and `x` axes.
struct RegridPlan {
    key: ChunkKey,
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
    key: ChunkKey,
    /// Its position in the stored chunk grid.
    grid: [u64; 3],
}

impl RegridPlan {
    /// `None` when the declared chunk lies wholly past the stored level,
    /// which reads as fill.
    fn new(key: ChunkKey, axes: &[String], stored: &LevelInfo, regrid: &Regrid) -> Option<Self> {
        let ChunkKey { t, c, z, y, x, .. } = key;
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
            key,
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
                        key: ChunkKey {
                            z: gz,
                            y: gy,
                            x: gx,
                            ..self.key
                        },
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
/// through whole.
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use lucida_protocol::{PHASE_UNSET, TimingRowFamily, TimingRowOutcome};
    use lucida_store::import_types::ServerBindingSeed;
    use lucida_store::shard::{IndexLocation, ShardLayout};
    use object_store::path::Path;
    use object_store::{ObjectStore, ObjectStoreExt};

    use super::*;
    use crate::decode::StorageCompression;
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
            path: "0".to_string(),
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
            chunk_key_encoding: Default::default(),
            fill_value: Default::default(),
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

    fn key(key: &str) -> ChunkKey {
        ChunkKey::parse(key).unwrap()
    }

    async fn put_chunk(
        store: &impl ObjectStore,
        resolver: &ChunkResolver,
        key: &str,
        bytes: &[u8],
    ) {
        let location = resolver.resolve(&image_id(), &self::key(key)).unwrap();
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
            &self::key(key),
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
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

    /// An absent chunk is valid data, so the source's health counts it as
    /// absent and never as a failed read.
    #[tokio::test]
    async fn absent_chunk_reads_as_one_wire_chunk_of_fill() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = cached(object_store::memory::InMemory::new());

        let read = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap();

        assert_eq!(
            read,
            ChunkRead::Absent {
                len: 4,
                fill: FillValue::default()
            }
        );
        assert_eq!(read.into_bytes(), vec![0; 4]);
        assert_eq!(store.stats().backend_errors, 0);
        assert_eq!(store.stats().absent_reads, 1);
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
        level.compression = StorageCompression::compressed(lucida_store::codec::BytesCodec::Lz4, 2);
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
        level.compression = StorageCompression::compressed(lucida_store::codec::BytesCodec::Lz4, 2);
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
        for failure in [StoreFailure::Backend, StoreFailure::PermissionDenied] {
            let store = cached(FailingStore(failure));

            let error = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap_err();

            assert!(matches!(error, ChunkReadError::ObjectStore(_)));
            assert_eq!(store.stats().backend_errors, 1, "{error}");
            assert_eq!(store.stats().absent_reads, 0, "{error}");
        }
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
            assert_eq!(
                read,
                ChunkRead::Absent {
                    len: 4,
                    fill: FillValue::default()
                },
                "{key}"
            );
        }
        assert_eq!(store.stats().backend_errors, 0);
        assert_eq!(store.stats().absent_reads, 0, "the index answered both");
    }

    /// A shard that was never written, as in an unwritten sharded level, reads
    /// as fill for every inner chunk in it, after one absent read and no
    /// failed one.
    #[tokio::test]
    async fn every_inner_chunk_of_a_missing_shard_reads_as_fill_after_one_absent_read() {
        let resolver = resolver_with(vec![sharded(channel_bundled_level())]);
        let store = cached(object_store::memory::InMemory::new());

        for key in ["0/0/0/0/0/0", "0/0/0/0/0/1"] {
            let read = read(&resolver, &store, key).await.unwrap();
            assert_eq!(
                read,
                ChunkRead::Absent {
                    len: 4,
                    fill: FillValue::default()
                },
                "{key}"
            );
        }
        let stats = store.stats();
        assert_eq!(stats.backend_errors, 0);
        assert_eq!(stats.absent_reads, 1);
    }

    /// A level the binding does not describe has no chunk size to check
    /// bytes against, so its key is refused rather than read.
    #[tokio::test]
    async fn a_level_the_image_lacks_is_refused_before_any_read() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let store = cached(FailingStore(StoreFailure::Backend));

        let error = read(&resolver, &store, "1/0/0/0/0/0").await.unwrap_err();

        assert!(
            matches!(&error, ChunkReadError::UnknownLevel { image, level: 1 } if *image == image_id()),
            "{error:?}"
        );
        assert_eq!(error.failure_kind(), ChunkFailureKind::UnknownLevel);
        assert_eq!(store.stats().source_reads, 0);
    }

    #[tokio::test]
    async fn each_read_failure_names_its_kind() {
        let resolver = resolver_with(vec![four_byte_level()]);
        let empty = ChunkResolver::new(&ServerBindingSeed { images: vec![] });
        let unknown = read(
            &empty,
            &cached(object_store::memory::InMemory::new()),
            "0/0/0/0/0/0",
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.failure_kind(), ChunkFailureKind::UnknownImage);

        let backend = read(
            &resolver,
            &cached(FailingStore(StoreFailure::Backend)),
            "0/0/0/0/0/0",
        )
        .await
        .unwrap_err();
        assert_eq!(backend.failure_kind(), ChunkFailureKind::StorageBackend);

        let denied = read(
            &resolver,
            &cached(FailingStore(StoreFailure::PermissionDenied)),
            "0/0/0/0/0/0",
        )
        .await
        .unwrap_err();
        assert_eq!(denied.failure_kind(), ChunkFailureKind::Permission);

        let mut lz4 = four_byte_level();
        lz4.compression = StorageCompression::compressed(lucida_store::codec::BytesCodec::Lz4, 2);
        let corrupt_resolver = resolver_with(vec![lz4]);
        let store = object_store::memory::InMemory::new();
        put_chunk(
            &store,
            &corrupt_resolver,
            "0/0/0/0/0/0",
            &[0, 0, 0, 0, 1, 2, 3],
        )
        .await;
        let corrupt = read(&corrupt_resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap_err();
        assert_eq!(corrupt.failure_kind(), ChunkFailureKind::CorruptChunk);

        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", &[1, 2]).await;
        let short = read(&resolver, &cached(store), "0/0/0/0/0/0")
            .await
            .unwrap_err();
        assert_eq!(short.failure_kind(), ChunkFailureKind::WrongSize);
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
        if let Ok(fetched) = fetch_chunk(
            resolver,
            store,
            &image_id(),
            &self::key(key),
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
            Some(&mut probe),
        )
        .await
        {
            let _ = fetched.decode(Some(&mut probe));
        }
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
            path: "0".to_string(),
            compression: StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 2, 2],
            chunk_byte_layout: layout(4),
            chunk_key_encoding: Default::default(),
            fill_value: Default::default(),
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
        let store = cached(store);

        let read = read(&resolver, &store, "0/0/0/0/0/0").await.unwrap();

        assert_eq!(read, ChunkRead::Present(declared_picture(0, Some((1, 1)))));
        assert_eq!(store.stats().backend_errors, 0);
        assert_eq!(store.stats().absent_reads, 1);
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
            assert_eq!(
                read,
                ChunkRead::Absent {
                    len: 16,
                    fill: FillValue::default()
                },
                "{key}"
            );
        }
        let empty = cached(object_store::memory::InMemory::new());
        let read = read(&resolver, &empty, "0/0/0/0/0/0").await.unwrap();
        assert_eq!(
            read,
            ChunkRead::Absent {
                len: 16,
                fill: FillValue::default()
            }
        );
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
        let read_error = |bytes: &'static [u8]| {
            let resolver = &resolver;
            async move {
                let store = object_store::memory::InMemory::new();
                put_chunk(&store, resolver, "0/0/0/0/0/0", bytes).await;
                read(resolver, &cached(store), "0/0/0/0/0/0")
                    .await
                    .unwrap_err()
            }
        };

        let short = read_error(&[1, 2]).await;
        assert!(
            matches!(
                short,
                ChunkReadError::Decode(DecodeError::WrongSize {
                    expected: 4,
                    actual: 2
                })
            ),
            "{short:?}"
        );
        // A longer stream is refused at the limit instead of decoded whole.
        let long = read_error(&[1, 2, 3, 4, 5, 6]).await;
        assert!(
            matches!(
                long,
                ChunkReadError::Decode(DecodeError::TooLarge { limit: 4 })
            ),
            "{long:?}"
        );
    }

    /// 64 one-byte samples per chunk, stored behind `codecs`.
    fn compressed_level(chain: StorageCompression) -> LevelInfo {
        LevelInfo {
            compression: chain,
            chunk_shape: vec![1, 1, 1, 8, 8],
            chunk_byte_layout: ChunkByteLayout {
                canonical_byte_size: 64,
                on_disk_byte_size: 64,
                ..four_byte_level().chunk_byte_layout
            },
            ..four_byte_level()
        }
    }

    fn zstd(raw: &[u8]) -> Vec<u8> {
        zstd::encode_all(raw, 3).unwrap()
    }

    fn codecs(names: &[lucida_protocol::codec::ChunkCodec]) -> CodecSet {
        names.iter().copied().collect()
    }

    /// What `relayable` hands over for `stored` at `level`, for a client that
    /// decodes `declared`.
    async fn relayed(
        level: LevelInfo,
        stored: &[u8],
        declared: CodecSet,
    ) -> Option<(Vec<u8>, Vec<BytesCodec>)> {
        let resolver = resolver_with(vec![level]);
        let store = object_store::memory::InMemory::new();
        put_chunk(&store, &resolver, "0/0/0/0/0/0", stored).await;
        let fetched = fetch_chunk(
            &resolver,
            &cached(store),
            &image_id(),
            &key("0/0/0/0/0/0"),
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
            None,
        )
        .await
        .unwrap();
        fetched
            .relayable(declared)
            .map(|(bytes, chain)| (bytes.to_vec(), chain.to_vec()))
    }

    use lucida_protocol::codec::ChunkCodec;

    #[tokio::test]
    async fn a_chunk_is_relayed_as_stored_to_a_client_that_decodes_its_codecs() {
        let stored = zstd(&[0u8; 64]);
        let level = compressed_level(StorageCompression::compressed(BytesCodec::Zstd, 1));
        assert_eq!(
            relayed(level.clone(), &stored, codecs(&[ChunkCodec::Zstd])).await,
            Some((stored.clone(), vec![BytesCodec::Zstd]))
        );
        assert_eq!(
            relayed(level.clone(), &stored, CodecSet::default()).await,
            None
        );
        assert_eq!(
            relayed(level, &stored, codecs(&[ChunkCodec::Gzip])).await,
            None
        );
    }

    #[tokio::test]
    async fn a_chunk_that_saves_too_little_of_the_link_is_decoded() {
        let mut x = 0x2545_f491_u32;
        let noise: Vec<u8> = (0..64)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        let level = compressed_level(StorageCompression::compressed(BytesCodec::Zstd, 1));
        assert_eq!(
            relayed(level, &zstd(&noise), codecs(&[ChunkCodec::Zstd])).await,
            None
        );
    }

    /// The client decodes a relayed chunk to its level's chunk size with its
    /// samples as the wire carries them, so anything the server would still
    /// have to rearrange is decoded here.
    #[tokio::test]
    async fn a_chunk_the_wire_would_need_rearranged_is_decoded() {
        let every = codecs(&[ChunkCodec::Zstd, ChunkCodec::Crc32c]);
        let chain = |byte_order, sample_size, array_to_array| {
            StorageCompression::Codecs(lucida_store::codec::CodecChain {
                array_to_array,
                byte_order,
                sample_size,
                bytes_to_bytes: vec![BytesCodec::Zstd],
            })
        };
        let big_endian = compressed_level(chain(ByteOrder::Big, 2, Vec::new()));
        assert_eq!(relayed(big_endian, &zstd(&[0; 64]), every).await, None);
        let one_byte_big_endian = compressed_level(chain(ByteOrder::Big, 1, Vec::new()));
        assert!(
            relayed(one_byte_big_endian, &zstd(&[0; 64]), every)
                .await
                .is_some()
        );
        let transposed = compressed_level(chain(
            ByteOrder::Little,
            1,
            vec![lucida_store::codec::ArrayCodec::Transpose(vec![
                0, 1, 2, 4, 3,
            ])],
        ));
        assert_eq!(relayed(transposed, &zstd(&[0; 64]), every).await, None);
        let bundled = LevelInfo {
            compression: StorageCompression::compressed(BytesCodec::Zstd, 1),
            ..channel_bundled_level()
        };
        assert_eq!(relayed(bundled, &zstd(&[0; 8]), every).await, None);
        let uncompressed = compressed_level(StorageCompression::None);
        assert_eq!(relayed(uncompressed, &[0; 64], every).await, None);
    }
}
