//! The one path a source chunk takes from its key to the bytes one wire
//! request is served.
//!
//! [`read_chunk`] resolves the chunk's location, reads it through the cached
//! store, decodes the storage compression, fills an absent chunk, and slices
//! the wire timepoint and channel out of the on-disk chunk. The interactive
//! chunk handler and coarse generation both call it, and neither performs a
//! step of the sequence itself, so what a location means and how its bytes
//! become a wire chunk is decided here once.

use lucida_content::ImageId;
use lucida_protocol::ServerPhase;
use lucida_store::cache::CachedStore;
use lucida_store::layout::ChunkByteLayout;
use lucida_store::source_limiter::{ReaderId, RequestLabel};

use crate::binding::{
    ChunkResolver, LevelInfo, parse_level_from_chunk_key, parse_t_c_from_chunk_key,
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
    /// The bytes came back and the storage compression would not undo.
    #[error("decode failed: {0}")]
    Decode(#[source] DecodeError),
}

/// Read the wire chunk for `chunk_key` of `image_id`.
///
/// `reader` and `label` travel into the store with the read: the reader is
/// the fairness class the backend read is charged to, and the label is what
/// lets a wait behind the source-read cap be attributed to a request rather
/// than only to a client (ADR 0048).
///
/// `probe` is the timing row of the request this read serves, when there is
/// one. The read marks the row's dispatch, read, and decompress phases
/// itself, because the boundaries fall inside this function and only the
/// store knows how the read stretch was spent. A read with no browser
/// bracket to nest inside, such as generation, passes `None` and its timing
/// is dropped rather than filed against a label.
pub async fn read_chunk(
    resolver: &ChunkResolver,
    store: &CachedStore,
    image_id: &ImageId,
    chunk_key: &str,
    reader: ReaderId,
    label: RequestLabel,
    mut probe: Option<&mut RequestProbe>,
) -> Result<ChunkRead, ChunkReadError> {
    let location = resolver
        .resolve(image_id, chunk_key)
        .ok_or_else(|| ChunkReadError::UnknownImage(image_id.clone()))?;
    let level_info = resolver
        .level_info(image_id, parse_level_from_chunk_key(chunk_key))
        .unwrap_or_else(unsliced_level_info);

    tracing::trace!(image = %image_id, key = chunk_key, path = %location.path, "reading chunk");
    if let Some(probe) = probe.as_deref_mut() {
        probe.mark(ServerPhase::Dispatch);
    }
    let read = store.get_bytes(&location.path, reader, label).await;
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

    let decoded = decode_storage_bytes(&storage_bytes, level_info.compression);
    if let Some(probe) = probe {
        probe.mark(ServerPhase::Decompress);
    }
    let raw = decoded.map_err(ChunkReadError::Decode)?;
    tracing::debug!(
        key = chunk_key,
        compressed = storage_bytes.len(),
        decompressed = raw.len(),
        compression = ?level_info.compression,
        "chunk decoded"
    );

    let (wire_t, wire_c) = parse_t_c_from_chunk_key(chunk_key);
    Ok(ChunkRead::Present(slice_wire_chunk(
        raw,
        &level_info.chunk_byte_layout,
        wire_t,
        wire_c,
    )))
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
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;

    use lucida_protocol::{PHASE_UNSET, TimingRowFamily, TimingRowOutcome};
    use lucida_store::import_types::ServerBindingSeed;
    use object_store::ObjectStore;

    use super::*;
    use crate::test_fixtures::{FailingStore, StoreFailure, four_byte_level, image_seed};
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
            .put(&location.path, bytes.to_vec().into())
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
}
