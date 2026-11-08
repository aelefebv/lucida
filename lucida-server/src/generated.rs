use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use lru::LruCache;
use lucida_content::{
    DataType, DatasetId, DatasetKind, DatasetManifest, GeneratedLevelInfo,
    GeneratedLevelProvenance, GeneratedLevelRole, ImageId, ImageSpec, LevelGeometry,
};
use lucida_core::protocol::{
    ClientId, ServerMessage, ViewerInterestChunkKey, ViewerInterestHint, ViewerInterestLane,
};
use lucida_protocol::{
    GeneratedAvailabilityDelta, GeneratedAvailabilitySnapshot, GeneratedChunkStatus,
    GeneratedChunkStatusUpdate, GeneratedLevelAvailability, GeneratedLevelHistogram,
    GeneratedLevelSummary, HistogramBin,
};
use lucida_store::cache::CachedStore;
use lucida_store::fill::FillValue;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast};

use crate::BroadcastItem;
use crate::binding::ChunkResolver;
use crate::sample_histogram::SampleHistogram;
use crate::session::Session;
use crate::source_region::{RegionReadError, VolumeRegion, fetch_volume_region};

pub const GENERATED_COARSE_GENERATOR_VERSION: &str = "generated-coarse-v3";
const DEFAULT_TARGET_LONG_AXIS: u64 = 512;
const DEFAULT_CHUNK_LONG_AXIS: u64 = 256;
const DEFAULT_MAX_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
/// A generated chunk costs a file, a request and a GPU slot whatever its
/// size. Pooled far down, a source with small chunks would otherwise make
/// thousands of chunks a few samples across.
const DEFAULT_MIN_CHUNK_AXIS: u64 = 64;
const DOWNSAMPLE_ALGORITHM_VERSION: &str = "max-pool-v2";

/// Default budget for generated chunk bytes held in memory, across every
/// dataset in the process. Memory is the hot copy; the disk cache is the
/// lasting one.
pub const DEFAULT_GENERATED_MEMORY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedCoarseConfig {
    pub target_long_axis: u64,
    pub chunk_long_axis: u64,
    pub max_chunk_bytes: u64,
    /// The fewest samples a generated chunk spans along y and x, short of
    /// the whole level or `chunk_long_axis`.
    pub min_chunk_axis: u64,
}

impl Default for GeneratedCoarseConfig {
    fn default() -> Self {
        Self {
            target_long_axis: DEFAULT_TARGET_LONG_AXIS,
            chunk_long_axis: DEFAULT_CHUNK_LONG_AXIS,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
            min_chunk_axis: DEFAULT_MIN_CHUNK_AXIS,
        }
    }
}

impl GeneratedCoarseConfig {
    pub fn config_id(&self) -> String {
        format!(
            "target{}_chunk{}_maxbytes{}_{DOWNSAMPLE_ALGORITHM_VERSION}",
            self.target_long_axis, self.chunk_long_axis, self.max_chunk_bytes
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedChunkJobKey {
    pub source_content_id: String,
    pub generated_level_id: String,
    pub image_id: ImageId,
    pub t: u32,
    pub c: u32,
    pub chunk_key: String,
    pub config_id: String,
}

#[derive(Debug, Clone)]
pub struct GeneratedCoarsePlan {
    pub dataset_id: DatasetId,
    pub image_id: ImageId,
    pub level_index: u32,
    pub generated_level_id: String,
    pub cache_identity: String,
    pub source_content_id: String,
    pub config: GeneratedCoarseConfig,
    pub output_data_type: DataType,
    pub input_level_candidates: Vec<usize>,
    pub availability: GeneratedLevelAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedSchedulingConfig {
    pub concurrency: usize,
    pub per_client_key_cap: usize,
    pub background_chunk_limit: usize,
    pub background_trickle_when_active: bool,
}

impl Default for GeneratedSchedulingConfig {
    fn default() -> Self {
        Self {
            concurrency: 1,
            per_client_key_cap: 256,
            background_chunk_limit: 32,
            background_trickle_when_active: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GeneratedSchedulingLane {
    Visible,
    /// Asked for by a chunk request that no live hint names. Still demand,
    /// but possibly from a view the client has since left, so it yields to
    /// what the latest hints call visible.
    Requested,
    Predicted,
    Background,
}

impl GeneratedSchedulingLane {
    fn rank(self) -> u8 {
        match self {
            GeneratedSchedulingLane::Visible => 0,
            GeneratedSchedulingLane::Requested => 1,
            GeneratedSchedulingLane::Predicted => 2,
            GeneratedSchedulingLane::Background => 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GeneratedWorkKey {
    pub dataset_id: DatasetId,
    pub image_id: ImageId,
    pub level_index: u32,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedWorkItem {
    pub work_key: GeneratedWorkKey,
    pub lane: GeneratedSchedulingLane,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GeneratedSchedulerTelemetry {
    pub queued_visible: usize,
    pub queued_requested: usize,
    pub queued_predicted: usize,
    pub queued_background: usize,
    pub running: usize,
    pub completed: u64,
    pub failed: u64,
    pub canceled: u64,
    pub deduped: u64,
    pub cache_reused: u64,
    pub ready_broadcasts: u64,
    pub materialization_latency_samples: u64,
    pub materialization_latency_total_ms: u64,
    pub last_materialization_latency_ms: u64,
    pub derived_cache_bytes: u64,
    pub derived_cache_evictions: u64,
}

#[derive(Clone)]
pub struct GeneratedCoarseService {
    inner: Arc<GeneratedCoarseServiceInner>,
}

struct GeneratedCoarseServiceInner {
    plans: HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    /// The plans in a fixed order for background fill to walk.
    plan_order: Vec<(ImageId, u32)>,
    /// Each image's generated level. An image has at most one.
    generated_level_of: HashMap<ImageId, u32>,
    manifest: Arc<DatasetManifest>,
    store: Arc<CachedStore>,
    resolver: Arc<ChunkResolver>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    config: GeneratedSchedulingConfig,
    state: AsyncMutex<GeneratedSchedulerState>,
    notify: Notify,
}

#[derive(Debug, Default)]
struct GeneratedSchedulerState {
    shutdown_reason: Option<String>,
    /// How far background fill has walked. `None` before it starts and
    /// after it stops.
    background: Option<BackgroundCursor>,
    interests: HashMap<(ClientId, DatasetId), ViewerInterestHint>,
    /// The clients with a chunk request waiting on each work key. A request
    /// keeps its work alive until the work finishes, whatever the hints say,
    /// because a client asks for a chunk once and then waits for the update
    /// that says it is ready.
    requested: HashMap<GeneratedWorkKey, HashSet<ClientId>>,
    /// The timepoints and channels of generated levels each client's latest
    /// view of a dataset shows. Held until that client's next hint for the
    /// dataset or its disconnect, not for a hint's lifetime: a still view
    /// stops sending hints, and a histogram needs every chunk of its
    /// timepoint and channel.
    shown: HashMap<(ClientId, DatasetId), HashSet<HistogramKey>>,
    /// How far background work has walked each shown timepoint and
    /// channel's chunks.
    shown_cursor: HashMap<HistogramKey, u64>,
    queued: VecDeque<GeneratedWorkItem>,
    queued_keys: HashMap<GeneratedWorkKey, GeneratedSchedulingLane>,
    running: HashSet<GeneratedWorkKey>,
    completed_keys: HashSet<GeneratedWorkKey>,
    completed: u64,
    failed: u64,
    canceled: u64,
    deduped: u64,
    cache_reused: u64,
    ready_broadcasts: u64,
    materialization_latency_samples: u64,
    materialization_latency_total_ms: u64,
    last_materialization_latency_ms: u64,
}

/// A position in every plan's chunks, in plan order, then `t`, `c`, and the
/// chunk grid, so background fill can queue a few at a time and still reach
/// all of them.
#[derive(Debug)]
struct BackgroundCursor {
    plan: usize,
    tc: u64,
    chunk: u64,
    /// The cache's eviction count when the fill started. Once the cache
    /// evicts, filling further only churns it, so the fill stops.
    evictions_at_start: u64,
    /// Bytes the fill may still queue for generation. A generated level can
    /// run to hundreds of megabytes per timepoint and channel, and the disk
    /// cache may have no budget, so the fill covers as much as the memory
    /// budget holds and views ask for the rest.
    bytes_left: u64,
}

impl BackgroundCursor {
    fn new(evictions_at_start: u64, bytes_left: u64) -> Self {
        Self {
            plan: 0,
            tc: 0,
            chunk: 0,
            evictions_at_start,
            bytes_left,
        }
    }

    fn next(
        &mut self,
        plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
        plan_order: &[(ImageId, u32)],
    ) -> Option<GeneratedWorkKey> {
        loop {
            let plan = plans.get(plan_order.get(self.plan)?)?;
            let level = &plan.availability.level;
            let per_tc = plan.chunks_per_tc();
            let tcs = level.shape[0].saturating_mul(level.shape[1]);
            if self.tc >= tcs || per_tc == 0 {
                self.plan += 1;
                self.tc = 0;
                self.chunk = 0;
                continue;
            }
            if self.chunk >= per_tc {
                self.tc += 1;
                self.chunk = 0;
                continue;
            }
            let (t, c) = (self.tc / level.shape[1], self.tc % level.shape[1]);
            let chunk = self.chunk;
            self.chunk += 1;
            let (Ok(t), Ok(c)) = (u32::try_from(t), u32::try_from(c)) else {
                continue;
            };
            return Some(plan.work_key_at(t, c, chunk));
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DerivedLevelDiskManifest {
    cache_identity: String,
    generated_level_id: String,
    source_content_id: String,
    image_id: ImageId,
    output_data_type: DataType,
    config: GeneratedCoarseConfigDisk,
    availability: GeneratedLevelAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GeneratedCoarseConfigDisk {
    target_long_axis: u64,
    chunk_long_axis: u64,
    max_chunk_bytes: u64,
    generator_version: String,
    downsample_algorithm_version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DerivedReadinessIndex {
    chunks: Vec<GeneratedChunkStatusUpdate>,
}
#[derive(Debug, Clone)]
pub enum DerivedChunkLookup {
    Ready(Vec<u8>),
    Status {
        status: GeneratedChunkStatus,
        message: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DerivedChunkKey {
    image_id: ImageId,
    level_index: u32,
    key: String,
}

#[derive(Debug, Clone)]
struct DerivedChunkEntry {
    status: GeneratedChunkStatus,
    message: Option<String>,
}

/// One byte budget, and one LRU order, over the generated chunk bytes every
/// dataset holds in memory.
///
/// A ready chunk whose bytes were evicted is read back from the disk cache
/// when next asked for. Without a disk cache it is generated again.
#[derive(Debug)]
pub struct GeneratedChunkMemory {
    state: Mutex<GeneratedMemoryState>,
    next_owner: AtomicU64,
}

#[derive(Debug)]
struct GeneratedMemoryState {
    lru: LruCache<(u64, DerivedChunkKey), Vec<u8>>,
    max_bytes: u64,
    current_bytes: u64,
    /// Bytes and evictions per owning cache, for its telemetry.
    owners: HashMap<u64, (u64, u64)>,
}

impl GeneratedChunkMemory {
    pub fn new(max_bytes: u64) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(GeneratedMemoryState {
                lru: LruCache::unbounded(),
                max_bytes,
                current_bytes: 0,
                owners: HashMap::new(),
            }),
            next_owner: AtomicU64::new(0),
        })
    }

    pub fn max_bytes(&self) -> u64 {
        self.state.lock().unwrap().max_bytes
    }

    /// Resident bytes across every cache on this budget.
    pub fn current_bytes(&self) -> u64 {
        self.state.lock().unwrap().current_bytes
    }

    fn get(&self, owner: u64, key: &DerivedChunkKey) -> Option<Vec<u8>> {
        self.state
            .lock()
            .unwrap()
            .lru
            .get(&(owner, key.clone()))
            .cloned()
    }

    fn contains(&self, owner: u64, key: &DerivedChunkKey) -> bool {
        self.state
            .lock()
            .unwrap()
            .lru
            .contains(&(owner, key.clone()))
    }

    /// Bytes larger than the whole budget are not kept.
    fn put(&self, owner: u64, key: DerivedChunkKey, bytes: Vec<u8>) {
        let size = bytes.len() as u64;
        let mut state = self.state.lock().unwrap();
        let state = &mut *state;
        if let Some(previous) = state.lru.pop(&(owner, key.clone())) {
            state.forget(owner, previous.len() as u64, false);
        }
        if size > state.max_bytes {
            return;
        }
        while state.current_bytes + size > state.max_bytes {
            let Some(((evicted_owner, _), evicted)) = state.lru.pop_lru() else {
                break;
            };
            state.forget(evicted_owner, evicted.len() as u64, true);
        }
        state.current_bytes += size;
        state.owners.entry(owner).or_default().0 += size;
        state.lru.put((owner, key), bytes);
    }

    fn remove(&self, owner: u64, key: &DerivedChunkKey) {
        let mut state = self.state.lock().unwrap();
        if let Some(bytes) = state.lru.pop(&(owner, key.clone())) {
            state.forget(owner, bytes.len() as u64, false);
        }
    }

    fn release(&self, owner: u64) {
        let mut state = self.state.lock().unwrap();
        let keys: Vec<_> = state
            .lru
            .iter()
            .filter(|((entry_owner, _), _)| *entry_owner == owner)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(bytes) = state.lru.pop(&key) {
                state.current_bytes -= bytes.len() as u64;
            }
        }
        state.owners.remove(&owner);
    }

    /// `(bytes, evictions)` for one owning cache.
    fn usage(&self, owner: u64) -> (u64, u64) {
        self.state
            .lock()
            .unwrap()
            .owners
            .get(&owner)
            .copied()
            .unwrap_or_default()
    }
}

impl GeneratedMemoryState {
    fn forget(&mut self, owner: u64, size: u64, evicted: bool) {
        self.current_bytes -= size;
        let usage = self.owners.entry(owner).or_default();
        usage.0 -= size;
        if evicted {
            usage.1 += 1;
        }
    }
}

/// One cache's place on a [`GeneratedChunkMemory`], giving its bytes back
/// when the last clone of the cache goes away.
#[derive(Debug)]
struct MemorySlot {
    owner: u64,
    memory: Arc<GeneratedChunkMemory>,
}

impl MemorySlot {
    fn on(memory: Arc<GeneratedChunkMemory>) -> Self {
        Self {
            owner: memory.next_owner.fetch_add(1, Ordering::Relaxed),
            memory,
        }
    }
}

impl Default for MemorySlot {
    fn default() -> Self {
        Self::on(GeneratedChunkMemory::new(DEFAULT_GENERATED_MEMORY_BYTES))
    }
}

impl Drop for MemorySlot {
    fn drop(&mut self) {
        self.memory.release(self.owner);
    }
}

#[derive(Debug, Default)]
struct DerivedChunkState {
    availability: GeneratedAvailabilitySnapshot,
    chunks: HashMap<DerivedChunkKey, DerivedChunkEntry>,
    level_identities: HashMap<(ImageId, u32), String>,
    histograms: HashMap<HistogramKey, TcHistogram>,
}

/// One timepoint and channel of a generated level: image, level, `t`, `c`.
type HistogramKey = (ImageId, u32, u32, u32);

/// How far one timepoint and channel's histogram has got.
#[derive(Debug)]
enum TcHistogram {
    /// The chunks counted so far and their source samples. A chunk is
    /// counted once, however often it is generated again.
    Filling {
        counted: HashSet<String>,
        histogram: SampleHistogram,
    },
    /// Every chunk counted, and the histogram in the availability snapshot.
    Complete,
}

/// A histogram as the disk cache keeps it, one file per timepoint and
/// channel, next to the chunks it describes.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DerivedHistogramFile {
    t: u32,
    c: u32,
    bins: Vec<HistogramBin>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DerivedCacheTelemetry {
    pub storage: DerivedCacheStorage,
    pub bytes: u64,
    pub budget_bytes: Option<u64>,
    pub root_dir: Option<PathBuf>,
    pub evictions: u64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DerivedCacheStorage {
    #[default]
    Memory,
    Disk,
}

#[derive(Debug)]
struct DerivedDiskCache {
    root_dir: PathBuf,
    url_hash: [u8; 16],
    disk_budget_bytes: Option<u64>,
    /// Bytes under the dataset directory as of the last scan, plus what has
    /// been written since. Only a total past the budget pays for a rescan.
    known_bytes: Mutex<Option<u64>>,
    tmp_counter: AtomicU64,
    eviction_counter: AtomicU64,
}

/// In-memory runtime registry for generated levels and seeded fake chunks.
///
/// Generated level keys never hit source storage, and unready generated
/// chunks return explicit statuses instead of disappearing as timeouts.
#[derive(Debug, Clone, Default)]
pub struct DerivedChunkCache {
    inner: Arc<Mutex<DerivedChunkState>>,
    disk: Option<Arc<DerivedDiskCache>>,
    memory: Arc<MemorySlot>,
}

impl DerivedChunkCache {
    pub fn new(snapshot: GeneratedAvailabilitySnapshot) -> Self {
        let cache = Self::default();
        cache.replace_snapshot(snapshot);
        cache
    }

    pub fn new_on_disk(root_dir: PathBuf, url_hash: [u8; 16]) -> Self {
        Self::new_on_disk_with_budget(root_dir, url_hash, None)
    }

    pub fn new_on_disk_with_budget(
        root_dir: PathBuf,
        url_hash: [u8; 16],
        disk_budget_bytes: Option<u64>,
    ) -> Self {
        let disk = match fs::create_dir_all(&root_dir) {
            Ok(()) => Some(Arc::new(DerivedDiskCache {
                root_dir,
                url_hash,
                disk_budget_bytes,
                known_bytes: Mutex::new(None),
                tmp_counter: AtomicU64::new(0),
                eviction_counter: AtomicU64::new(0),
            })),
            Err(e) => {
                tracing::warn!(
                    root = %root_dir.display(),
                    error = %e,
                    "generated coarse cache root unwritable; using memory-only readiness"
                );
                None
            }
        };
        Self {
            inner: Arc::new(Mutex::new(DerivedChunkState::default())),
            disk,
            memory: Arc::default(),
        }
    }

    /// Hold this cache's in-memory bytes on `memory`, shared with every other
    /// cache on it, instead of on a budget of its own.
    pub fn with_memory(mut self, memory: Arc<GeneratedChunkMemory>) -> Self {
        self.memory = Arc::new(MemorySlot::on(memory));
        self
    }

    pub fn snapshot(&self) -> GeneratedAvailabilitySnapshot {
        self.inner.lock().unwrap().availability.clone()
    }

    pub fn replace_snapshot(&self, snapshot: GeneratedAvailabilitySnapshot) {
        let mut state = self.inner.lock().unwrap();
        state.availability = snapshot.clone();
        state.chunks.clear();
        state.level_identities.clear();
        state.histograms = snapshot
            .histograms
            .iter()
            .map(|h| (histogram_key(h), TcHistogram::Complete))
            .collect();
        self.memory.memory.release(self.memory.owner);
        for chunk in snapshot.chunks {
            let key = DerivedChunkKey {
                image_id: chunk.image_id,
                level_index: chunk.level_index,
                key: chunk.key,
            };
            state.chunks.insert(
                key,
                DerivedChunkEntry {
                    status: chunk.status,
                    message: chunk.message,
                },
            );
        }
    }

    /// The readiness index is not rewritten here: a status changes once per
    /// generated chunk, and the index holds the whole level. Ready chunks are
    /// recovered from their files, so the index only has to carry the other
    /// statuses, and [`Self::persist_readiness_indexes`] writes it at
    /// shutdown.
    pub fn apply_delta(&self, delta: GeneratedAvailabilityDelta) {
        let mut state = self.inner.lock().unwrap();
        state.availability.apply_delta(delta.clone());
        for histogram in &delta.histograms {
            state
                .histograms
                .insert(histogram_key(histogram), TcHistogram::Complete);
        }
        for chunk in delta.chunks {
            let key = DerivedChunkKey {
                image_id: chunk.image_id,
                level_index: chunk.level_index,
                key: chunk.key,
            };
            if chunk.status != GeneratedChunkStatus::Ready {
                self.memory.memory.remove(self.memory.owner, &key);
            }
            state.chunks.insert(
                key,
                DerivedChunkEntry {
                    status: chunk.status,
                    message: chunk.message,
                },
            );
        }
    }

    pub fn upsert_level(&self, level: GeneratedLevelAvailability) {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            ..Default::default()
        });
    }

    pub fn set_chunk_status(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        status: GeneratedChunkStatus,
        message: Option<String>,
    ) {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id,
                level_index,
                key,
                status,
                message,
            }],
            histograms: vec![],
        });
    }

    pub fn seed_ready_chunk(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) {
        let chunk_key = self.mark_ready(None, image_id, level_index, key);
        self.memory.memory.put(self.memory.owner, chunk_key, bytes);
    }

    /// Record a chunk as ready without holding its bytes, and the level
    /// identity its disk copy lives under when the level has none yet.
    fn mark_ready(
        &self,
        level_identity: Option<&str>,
        image_id: ImageId,
        level_index: u32,
        key: String,
    ) -> DerivedChunkKey {
        let mut state = self.inner.lock().unwrap();
        state.availability.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: image_id.clone(),
                level_index,
                key: key.clone(),
                status: GeneratedChunkStatus::Ready,
                message: None,
            }],
            histograms: vec![],
        });
        if let Some(identity) = level_identity {
            state
                .level_identities
                .entry((image_id.clone(), level_index))
                .or_insert_with(|| identity.to_string());
        }
        let chunk_key = DerivedChunkKey {
            image_id,
            level_index,
            key,
        };
        state.chunks.insert(
            chunk_key.clone(),
            DerivedChunkEntry {
                status: GeneratedChunkStatus::Ready,
                message: None,
            },
        );
        chunk_key
    }

    /// Keep a generated chunk, and answer the ready chunks the disk cache
    /// evicted to make room for it, as a withdrawal to publish.
    pub fn put_ready_chunk_atomic(
        &self,
        level_identity: &str,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) -> io::Result<GeneratedAvailabilityDelta> {
        let evicted = match &self.disk {
            Some(disk) => disk.put(level_identity, level_index, &key, &bytes)?,
            None => vec![],
        };
        let chunk_key = self.mark_ready(Some(level_identity), image_id, level_index, key);
        self.memory.memory.put(self.memory.owner, chunk_key, bytes);
        Ok(self.withdraw_evicted(&evicted))
    }

    /// Adopt a chunk an earlier run, or another dataset over the same
    /// source, left in the disk cache. Its bytes stay on disk until a client
    /// asks for them.
    ///
    /// Only a chunk whose timepoint and channel has its histogram is
    /// adopted. Any other is generated again, since generating is the only
    /// way to count its source samples.
    pub fn load_ready_chunk(
        &self,
        level_identity: &str,
        image_id: ImageId,
        level_index: u32,
        key: String,
    ) -> io::Result<bool> {
        let Some(disk) = &self.disk else {
            return Ok(false);
        };
        let counted = parse_generated_chunk_key(&key)
            .is_some_and(|c| self.histogram_complete(&image_id, level_index, c.t, c.c));
        if !counted || !disk.chunk_exists(level_identity, level_index, &key) {
            return Ok(false);
        }
        self.mark_ready(Some(level_identity), image_id, level_index, key);
        Ok(true)
    }

    /// Count one generated chunk's source samples toward its timepoint and
    /// channel's histogram. Answers the histogram once this chunk completes
    /// it, for the caller to publish, and keeps it on disk for later opens.
    fn count_histogram(
        &self,
        plan: &GeneratedCoarsePlan,
        coords: GeneratedChunkCoords,
        key: &str,
        samples: &SampleHistogram,
    ) -> Option<GeneratedLevelHistogram> {
        let grid = plan.availability.level.grid_shape;
        let per_tc = checked_product(&[grid[2], grid[3], grid[4]])?;
        let complete = {
            let mut state = self.inner.lock().unwrap();
            let entry = state
                .histograms
                .entry((plan.image_id.clone(), plan.level_index, coords.t, coords.c))
                .or_insert_with(|| TcHistogram::Filling {
                    counted: HashSet::new(),
                    histogram: SampleHistogram::default(),
                });
            let TcHistogram::Filling { counted, histogram } = entry else {
                return None;
            };
            if !counted.insert(key.to_string()) {
                return None;
            }
            histogram.merge(samples);
            if (counted.len() as u64) < per_tc {
                return None;
            }
            match std::mem::replace(entry, TcHistogram::Complete) {
                TcHistogram::Filling { histogram, .. } => histogram,
                TcHistogram::Complete => return None,
            }
        };
        let histogram = GeneratedLevelHistogram {
            image_id: plan.image_id.clone(),
            level_index: plan.level_index,
            t: coords.t,
            c: coords.c,
            bins: complete.wire_bins(),
        };
        if let Some(disk) = &self.disk
            && let Err(e) = disk.put_histogram(&plan.cache_identity, &histogram)
        {
            tracing::warn!(
                image = %plan.image_id.0,
                t = coords.t,
                c = coords.c,
                error = %e,
                "generated coarse histogram persist failed"
            );
        }
        Some(histogram)
    }

    fn histogram_complete(&self, image_id: &ImageId, level_index: u32, t: u32, c: u32) -> bool {
        matches!(
            self.inner
                .lock()
                .unwrap()
                .histograms
                .get(&(image_id.clone(), level_index, t, c)),
            Some(TcHistogram::Complete)
        )
    }

    pub fn is_ready(&self, image_id: &ImageId, level_index: u32, key: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .chunks
            .get(&DerivedChunkKey {
                image_id: image_id.clone(),
                level_index,
                key: key.to_string(),
            })
            .is_some_and(|entry| entry.status == GeneratedChunkStatus::Ready)
    }

    /// A ready chunk this cache can no longer serve: its bytes left memory
    /// and there is no disk copy to read them back from.
    pub fn needs_regeneration(&self, image_id: &ImageId, level_index: u32, key: &str) -> bool {
        if self.disk.is_some() {
            return false;
        }
        let chunk_key = DerivedChunkKey {
            image_id: image_id.clone(),
            level_index,
            key: key.to_string(),
        };
        self.is_ready(image_id, level_index, key)
            && !self.memory.memory.contains(self.memory.owner, &chunk_key)
    }

    /// The ready chunks of every level whose disk directory was evicted, as
    /// unavailable. Answered from what this cache knows, without touching
    /// the disk, so a put that evicts nothing costs nothing here.
    fn withdraw_evicted(&self, evicted_dirs: &[String]) -> GeneratedAvailabilityDelta {
        if evicted_dirs.is_empty() {
            return GeneratedAvailabilityDelta::default();
        }
        let state = self.inner.lock().unwrap();
        let levels: HashSet<&(ImageId, u32)> = state
            .level_identities
            .iter()
            .filter(|(_, identity)| evicted_dirs.contains(&sanitize_segment(identity)))
            .map(|(level, _)| level)
            .collect();
        let chunks = state
            .chunks
            .iter()
            .filter(|(key, entry)| {
                entry.status == GeneratedChunkStatus::Ready
                    && levels.contains(&(key.image_id.clone(), key.level_index))
            })
            .map(|(key, _)| GeneratedChunkStatusUpdate {
                image_id: key.image_id.clone(),
                level_index: key.level_index,
                key: key.key.clone(),
                status: GeneratedChunkStatus::Unavailable,
                message: Some("generated chunk was evicted from derived cache".into()),
            })
            .collect();
        GeneratedAvailabilityDelta {
            levels: vec![],
            chunks,
            histograms: vec![],
        }
    }

    pub fn register_generated_plan(
        &self,
        plan: &GeneratedCoarsePlan,
    ) -> io::Result<GeneratedAvailabilityDelta> {
        if let Some(disk) = &self.disk {
            disk.put_manifest(plan)?;
        }

        let (recovered_chunks, histograms) = if let Some(disk) = &self.disk {
            let histograms = disk.recover_histograms(plan)?;
            (disk.recover_readiness(plan, &histograms)?, histograms)
        } else {
            (vec![], vec![])
        };
        let delta = GeneratedAvailabilityDelta {
            levels: vec![plan.availability.clone()],
            chunks: recovered_chunks,
            histograms,
        };

        {
            let mut state = self.inner.lock().unwrap();
            state.level_identities.insert(
                (plan.image_id.clone(), plan.level_index),
                plan.cache_identity.clone(),
            );
        }
        self.apply_delta(delta.clone());
        Ok(delta)
    }

    pub fn persist_readiness_indexes(&self) {
        let Some(disk) = &self.disk else {
            return;
        };
        let indexes = {
            let state = self.inner.lock().unwrap();
            state
                .level_identities
                .values()
                .cloned()
                .collect::<HashSet<_>>()
                .into_iter()
                .map(|identity| {
                    let chunks = chunks_for_identity_locked(&state, &identity);
                    (identity, chunks)
                })
                .collect::<Vec<_>>()
        };
        for (identity, chunks) in indexes {
            if let Err(e) = disk.put_index(&identity, &chunks) {
                tracing::warn!(
                    identity = %identity,
                    error = %e,
                    "generated coarse readiness index persist failed"
                );
            }
        }
    }

    pub fn memory_budget_bytes(&self) -> u64 {
        self.memory.memory.max_bytes()
    }

    /// How many times the lasting copy, the disk cache or without one the
    /// memory budget, has evicted this cache's chunks.
    pub fn evictions(&self) -> u64 {
        match &self.disk {
            Some(disk) => disk.eviction_counter.load(Ordering::Relaxed),
            None => self.memory.memory.usage(self.memory.owner).1,
        }
    }

    pub fn telemetry(&self) -> DerivedCacheTelemetry {
        if let Some(disk) = &self.disk {
            return disk.telemetry().unwrap_or_default();
        }
        let (bytes, evictions) = self.memory.memory.usage(self.memory.owner);
        DerivedCacheTelemetry {
            storage: DerivedCacheStorage::Memory,
            bytes,
            budget_bytes: Some(self.memory.memory.max_bytes()),
            root_dir: None,
            evictions,
        }
    }

    pub fn is_generated_level(&self, image_id: &ImageId, level_index: u32) -> bool {
        self.inner
            .lock()
            .unwrap()
            .availability
            .levels
            .iter()
            .any(|level| level.image_id == *image_id && level.info.level_index == level_index)
    }

    pub fn lookup(&self, image_id: &ImageId, level_index: u32, key: &str) -> DerivedChunkLookup {
        let chunk_key = DerivedChunkKey {
            image_id: image_id.clone(),
            level_index,
            key: key.to_string(),
        };
        let disk_load = {
            let state = self.inner.lock().unwrap();
            if let Some(entry) = state.chunks.get(&chunk_key) {
                if entry.status == GeneratedChunkStatus::Ready {
                    if let Some(bytes) = self.memory.memory.get(self.memory.owner, &chunk_key) {
                        return DerivedChunkLookup::Ready(bytes);
                    }
                    if self.disk.is_none() {
                        // Evicted with nowhere to read it back from. The
                        // request that brought us here queued it to be
                        // generated again, and a ready update follows.
                        return DerivedChunkLookup::Status {
                            status: GeneratedChunkStatus::Pending,
                            message: Some("generated chunk is being generated again".into()),
                        };
                    }
                    state
                        .level_identities
                        .get(&(image_id.clone(), level_index))
                        .cloned()
                } else {
                    return DerivedChunkLookup::Status {
                        status: entry.status,
                        message: entry.message.clone(),
                    };
                }
            } else {
                if state.availability.levels.iter().any(|level| {
                    level.image_id == *image_id && level.info.level_index == level_index
                }) {
                    return DerivedChunkLookup::Status {
                        status: GeneratedChunkStatus::Pending,
                        message: None,
                    };
                }
                None
            }
        };

        if let (Some(identity), Some(disk)) = (disk_load, &self.disk) {
            match disk.get(&identity, level_index, key) {
                Ok(Some(bytes)) => {
                    self.memory
                        .memory
                        .put(self.memory.owner, chunk_key, bytes.clone());
                    return DerivedChunkLookup::Ready(bytes);
                }
                Ok(None) => {}
                Err(e) => {
                    return DerivedChunkLookup::Status {
                        status: GeneratedChunkStatus::FailedTransient,
                        message: Some(e.to_string()),
                    };
                }
            }
        }

        DerivedChunkLookup::Status {
            status: GeneratedChunkStatus::Unavailable,
            message: Some("generated chunk marked ready but bytes are unavailable".into()),
        }
    }
}

impl DerivedDiskCache {
    fn dataset_dir(&self) -> PathBuf {
        self.root_dir.join(hex16(&self.url_hash))
    }

    fn identity_dir(&self, level_identity: &str) -> PathBuf {
        self.dataset_dir().join(sanitize_segment(level_identity))
    }

    fn manifest_path(&self, level_identity: &str) -> PathBuf {
        self.identity_dir(level_identity).join("manifest.json")
    }

    fn index_path(&self, level_identity: &str) -> PathBuf {
        self.identity_dir(level_identity).join("readiness.json")
    }

    /// No image id in the path: an identity names one image already, and the
    /// image id carries the dataset id, which differs between datasets that
    /// share this directory's source.
    fn level_dir(&self, level_identity: &str, level_index: u32) -> PathBuf {
        self.identity_dir(level_identity)
            .join(format!("L{level_index}"))
    }

    fn chunk_path(&self, level_identity: &str, level_index: u32, key: &str) -> PathBuf {
        self.level_dir(level_identity, level_index)
            .join(format!("{}.bin", sanitize_segment(key)))
    }

    fn put_manifest(&self, plan: &GeneratedCoarsePlan) -> io::Result<()> {
        let manifest = DerivedLevelDiskManifest {
            cache_identity: plan.cache_identity.clone(),
            generated_level_id: plan.generated_level_id.clone(),
            source_content_id: plan.source_content_id.clone(),
            image_id: plan.image_id.clone(),
            output_data_type: plan.output_data_type,
            config: GeneratedCoarseConfigDisk {
                target_long_axis: plan.config.target_long_axis,
                chunk_long_axis: plan.config.chunk_long_axis,
                max_chunk_bytes: plan.config.max_chunk_bytes,
                generator_version: GENERATED_COARSE_GENERATOR_VERSION.into(),
                downsample_algorithm_version: DOWNSAMPLE_ALGORITHM_VERSION.into(),
            },
            availability: plan.availability.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.put_bytes_atomic(&self.manifest_path(&plan.cache_identity), &bytes)?;
        Ok(())
    }

    fn put_index(
        &self,
        level_identity: &str,
        chunks: &[GeneratedChunkStatusUpdate],
    ) -> io::Result<()> {
        let index = DerivedReadinessIndex {
            chunks: chunks.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&index)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.put_bytes_atomic(&self.index_path(level_identity), &bytes)
    }

    /// The chunks a plan's level already holds on disk. A chunk is
    /// recovered as ready only when its timepoint and channel's histogram
    /// was recovered too, in `histograms`: the rest are generated again so
    /// their source samples get counted.
    fn recover_readiness(
        &self,
        plan: &GeneratedCoarsePlan,
        histograms: &[GeneratedLevelHistogram],
    ) -> io::Result<Vec<GeneratedChunkStatusUpdate>> {
        let expected_bytes = expected_generated_chunk_bytes(plan);
        let counted: HashSet<(u32, u32)> = histograms.iter().map(|h| (h.t, h.c)).collect();
        // A whole chunk file is what makes a chunk ready, whatever an index
        // written before it says.
        let ready: Vec<String> = self
            .scan_ready_chunk_keys(plan, expected_bytes)?
            .into_iter()
            .filter(|key| {
                parse_generated_chunk_key(key).is_some_and(|c| counted.contains(&(c.t, c.c)))
            })
            .collect();
        let ready_keys: HashSet<&String> = ready.iter().collect();
        let mut recovered: Vec<_> = self
            .read_index(&plan.cache_identity)?
            .map(|index| index.chunks)
            .unwrap_or_default()
            .into_iter()
            .filter(|chunk| {
                chunk.status != GeneratedChunkStatus::Ready && !ready_keys.contains(&chunk.key)
            })
            // Another dataset over this source may have written the index,
            // with its own dataset id in the image id.
            .map(|chunk| GeneratedChunkStatusUpdate {
                image_id: plan.image_id.clone(),
                level_index: plan.level_index,
                ..chunk
            })
            .collect();
        recovered.extend(ready.iter().map(|key| GeneratedChunkStatusUpdate {
            image_id: plan.image_id.clone(),
            level_index: plan.level_index,
            key: key.clone(),
            status: GeneratedChunkStatus::Ready,
            message: None,
        }));
        Ok(recovered)
    }

    fn histogram_path(&self, level_identity: &str, level_index: u32, t: u32, c: u32) -> PathBuf {
        self.level_dir(level_identity, level_index)
            .join(format!("t{t}-c{c}.hist"))
    }

    fn put_histogram(
        &self,
        level_identity: &str,
        histogram: &GeneratedLevelHistogram,
    ) -> io::Result<()> {
        let file = DerivedHistogramFile {
            t: histogram.t,
            c: histogram.c,
            bins: histogram.bins.clone(),
        };
        let bytes =
            serde_json::to_vec(&file).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.put_bytes_atomic(
            &self.histogram_path(level_identity, histogram.level_index, file.t, file.c),
            &bytes,
        )
    }

    /// The histograms an earlier run, or another dataset over the same
    /// source, wrote for a plan's level, under this plan's image. A file
    /// that does not parse, or names a timepoint or channel the level lacks,
    /// is passed over, and its chunks are generated again.
    fn recover_histograms(
        &self,
        plan: &GeneratedCoarsePlan,
    ) -> io::Result<Vec<GeneratedLevelHistogram>> {
        let dir = self.level_dir(&plan.cache_identity, plan.level_index);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        let shape = plan.availability.level.shape;
        let mut histograms = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("hist") {
                continue;
            }
            let Some(file) = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<DerivedHistogramFile>(&bytes).ok())
            else {
                continue;
            };
            if u64::from(file.t) >= shape[0]
                || u64::from(file.c) >= shape[1]
                || path
                    != self.histogram_path(&plan.cache_identity, plan.level_index, file.t, file.c)
            {
                continue;
            }
            histograms.push(GeneratedLevelHistogram {
                image_id: plan.image_id.clone(),
                level_index: plan.level_index,
                t: file.t,
                c: file.c,
                bins: file.bins,
            });
        }
        histograms.sort_by_key(|h| (h.t, h.c));
        Ok(histograms)
    }

    fn read_index(&self, level_identity: &str) -> io::Result<Option<DerivedReadinessIndex>> {
        let path = self.index_path(level_identity);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    fn scan_ready_chunk_keys(
        &self,
        plan: &GeneratedCoarsePlan,
        expected_bytes: u64,
    ) -> io::Result<Vec<String>> {
        let dir = self.level_dir(&plan.cache_identity, plan.level_index);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        let valid_keys: HashSet<String> = plan
            .chunk_keys_for_all_tc()
            .into_iter()
            .collect::<HashSet<_>>();
        let mut keys = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("bin") {
                continue;
            }
            if entry.metadata().map(|m| m.len()).unwrap_or(0) != expected_bytes {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let key = stem.replace('_', "/");
            if valid_keys.contains(&key) {
                keys.push(key);
            }
        }
        Ok(keys)
    }

    fn chunk_exists(&self, level_identity: &str, level_index: u32, key: &str) -> bool {
        self.chunk_path(level_identity, level_index, key).exists()
    }

    fn get(
        &self,
        level_identity: &str,
        level_index: u32,
        key: &str,
    ) -> io::Result<Option<Vec<u8>>> {
        let path = self.chunk_path(level_identity, level_index, key);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    /// Write one chunk, then hold the directory to its budget. Answers the
    /// directory names of the levels evicted for room.
    fn put(
        &self,
        level_identity: &str,
        level_index: u32,
        key: &str,
        bytes: &[u8],
    ) -> io::Result<Vec<String>> {
        let path = self.chunk_path(level_identity, level_index, key);
        self.put_bytes_atomic(&path, bytes)?;
        self.enforce_budget(bytes.len() as u64)
    }

    fn put_bytes_atomic(&self, path: &PathBuf, bytes: &[u8]) -> io::Result<()> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "generated chunk path has no parent",
            )
        })?;
        fs::create_dir_all(parent)?;

        let counter = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
        let rand: u64 = rand::random();
        let file_name = path
            .file_name()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "generated chunk path has no file name",
                )
            })?
            .to_string_lossy()
            .to_string();
        let tmp_path = parent.join(format!(".{file_name}.tmp.{counter}.{rand:016x}"));

        {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }

        match fs::rename(&tmp_path, path) {
            Ok(()) => {}
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(e);
            }
        }

        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    /// Evict whole levels, oldest first, until the directory fits its budget.
    ///
    /// Walking the directory costs a stat per file, so it is walked only when
    /// the bytes known from the last walk plus those written since pass the
    /// budget. Another cache writing the same directory makes the known total
    /// an undercount, which the next walk corrects.
    fn enforce_budget(&self, written: u64) -> io::Result<Vec<String>> {
        let Some(budget) = self.disk_budget_bytes else {
            return Ok(vec![]);
        };
        let mut known = self.known_bytes.lock().unwrap();
        if let Some(bytes) = known.as_mut() {
            *bytes = bytes.saturating_add(written);
            if *bytes <= budget {
                return Ok(vec![]);
            }
        }
        let dataset_dir = self.dataset_dir();
        let mut identities = Vec::new();
        let mut total = 0_u64;
        let entries = match fs::read_dir(&dataset_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                *known = Some(0);
                return Ok(vec![]);
            }
            Err(e) => return Err(e),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let (bytes, modified) = dir_size_and_modified(&path)?;
            total = total.saturating_add(bytes);
            identities.push((path, bytes, modified));
        }
        identities.sort_by_key(|(_, _, modified)| *modified);
        let mut evicted = Vec::new();
        for (path, bytes, _) in identities {
            if total <= budget {
                break;
            }
            fs::remove_dir_all(&path)?;
            self.eviction_counter.fetch_add(1, Ordering::Relaxed);
            total = total.saturating_sub(bytes);
            if let Some(name) = path.file_name() {
                evicted.push(name.to_string_lossy().into_owned());
            }
        }
        *known = Some(total);
        Ok(evicted)
    }

    fn telemetry(&self) -> io::Result<DerivedCacheTelemetry> {
        let (bytes, _) = dir_size_and_modified(&self.dataset_dir())?;
        Ok(DerivedCacheTelemetry {
            storage: DerivedCacheStorage::Disk,
            bytes,
            budget_bytes: self.disk_budget_bytes,
            root_dir: Some(self.dataset_dir()),
            evictions: self.eviction_counter.load(Ordering::Relaxed),
        })
    }
}

fn histogram_key(histogram: &GeneratedLevelHistogram) -> HistogramKey {
    (
        histogram.image_id.clone(),
        histogram.level_index,
        histogram.t,
        histogram.c,
    )
}

fn hex16(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// A generated coarse level for every image with no source coarse level.
/// `resolver` is the dataset's binding, which holds what the manifest does
/// not: the fill value an unwritten source chunk reads as.
pub fn plan_generated_coarse_for_manifest(
    manifest: &DatasetManifest,
    resolver: &ChunkResolver,
    config: GeneratedCoarseConfig,
) -> Vec<GeneratedCoarsePlan> {
    manifest
        .images()
        .iter()
        .filter_map(|image| {
            plan_generated_coarse_for_image(manifest, image, resolver, config.clone())
        })
        .collect()
}

fn plan_generated_coarse_for_image(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    resolver: &ChunkResolver,
    config: GeneratedCoarseConfig,
) -> Option<GeneratedCoarsePlan> {
    if image.multiscale.coarse_level_index.is_some() || image.multiscale.levels.is_empty() {
        return None;
    }

    let output_long_axis =
        generated_output_long_axis(image.multiscale.levels[0].shape, config.target_long_axis);
    let candidates = input_level_candidates(image, output_long_axis);
    // Unwritten source chunks pool as the fill value, so a level generated
    // under one fill value is not the level another would generate.
    let fills: Vec<FillValue> = candidates
        .iter()
        .map(|&level| {
            resolver
                .level_info(&image.image_id, level as u32)
                .map(|info| info.fill_value)
                .unwrap_or_default()
        })
        .collect();
    let source_content_id = source_content_id_for_image(manifest, image, &fills);
    let selected_input = candidates.first().copied().unwrap_or(0);
    let selected_level = &image.multiscale.levels[selected_input];
    let source_level0 = &image.multiscale.levels[0];
    let output_shape = generated_output_shape(source_level0.shape, selected_level.shape, &config);
    let chunk_shape = generated_chunk_shape(
        output_shape,
        selected_level.shape,
        selected_level.chunk_shape,
        image.multiscale.data_type,
        &config,
    );
    let grid_shape = grid_shape(output_shape, chunk_shape);
    let scale = generated_scale(source_level0.shape, output_shape);
    let level_index = next_generated_level_index(&image.multiscale.levels);
    let level = LevelGeometry {
        level_index,
        shape: output_shape,
        chunk_shape,
        grid_shape,
        scale,
    };
    let config_id = config.config_id();
    let image_key = source_relative_image_id(&manifest.dataset_id, &image.image_id);
    let generated_level_id =
        generated_level_identity(&source_content_id, image_key, &level, &config_id);
    let cache_identity = generated_cache_identity(
        &source_content_id,
        image_key,
        &generated_level_id,
        &level,
        image.multiscale.data_type,
        &config_id,
        &candidates,
    );
    let total_chunks = checked_product(&grid_shape).unwrap_or(0);
    let availability = GeneratedLevelAvailability {
        image_id: image.image_id.clone(),
        info: GeneratedLevelInfo {
            level_index,
            role: GeneratedLevelRole::Coarse,
            provenance: GeneratedLevelProvenance {
                generator: GENERATED_COARSE_GENERATOR_VERSION.into(),
                config_id: config_id.clone(),
                source_content_id: Some(source_content_id.clone()),
            },
        },
        level,
        summary: Some(GeneratedLevelSummary {
            total_chunks,
            ready_chunks: 0,
            pending_chunks: total_chunks,
            failed_chunks: 0,
        }),
    };

    Some(GeneratedCoarsePlan {
        dataset_id: manifest.dataset_id.clone(),
        image_id: image.image_id.clone(),
        level_index,
        generated_level_id,
        cache_identity,
        source_content_id,
        config,
        output_data_type: image.multiscale.data_type,
        input_level_candidates: candidates,
        availability,
    })
}

impl GeneratedCoarsePlan {
    pub fn job_key(&self, t: u32, c: u32, chunk_key: String) -> GeneratedChunkJobKey {
        GeneratedChunkJobKey {
            source_content_id: self.source_content_id.clone(),
            generated_level_id: self.generated_level_id.clone(),
            image_id: self.image_id.clone(),
            t,
            c,
            chunk_key,
            config_id: self.config.config_id(),
        }
    }

    fn chunks_per_tc(&self) -> u64 {
        let grid = self.availability.level.grid_shape;
        grid[2].saturating_mul(grid[3]).saturating_mul(grid[4])
    }

    /// The work for chunk `index` of `(t, c)`, counting through the chunk
    /// grid with x fastest.
    fn work_key_at(&self, t: u32, c: u32, index: u64) -> GeneratedWorkKey {
        let grid = self.availability.level.grid_shape;
        let plane = grid[3].saturating_mul(grid[4]).max(1);
        let (z, y, x) = (
            index / plane,
            index % plane / grid[4].max(1),
            index % grid[4].max(1),
        );
        GeneratedWorkKey {
            dataset_id: self.dataset_id.clone(),
            image_id: self.image_id.clone(),
            level_index: self.level_index,
            key: chunk_key(self.level_index, t, c, z, y, x),
        }
    }

    pub fn chunk_keys_for_tc(&self, t: u32, c: u32) -> Vec<String> {
        let grid = self.availability.level.grid_shape;
        let mut keys = Vec::with_capacity(
            checked_product(&[grid[2], grid[3], grid[4]])
                .and_then(|count| usize::try_from(count).ok())
                .unwrap_or(0),
        );
        for gz in 0..grid[2] {
            for gy in 0..grid[3] {
                for gx in 0..grid[4] {
                    keys.push(chunk_key(self.level_index, t, c, gz, gy, gx));
                }
            }
        }
        keys
    }

    pub fn chunk_keys_for_all_tc(&self) -> Vec<String> {
        let mut keys = Vec::new();
        for t in 0..self.availability.level.shape[0] {
            for c in 0..self.availability.level.shape[1] {
                if let (Ok(t), Ok(c)) = (u32::try_from(t), u32::try_from(c)) {
                    keys.extend(self.chunk_keys_for_tc(t, c));
                }
            }
        }
        keys
    }
}

impl GeneratedCoarseService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        plans: Vec<GeneratedCoarsePlan>,
        manifest: Arc<DatasetManifest>,
        store: Arc<CachedStore>,
        resolver: Arc<ChunkResolver>,
        cache: Arc<DerivedChunkCache>,
        session: Arc<AsyncMutex<Session>>,
        tx: broadcast::Sender<BroadcastItem>,
        config: GeneratedSchedulingConfig,
    ) -> Self {
        let plan_map: HashMap<_, _> = plans
            .into_iter()
            .map(|plan| ((plan.image_id.clone(), plan.level_index), plan))
            .collect();
        let mut plan_order: Vec<_> = plan_map.keys().cloned().collect();
        plan_order.sort_by(|a, b| (&a.0.0, a.1).cmp(&(&b.0.0, b.1)));
        let generated_level_of = plan_map.keys().cloned().collect();
        Self {
            inner: Arc::new(GeneratedCoarseServiceInner {
                plans: plan_map,
                plan_order,
                generated_level_of,
                manifest,
                store,
                resolver,
                cache,
                session,
                tx,
                config,
                state: AsyncMutex::new(GeneratedSchedulerState::default()),
                notify: Notify::new(),
            }),
        }
    }

    pub fn inert(cache: Arc<DerivedChunkCache>) -> Self {
        let manifest = Arc::new(DatasetManifest::new(
            DatasetId("__generated_inert__".into()),
            "inert".into(),
            DatasetKind::Single,
            vec![],
            vec![],
            vec![],
            vec![],
            None,
        ));
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cached = Arc::new(CachedStore::new(store, 1));
        let resolver = Arc::new(ChunkResolver::new(
            &lucida_store::import_types::ServerBindingSeed { images: vec![] },
        ));
        let (tx, _rx) = broadcast::channel(1);
        Self::new(
            vec![],
            manifest,
            cached,
            resolver,
            cache,
            Arc::new(AsyncMutex::new(Session::new())),
            tx,
            GeneratedSchedulingConfig {
                background_chunk_limit: 0,
                ..GeneratedSchedulingConfig::default()
            },
        )
    }

    pub fn start(&self) {
        let concurrency = self.inner.config.concurrency.max(1);
        for _ in 0..concurrency {
            let service = self.clone();
            tokio::spawn(async move {
                service.worker_loop().await;
            });
        }
    }

    pub async fn shutdown(&self, reason: &str) -> GeneratedSchedulerTelemetry {
        let canceled_queued = {
            let mut state = self.inner.state.lock().await;
            if state.shutdown_reason.is_some() {
                0
            } else {
                let canceled_queued = state.queued.len() as u64;
                state.shutdown_reason = Some(reason.to_string());
                state.canceled = state.canceled.saturating_add(canceled_queued);
                state.interests.clear();
                state.shown.clear();
                state.shown_cursor.clear();
                state.requested.clear();
                state.queued.clear();
                state.queued_keys.clear();
                state.background = None;
                canceled_queued
            }
        };
        self.inner.cache.persist_readiness_indexes();
        self.inner.notify.notify_waiters();
        let telemetry = self.telemetry().await;
        tracing::info!(
            reason,
            canceled_queued,
            running = telemetry.running,
            completed = telemetry.completed,
            failed = telemetry.failed,
            canceled = telemetry.canceled,
            "generated_coarse.shutdown"
        );
        telemetry
    }

    pub async fn is_shutdown(&self) -> bool {
        self.inner.state.lock().await.shutdown_reason.is_some()
    }

    /// A client asked for a generated chunk. Its work stays queued until it
    /// finishes or the client disconnects.
    pub async fn enqueue_chunk_request(
        &self,
        client_id: ClientId,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
    ) {
        let Some(plan) = self.inner.plans.get(&(image_id.clone(), level_index)) else {
            return;
        };
        let work_key = GeneratedWorkKey {
            dataset_id: plan.dataset_id.clone(),
            image_id: image_id.clone(),
            level_index,
            key: key.to_string(),
        };
        let mut state = self.inner.state.lock().await;
        if state.shutdown_reason.is_some() {
            return;
        }
        if self
            .inner
            .cache
            .needs_regeneration(image_id, level_index, key)
        {
            state.completed_keys.remove(&work_key);
        }
        // Finished work has nothing left to wait on, so recording the request
        // would leave it outstanding until the client disconnects.
        if !state.completed_keys.contains(&work_key) {
            state
                .requested
                .entry(work_key.clone())
                .or_default()
                .insert(client_id);
        }
        enqueue_work_locked(&mut state, work_key, GeneratedSchedulingLane::Requested);
        drop(state);
        self.inner.notify.notify_waiters();
    }

    pub async fn apply_viewer_interest(
        &self,
        client_id: ClientId,
        mut interest: ViewerInterestHint,
    ) {
        interest.client_id = Some(client_id);
        let dataset_id = interest.dataset_id.clone();
        let now_ms = current_unix_millis();
        let mut state = self.inner.state.lock().await;
        if state.shutdown_reason.is_some() {
            return;
        }
        expire_interests_locked(&mut state, now_ms);
        let shown = self.shown_by(&interest);
        state.shown.insert((client_id, dataset_id.clone()), shown);
        forget_unshown_locked(&mut state);
        state
            .interests
            .insert((client_id, dataset_id), interest.clone());
        enqueue_interest_locked(
            &mut state,
            &self.inner.plans,
            &interest,
            self.inner.config.per_client_key_cap,
        );
        prune_stale_queued_locked(&mut state, &self.inner.plans, now_ms);
        self.top_up_background_locked(&mut state);
        drop(state);
        self.inner.notify.notify_waiters();
    }

    /// The timepoints and channels of generated levels a hint's view shows:
    /// those of every chunk it wants of an image with a generated level, at
    /// whatever level it wants it.
    fn shown_by(&self, interest: &ViewerInterestHint) -> HashSet<HistogramKey> {
        interest
            .desired_keys
            .iter()
            .filter_map(|key| {
                let level_index = *self.inner.generated_level_of.get(&key.image_id)?;
                let plan = self.inner.plans.get(&(key.image_id.clone(), level_index))?;
                let coords = parse_generated_chunk_key(&key.key)?;
                let shape = plan.availability.level.shape;
                (plan.dataset_id == interest.dataset_id
                    && u64::from(coords.t) < shape[0]
                    && u64::from(coords.c) < shape[1])
                    .then(|| (key.image_id.clone(), level_index, coords.t, coords.c))
            })
            .collect()
    }

    pub async fn remove_client_interest(&self, client_id: ClientId) {
        let mut state = self.inner.state.lock().await;
        if state.shutdown_reason.is_some() {
            return;
        }
        state.interests.retain(|(cid, _), _| *cid != client_id);
        state.shown.retain(|(cid, _), _| *cid != client_id);
        forget_unshown_locked(&mut state);
        state.requested.retain(|_, clients| {
            clients.remove(&client_id);
            !clients.is_empty()
        });
        prune_stale_queued_locked(&mut state, &self.inner.plans, current_unix_millis());
        drop(state);
        self.inner.notify.notify_waiters();
    }

    pub async fn telemetry(&self) -> GeneratedSchedulerTelemetry {
        let cache_telemetry = self.inner.cache.telemetry();
        let state = self.inner.state.lock().await;
        telemetry_locked(&state, cache_telemetry)
    }

    /// Start generating every chunk of every plan in the background.
    ///
    /// At most `background_chunk_limit` of them wait in the queue at once,
    /// topped up as work finishes, so the queue stays short however large
    /// the level is.
    pub async fn enqueue_background_fill(&self) {
        if self.inner.config.background_chunk_limit == 0 {
            return;
        }
        let mut state = self.inner.state.lock().await;
        if state.shutdown_reason.is_some() || state.background.is_some() {
            return;
        }
        state.background = Some(BackgroundCursor::new(
            self.inner.cache.evictions(),
            self.inner.cache.memory_budget_bytes(),
        ));
        let queued = self.top_up_background_locked(&mut state);
        drop(state);
        if queued {
            self.inner.notify.notify_waiters();
        }
    }

    /// Queue background work until `background_chunk_limit` items wait:
    /// first what views show, then the walk over every plan. Answers whether
    /// anything was queued.
    fn top_up_background_locked(&self, state: &mut GeneratedSchedulerState) -> bool {
        let limit = self.inner.config.background_chunk_limit;
        let mut waiting = state
            .queued
            .iter()
            .filter(|item| item.lane == GeneratedSchedulingLane::Background)
            .count();
        let mut queued = self.top_up_shown_locked(state, limit, &mut waiting);
        let Some(mut cursor) = state.background.take() else {
            return queued;
        };
        let cache = &self.inner.cache;
        if cache.evictions() > cursor.evictions_at_start {
            tracing::info!(
                evictions = cache.evictions() - cursor.evictions_at_start,
                "generated_coarse.background_fill_stopped_at_budget"
            );
            return queued;
        }
        while waiting < limit {
            let Some(work_key) = cursor.next(&self.inner.plans, &self.inner.plan_order) else {
                tracing::debug!("generated_coarse.background_fill_walked");
                return queued;
            };
            if !self.needs_work_locked(state, &work_key) {
                continue;
            }
            let bytes = self
                .inner
                .plans
                .get(&(work_key.image_id.clone(), work_key.level_index))
                .map_or(0, expected_generated_chunk_bytes);
            if bytes > cursor.bytes_left {
                tracing::info!("generated_coarse.background_fill_stopped_at_byte_cap");
                return queued;
            }
            cursor.bytes_left -= bytes;
            enqueue_work_locked(state, work_key, GeneratedSchedulingLane::Background);
            waiting += 1;
            queued = true;
        }
        state.background = Some(cursor);
        queued
    }

    /// Queue the chunks still missing from each timepoint and channel a view
    /// shows, so its histogram completes: clients fit contrast limits from
    /// it. Unlike the walk this ignores the byte cap and evictions, since a
    /// histogram needs every chunk of its timepoint and channel, and what
    /// views show bounds the work.
    fn top_up_shown_locked(
        &self,
        state: &mut GeneratedSchedulerState,
        limit: usize,
        waiting: &mut usize,
    ) -> bool {
        let mut shown: Vec<HistogramKey> = state
            .shown
            .values()
            .flatten()
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        shown.sort_by(|a, b| (&a.0.0, a.1, a.2, a.3).cmp(&(&b.0.0, b.1, b.2, b.3)));
        let mut queued = false;
        for tc in shown {
            if *waiting >= limit {
                break;
            }
            let (image_id, level_index, t, c) = &tc;
            let Some(plan) = self.inner.plans.get(&(image_id.clone(), *level_index)) else {
                continue;
            };
            if self
                .inner
                .cache
                .histogram_complete(image_id, *level_index, *t, *c)
            {
                continue;
            }
            let per_tc = plan.chunks_per_tc();
            let mut next = state.shown_cursor.get(&tc).copied().unwrap_or(0);
            while next < per_tc && *waiting < limit {
                let work_key = plan.work_key_at(*t, *c, next);
                next += 1;
                if self.needs_work_locked(state, &work_key) {
                    enqueue_work_locked(state, work_key, GeneratedSchedulingLane::Background);
                    *waiting += 1;
                    queued = true;
                }
            }
            state.shown_cursor.insert(tc, next);
        }
        queued
    }

    /// Whether a chunk is neither generated, nor being generated, nor
    /// waiting to be.
    fn needs_work_locked(&self, state: &GeneratedSchedulerState, key: &GeneratedWorkKey) -> bool {
        !(state.completed_keys.contains(key)
            || state.running.contains(key)
            || state.queued_keys.contains_key(key)
            || self
                .inner
                .cache
                .is_ready(&key.image_id, key.level_index, &key.key))
    }

    async fn worker_loop(self) {
        loop {
            let Some(item) = self.next_work_item().await else {
                tracing::debug!("generated_coarse.worker_stopped");
                break;
            };
            if self.should_cancel(&item).await {
                self.mark_canceled(item.work_key).await;
                continue;
            }
            let started = Instant::now();
            let result = self.materialize_work_item(&item).await;
            let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let mut state = self.inner.state.lock().await;
            state.running.remove(&item.work_key);
            // A finished run settles the requests that waited on it. Each
            // client learns the outcome from the availability update, and one
            // still missing the chunk asks again.
            state.requested.remove(&item.work_key);
            state.materialization_latency_samples =
                state.materialization_latency_samples.saturating_add(1);
            state.materialization_latency_total_ms = state
                .materialization_latency_total_ms
                .saturating_add(elapsed_ms);
            state.last_materialization_latency_ms = elapsed_ms;
            match result {
                MaterializeOneResult::Ready => {
                    state.completed_keys.insert(item.work_key);
                    state.completed += 1;
                    state.ready_broadcasts += 1;
                }
                MaterializeOneResult::CacheReused => {
                    state.completed_keys.insert(item.work_key);
                    state.completed += 1;
                    state.cache_reused += 1;
                    state.ready_broadcasts += 1;
                }
                MaterializeOneResult::Failed => {
                    state.failed += 1;
                }
                MaterializeOneResult::Canceled => {
                    state.canceled += 1;
                }
            }
            if self.top_up_background_locked(&mut state) {
                drop(state);
                self.inner.notify.notify_waiters();
            }
        }
    }

    async fn next_work_item(&self) -> Option<GeneratedWorkItem> {
        loop {
            let notified = self.inner.notify.notified();
            if let Some(item) = self.pop_next_work_item().await {
                return Some(item);
            }
            if self.is_shutdown().await {
                return None;
            }
            notified.await;
        }
    }

    async fn pop_next_work_item(&self) -> Option<GeneratedWorkItem> {
        let mut state = self.inner.state.lock().await;
        if state.shutdown_reason.is_some() {
            return None;
        }
        expire_interests_locked(&mut state, current_unix_millis());
        prune_stale_queued_locked(&mut state, &self.inner.plans, current_unix_millis());

        loop {
            let mut best_idx = None;
            let mut best_lane = GeneratedSchedulingLane::Background;
            let has_active = state
                .queued
                .iter()
                .any(|item| item.lane != GeneratedSchedulingLane::Background);
            for (idx, item) in state.queued.iter().enumerate() {
                if item.lane == GeneratedSchedulingLane::Background
                    && has_active
                    && !self.inner.config.background_trickle_when_active
                {
                    continue;
                }
                if best_idx.is_none() || item.lane.rank() < best_lane.rank() {
                    best_idx = Some(idx);
                    best_lane = item.lane;
                }
            }

            let idx = best_idx?;
            let item = state.queued.remove(idx)?;
            state.queued_keys.remove(&item.work_key);
            if state.completed_keys.contains(&item.work_key) {
                continue;
            }
            state.running.insert(item.work_key.clone());
            return Some(item);
        }
    }

    async fn should_cancel(&self, item: &GeneratedWorkItem) -> bool {
        {
            let state = self.inner.state.lock().await;
            if state.shutdown_reason.is_some() {
                return true;
            }
        }
        if item.lane == GeneratedSchedulingLane::Background {
            return false;
        }
        let state = self.inner.state.lock().await;
        !wanted_work_keys_locked(&state, &self.inner.plans, current_unix_millis())
            .contains(&item.work_key)
    }

    async fn mark_canceled(&self, work_key: GeneratedWorkKey) {
        let mut state = self.inner.state.lock().await;
        state.running.remove(&work_key);
        state.canceled += 1;
    }

    async fn materialize_work_item(&self, item: &GeneratedWorkItem) -> MaterializeOneResult {
        if self.should_cancel(item).await {
            return MaterializeOneResult::Canceled;
        }
        let Some(plan) = self
            .inner
            .plans
            .get(&(item.work_key.image_id.clone(), item.work_key.level_index))
            .cloned()
        else {
            return MaterializeOneResult::Failed;
        };
        let Some(coords) = parse_generated_chunk_key(&item.work_key.key) else {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                item.work_key.key.clone(),
                GeneratedChunkStatus::FailedPermanent,
                Some("generated chunk key is malformed".into()),
                self.inner.cache.clone(),
                self.inner.session.clone(),
                self.inner.tx.clone(),
            )
            .await;
            return MaterializeOneResult::Failed;
        };
        if coords.level_index != plan.level_index {
            return MaterializeOneResult::Failed;
        }
        materialize_generated_coarse_key(
            &plan,
            coords,
            self.inner.manifest.clone(),
            self.inner.store.clone(),
            self.inner.resolver.clone(),
            self.inner.cache.clone(),
            self.inner.session.clone(),
            self.inner.tx.clone(),
            || async { self.should_cancel(item).await },
        )
        .await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaterializeOneResult {
    Ready,
    CacheReused,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GeneratedChunkCoords {
    level_index: u32,
    t: u32,
    c: u32,
    z: u64,
    y: u64,
    x: u64,
}

#[derive(Debug)]
enum GeneratedChunkBuildError {
    Source(RegionReadError),
    Downsample(String),
}

impl std::fmt::Display for GeneratedChunkBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GeneratedChunkBuildError::Source(error) => write!(f, "{error}"),
            GeneratedChunkBuildError::Downsample(message) => f.write_str(message),
        }
    }
}

impl From<RegionReadError> for GeneratedChunkBuildError {
    fn from(error: RegionReadError) -> Self {
        GeneratedChunkBuildError::Source(error)
    }
}

fn enqueue_interest_locked(
    state: &mut GeneratedSchedulerState,
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    interest: &ViewerInterestHint,
    per_client_key_cap: usize,
) {
    let mut admitted = 0usize;
    for key in interest
        .desired_keys
        .iter()
        .chain(interest.predicted_keys.iter())
    {
        if admitted >= per_client_key_cap {
            break;
        }
        if let Some(work_key) = work_key_from_interest(plans, &interest.dataset_id, key) {
            enqueue_work_locked(state, work_key, lane_from_interest_key(key));
            admitted += 1;
        }
    }
}

fn enqueue_work_locked(
    state: &mut GeneratedSchedulerState,
    work_key: GeneratedWorkKey,
    lane: GeneratedSchedulingLane,
) {
    if state.completed_keys.contains(&work_key) || state.running.contains(&work_key) {
        state.deduped += 1;
        return;
    }
    match state.queued_keys.get_mut(&work_key) {
        Some(existing_lane) => {
            if lane.rank() < existing_lane.rank() {
                *existing_lane = lane;
                if let Some(item) = state
                    .queued
                    .iter_mut()
                    .find(|item| item.work_key == work_key)
                {
                    item.lane = lane;
                }
            }
            state.deduped += 1;
        }
        None => {
            state.queued_keys.insert(work_key.clone(), lane);
            state.queued.push_back(GeneratedWorkItem { work_key, lane });
        }
    }
}

fn prune_stale_queued_locked(
    state: &mut GeneratedSchedulerState,
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    now_ms: u64,
) {
    let wanted = wanted_work_keys_locked(state, plans, now_ms);
    let mut retained = VecDeque::with_capacity(state.queued.len());
    while let Some(item) = state.queued.pop_front() {
        if item.lane == GeneratedSchedulingLane::Background || wanted.contains(&item.work_key) {
            retained.push_back(item);
        } else {
            state.queued_keys.remove(&item.work_key);
            state.canceled += 1;
        }
    }
    state.queued = retained;
}

/// Forget how far the walk of each timepoint and channel no view shows any
/// more got. One shown again is walked from its start, skipping what was
/// generated meanwhile.
fn forget_unshown_locked(state: &mut GeneratedSchedulerState) {
    let shown: HashSet<&HistogramKey> = state.shown.values().flatten().collect();
    state.shown_cursor.retain(|tc, _| shown.contains(tc));
}

fn expire_interests_locked(state: &mut GeneratedSchedulerState, now_ms: u64) {
    state.interests.retain(|_, interest| {
        interest
            .timestamp_ms
            .saturating_add(interest.ttl_ms)
            .ge(&now_ms)
    });
}

fn wanted_work_keys_locked(
    state: &GeneratedSchedulerState,
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    now_ms: u64,
) -> HashSet<GeneratedWorkKey> {
    let mut wanted: HashSet<GeneratedWorkKey> = state.requested.keys().cloned().collect();
    for interest in state.interests.values() {
        if interest.timestamp_ms.saturating_add(interest.ttl_ms) < now_ms {
            continue;
        }
        for key in interest
            .desired_keys
            .iter()
            .chain(interest.predicted_keys.iter())
        {
            if let Some(work_key) = work_key_from_interest(plans, &interest.dataset_id, key) {
                wanted.insert(work_key);
            }
        }
    }
    wanted
}

fn work_key_from_interest(
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    dataset_id: &DatasetId,
    key: &ViewerInterestChunkKey,
) -> Option<GeneratedWorkKey> {
    let coords = parse_generated_chunk_key(&key.key)?;
    let plan = plans.get(&(key.image_id.clone(), coords.level_index))?;
    if &plan.dataset_id != dataset_id {
        return None;
    }
    Some(GeneratedWorkKey {
        dataset_id: dataset_id.clone(),
        image_id: key.image_id.clone(),
        level_index: coords.level_index,
        key: key.key.clone(),
    })
}

fn lane_from_interest_key(key: &ViewerInterestChunkKey) -> GeneratedSchedulingLane {
    match key.lane {
        ViewerInterestLane::Visible => GeneratedSchedulingLane::Visible,
        ViewerInterestLane::Predicted => GeneratedSchedulingLane::Predicted,
        ViewerInterestLane::Background => GeneratedSchedulingLane::Background,
    }
}

fn telemetry_locked(
    state: &GeneratedSchedulerState,
    cache: DerivedCacheTelemetry,
) -> GeneratedSchedulerTelemetry {
    let mut telemetry = GeneratedSchedulerTelemetry {
        running: state.running.len(),
        completed: state.completed,
        failed: state.failed,
        canceled: state.canceled,
        deduped: state.deduped,
        cache_reused: state.cache_reused,
        ready_broadcasts: state.ready_broadcasts,
        materialization_latency_samples: state.materialization_latency_samples,
        materialization_latency_total_ms: state.materialization_latency_total_ms,
        last_materialization_latency_ms: state.last_materialization_latency_ms,
        derived_cache_bytes: cache.bytes,
        derived_cache_evictions: cache.evictions,
        ..GeneratedSchedulerTelemetry::default()
    };
    for item in &state.queued {
        match item.lane {
            GeneratedSchedulingLane::Visible => telemetry.queued_visible += 1,
            GeneratedSchedulingLane::Requested => telemetry.queued_requested += 1,
            GeneratedSchedulingLane::Predicted => telemetry.queued_predicted += 1,
            GeneratedSchedulingLane::Background => telemetry.queued_background += 1,
        }
    }
    telemetry
}

fn current_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub async fn publish_generated_level_availability(
    dataset_id: DatasetId,
    level: GeneratedLevelAvailability,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    publish_generated_delta(
        dataset_id,
        GeneratedAvailabilityDelta {
            levels: vec![level],
            ..Default::default()
        },
        cache,
        session,
        tx,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
pub async fn materialize_generated_coarse_plan(
    plan: GeneratedCoarsePlan,
    manifest: Arc<DatasetManifest>,
    store: Arc<CachedStore>,
    resolver: Arc<ChunkResolver>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    if !manifest
        .images()
        .iter()
        .any(|image| image.image_id == plan.image_id)
    {
        publish_all_chunks_for_plan(
            &plan,
            GeneratedChunkStatus::FailedPermanent,
            Some("generated coarse source image disappeared".into()),
            cache,
            session,
            tx,
        )
        .await;
        return;
    }

    let level = &plan.availability.level;
    for t in 0..level.shape[0] {
        for c in 0..level.shape[1] {
            let t = match u32::try_from(t) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let c = match u32::try_from(c) {
                Ok(c) => c,
                Err(_) => continue,
            };

            for key in plan.chunk_keys_for_tc(t, c) {
                let Some(coords) = parse_generated_chunk_key(&key) else {
                    publish_chunk_status(
                        &plan.dataset_id,
                        &plan.image_id,
                        plan.level_index,
                        key,
                        GeneratedChunkStatus::FailedPermanent,
                        Some("generated chunk key is malformed".into()),
                        cache.clone(),
                        session.clone(),
                        tx.clone(),
                    )
                    .await;
                    continue;
                };
                materialize_generated_coarse_key(
                    &plan,
                    coords,
                    manifest.clone(),
                    store.clone(),
                    resolver.clone(),
                    cache.clone(),
                    session.clone(),
                    tx.clone(),
                    || async { false },
                )
                .await;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn materialize_generated_coarse_key<C, Fut>(
    plan: &GeneratedCoarsePlan,
    coords: GeneratedChunkCoords,
    manifest: Arc<DatasetManifest>,
    store: Arc<CachedStore>,
    resolver: Arc<ChunkResolver>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    should_cancel: C,
) -> MaterializeOneResult
where
    C: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    let key = chunk_key(
        coords.level_index,
        coords.t,
        coords.c,
        coords.z,
        coords.y,
        coords.x,
    );
    // Clients already hold a ready status for a chunk recovered when the
    // level was registered, so adopting its file announces nothing new.
    let announced = cache.is_ready(&plan.image_id, plan.level_index, &key);
    match cache.load_ready_chunk(
        &plan.cache_identity,
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
    ) {
        Ok(true) if announced => return MaterializeOneResult::CacheReused,
        Ok(true) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::Ready,
                None,
                cache.clone(),
                session.clone(),
                tx.clone(),
            )
            .await;
            return MaterializeOneResult::CacheReused;
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!(
                image = %plan.image_id.0,
                key = %key,
                error = %e,
                "generated coarse cache lookup failed; regenerating chunk"
            );
        }
    }

    if should_cancel().await {
        return MaterializeOneResult::Canceled;
    }

    let Some(image) = manifest
        .images()
        .iter()
        .find(|image| image.image_id == plan.image_id)
        .cloned()
    else {
        publish_chunk_status(
            &plan.dataset_id,
            &plan.image_id,
            plan.level_index,
            key,
            GeneratedChunkStatus::FailedPermanent,
            Some("generated coarse source image disappeared".into()),
            cache,
            session,
            tx,
        )
        .await;
        return MaterializeOneResult::Failed;
    };

    let (bytes, samples) =
        match generate_chunk_with_fallback(&image, coords, plan, &store, &resolver).await {
            Ok(generated) => generated,
            Err(e) => {
                publish_chunk_status(
                    &plan.dataset_id,
                    &plan.image_id,
                    plan.level_index,
                    key,
                    generated_status_for_chunk_error(&e),
                    Some(e.to_string()),
                    cache,
                    session,
                    tx,
                )
                .await;
                return MaterializeOneResult::Failed;
            }
        };

    if should_cancel().await {
        return MaterializeOneResult::Canceled;
    }
    match cache.put_ready_chunk_atomic(
        &plan.cache_identity,
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
        bytes,
    ) {
        Ok(withdrawal_delta) => {
            // A histogram goes out with the chunk that completes it, so a
            // client holds it before it holds that chunk.
            let histograms = cache
                .count_histogram(plan, coords, &key, &samples)
                .into_iter()
                .collect();
            publish_generated_delta(
                plan.dataset_id.clone(),
                GeneratedAvailabilityDelta {
                    levels: vec![],
                    chunks: vec![GeneratedChunkStatusUpdate {
                        image_id: plan.image_id.clone(),
                        level_index: plan.level_index,
                        key,
                        status: GeneratedChunkStatus::Ready,
                        message: None,
                    }],
                    histograms,
                },
                cache.clone(),
                session.clone(),
                tx.clone(),
            )
            .await;
            if !withdrawal_delta.chunks.is_empty() {
                publish_generated_delta(
                    plan.dataset_id.clone(),
                    withdrawal_delta,
                    cache,
                    session,
                    tx,
                )
                .await;
            }
            MaterializeOneResult::Ready
        }
        Err(e) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::FailedTransient,
                Some(e.to_string()),
                cache,
                session,
                tx,
            )
            .await;
            MaterializeOneResult::Failed
        }
    }
}

/// One generated chunk's bytes, and the source samples it accounts for in
/// its timepoint and channel's histogram.
async fn generate_chunk_with_fallback(
    image: &ImageSpec,
    coords: GeneratedChunkCoords,
    plan: &GeneratedCoarsePlan,
    store: &Arc<CachedStore>,
    resolver: &Arc<ChunkResolver>,
) -> Result<(Vec<u8>, SampleHistogram), GeneratedChunkBuildError> {
    let mut last_error = None;
    for source_level_index in &plan.input_level_candidates {
        match generate_chunk_from_source_level(
            image,
            coords,
            plan,
            *source_level_index,
            store,
            resolver,
        )
        .await
        {
            Ok(generated) => return Ok(generated),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        RegionReadError::BadLevel {
            image: image.image_id.clone(),
            level: 0,
        }
        .into()
    }))
}

async fn generate_chunk_from_source_level(
    image: &ImageSpec,
    coords: GeneratedChunkCoords,
    plan: &GeneratedCoarsePlan,
    source_level_index: usize,
    store: &Arc<CachedStore>,
    resolver: &Arc<ChunkResolver>,
) -> Result<(Vec<u8>, SampleHistogram), GeneratedChunkBuildError> {
    let source_level = image
        .multiscale
        .levels
        .get(source_level_index)
        .ok_or_else(|| RegionReadError::BadLevel {
            image: image.image_id.clone(),
            level: source_level_index,
        })?;
    let source_dims = spatial_dims_u32(source_level.shape)
        .map_err(|message| GeneratedChunkBuildError::Downsample(message.to_string()))?;
    let level = &plan.availability.level;
    let output_dims = spatial_dims_u32(level.shape)
        .map_err(|message| GeneratedChunkBuildError::Downsample(message.to_string()))?;
    let source_region = source_region_for_output_chunk(source_dims, output_dims, level, coords)
        .map_err(GeneratedChunkBuildError::Downsample)?;
    let (source_data, region_dims) = fetch_volume_region(
        image,
        coords.t,
        coords.c,
        source_level_index,
        source_region,
        store,
        resolver,
    )
    .await?;
    let owned = owned_source_region(source_dims, output_dims, level, coords)
        .map_err(GeneratedChunkBuildError::Downsample)?;
    let samples = region_histogram(
        &source_data,
        image.multiscale.data_type,
        source_region,
        region_dims,
        owned,
    )
    .map_err(GeneratedChunkBuildError::Downsample)?;
    let fill = resolver
        .level_info(&image.image_id, source_level_index as u32)
        .map(|info| info.fill_value)
        .unwrap_or_default();
    let bytes = downsample_region_to_generated_chunk(
        &source_data,
        image.multiscale.data_type,
        source_region,
        region_dims,
        source_dims,
        output_dims,
        level,
        coords,
        fill,
    )
    .map_err(GeneratedChunkBuildError::Downsample)?;
    Ok((bytes, samples))
}

fn spatial_dims_u32(shape: [u64; 5]) -> Result<[u32; 3], &'static str> {
    Ok([
        u32::try_from(shape[2]).map_err(|_| "generated coarse z dimension is too large")?,
        u32::try_from(shape[3]).map_err(|_| "generated coarse y dimension is too large")?,
        u32::try_from(shape[4]).map_err(|_| "generated coarse x dimension is too large")?,
    ])
}

#[derive(Debug, Clone, Copy)]
struct SpatialBounds {
    z0: u32,
    z1: u32,
    y0: u32,
    y1: u32,
    x0: u32,
    x1: u32,
}

fn output_chunk_bounds(
    output_dims: [u32; 3],
    level: &LevelGeometry,
    coords: GeneratedChunkCoords,
) -> Result<SpatialBounds, String> {
    let chunk_z = level.chunk_shape[2].max(1);
    let chunk_y = level.chunk_shape[3].max(1);
    let chunk_x = level.chunk_shape[4].max(1);
    let z0 = coords
        .z
        .checked_mul(chunk_z)
        .ok_or_else(|| "generated chunk z coordinate is too large".to_string())?;
    let y0 = coords
        .y
        .checked_mul(chunk_y)
        .ok_or_else(|| "generated chunk y coordinate is too large".to_string())?;
    let x0 = coords
        .x
        .checked_mul(chunk_x)
        .ok_or_else(|| "generated chunk x coordinate is too large".to_string())?;
    let [out_z, out_y, out_x] = output_dims;
    if z0 >= out_z as u64 || y0 >= out_y as u64 || x0 >= out_x as u64 {
        return Err("generated chunk key is outside the generated level".to_string());
    }
    let z1 = z0.saturating_add(chunk_z).min(out_z as u64);
    let y1 = y0.saturating_add(chunk_y).min(out_y as u64);
    let x1 = x0.saturating_add(chunk_x).min(out_x as u64);
    Ok(SpatialBounds {
        z0: u32::try_from(z0)
            .map_err(|_| "generated chunk z coordinate is too large".to_string())?,
        z1: u32::try_from(z1)
            .map_err(|_| "generated chunk z coordinate is too large".to_string())?,
        y0: u32::try_from(y0)
            .map_err(|_| "generated chunk y coordinate is too large".to_string())?,
        y1: u32::try_from(y1)
            .map_err(|_| "generated chunk y coordinate is too large".to_string())?,
        x0: u32::try_from(x0)
            .map_err(|_| "generated chunk x coordinate is too large".to_string())?,
        x1: u32::try_from(x1)
            .map_err(|_| "generated chunk x coordinate is too large".to_string())?,
    })
}

/// The source samples one output chunk counts toward its level's
/// histogram. On each axis, output `[a, b)` owns source `[a * in / out,
/// b * in / out)`, rounded down, so a level's chunks divide the source
/// between them and every sample counts once, though pooling windows on
/// either side of a chunk edge share samples.
fn owned_source_region(
    source_dims: [u32; 3],
    output_dims: [u32; 3],
    level: &LevelGeometry,
    coords: GeneratedChunkCoords,
) -> Result<VolumeRegion, String> {
    let bounds = output_chunk_bounds(output_dims, level, coords)?;
    let start = |o: u32, axis: usize| {
        u64::from(o) * u64::from(source_dims[axis]) / u64::from(output_dims[axis])
    };
    Ok(VolumeRegion {
        z0: start(bounds.z0, 0),
        z1: start(bounds.z1, 0),
        y0: start(bounds.y0, 1),
        y1: start(bounds.y1, 1),
        x0: start(bounds.x0, 2),
        x1: start(bounds.x1, 2),
    })
}

/// The finite samples inside `owned`, out of a fetched `region` of
/// `data_type` samples.
fn region_histogram(
    source: &[u8],
    data_type: DataType,
    region: VolumeRegion,
    region_dims: [u32; 3],
    owned: VolumeRegion,
) -> Result<SampleHistogram, String> {
    macro_rules! histogram_as {
        ($t:ty) => {
            owned_histogram::<$t>(source, region, region_dims, owned)
        };
    }
    match data_type {
        DataType::Uint8 => histogram_as!(u8),
        DataType::Uint16 => histogram_as!(u16),
        DataType::Uint32 => histogram_as!(u32),
        DataType::Int8 => histogram_as!(i8),
        DataType::Int16 => histogram_as!(i16),
        DataType::Int32 => histogram_as!(i32),
        DataType::Float32 => histogram_as!(f32),
        DataType::Float64 => histogram_as!(f64),
        DataType::Uint64 => histogram_as!(u64),
        DataType::Int64 => histogram_as!(i64),
        DataType::Float16 => histogram_as!(Half),
    }
}

fn owned_histogram<T: PoolSample>(
    source: &[u8],
    region: VolumeRegion,
    region_dims: [u32; 3],
    owned: VolumeRegion,
) -> Result<SampleHistogram, String> {
    let [dz, dy, dx] = region_dims.map(|d| d as usize);
    if source.len() != dz * dy * dx * T::SIZE {
        return Err("source generated coarse region has the wrong length".to_string());
    }
    let inside =
        |lo: u64, hi: u64, from: u64, len: usize| lo >= from && hi >= lo && hi <= from + len as u64;
    if !inside(owned.z0, owned.z1, region.z0, dz)
        || !inside(owned.y0, owned.y1, region.y0, dy)
        || !inside(owned.x0, owned.x1, region.x0, dx)
    {
        return Err("generated chunk owns source samples it did not read".to_string());
    }
    let values = (owned.z0..owned.z1)
        .flat_map(|z| (owned.y0..owned.y1).map(move |y| (z, y)))
        .flat_map(|(z, y)| {
            let row = ((z - region.z0) as usize * dy + (y - region.y0) as usize) * dx;
            (owned.x0..owned.x1).map(move |x| {
                let i = row + (x - region.x0) as usize;
                T::read(&source[i * T::SIZE..(i + 1) * T::SIZE]).to_f64()
            })
        });
    Ok(SampleHistogram::of(values))
}

fn source_region_for_output_chunk(
    source_dims: [u32; 3],
    output_dims: [u32; 3],
    level: &LevelGeometry,
    coords: GeneratedChunkCoords,
) -> Result<VolumeRegion, String> {
    let bounds = output_chunk_bounds(output_dims, level, coords)?;
    let [in_z, in_y, in_x] = source_dims;
    let [out_z, out_y, out_x] = output_dims;
    let (z0, _) = scale_range(bounds.z0, out_z, in_z);
    let (_, z1) = scale_range(bounds.z1 - 1, out_z, in_z);
    let (y0, _) = scale_range(bounds.y0, out_y, in_y);
    let (_, y1) = scale_range(bounds.y1 - 1, out_y, in_y);
    let (x0, _) = scale_range(bounds.x0, out_x, in_x);
    let (_, x1) = scale_range(bounds.x1 - 1, out_x, in_x);
    Ok(VolumeRegion {
        z0: z0 as u64,
        z1: z1 as u64,
        y0: y0 as u64,
        y1: y1 as u64,
        x0: x0 as u64,
        x1: x1 as u64,
    })
}

/// One sample type a generated level pools in, read and written as its
/// little-endian bytes, so a generated chunk holds the source's own values.
trait PoolSample: Copy {
    const SIZE: usize = std::mem::size_of::<Self>();
    fn read(bytes: &[u8]) -> Self;
    fn write(self, out: &mut [u8]);
    /// The larger sample. A float NaN loses to any number, so a generated
    /// sample is NaN only when every source sample under it is.
    fn pool_max(self, other: Self) -> Self;
    fn to_f64(self) -> f64;
}

macro_rules! pool_sample {
    ($($t:ty),* $(,)?) => {$(
        impl PoolSample for $t {
            fn read(bytes: &[u8]) -> Self {
                let mut le = [0_u8; std::mem::size_of::<$t>()];
                le.copy_from_slice(bytes);
                <$t>::from_le_bytes(le)
            }
            fn write(self, out: &mut [u8]) {
                out.copy_from_slice(&self.to_le_bytes());
            }
            fn pool_max(self, other: Self) -> Self {
                <$t>::max(self, other)
            }
            fn to_f64(self) -> f64 {
                self as f64
            }
        }
    )*};
}

pool_sample!(u8, u16, u32, u64, i8, i16, i32, i64, f32, f64);

/// A half-precision float sample, held as its bits: stable Rust has no `f16`.
#[derive(Clone, Copy)]
struct Half(u16);

impl Half {
    /// The sample's value. Every half is exactly a float32.
    fn value(self) -> f32 {
        let bits = u32::from(self.0);
        let negative = bits & 0x8000 != 0;
        let exponent = (bits >> 10) & 0x1f;
        let mantissa = bits & 0x3ff;
        let magnitude = match exponent {
            0 => mantissa as f32 * 2f32.powi(-24),
            0x1f => f32::from_bits(0x7f80_0000 | (mantissa << 13)),
            _ => f32::from_bits(((exponent + 127 - 15) << 23) | (mantissa << 13)),
        };
        if negative { -magnitude } else { magnitude }
    }
}

impl PoolSample for Half {
    const SIZE: usize = 2;
    fn read(bytes: &[u8]) -> Self {
        Half(u16::from_le_bytes([bytes[0], bytes[1]]))
    }
    fn write(self, out: &mut [u8]) {
        out.copy_from_slice(&self.0.to_le_bytes());
    }
    fn pool_max(self, other: Self) -> Self {
        let (a, b) = (self.value(), other.value());
        if a.is_nan() || b > a { other } else { self }
    }
    fn to_f64(self) -> f64 {
        f64::from(self.value())
    }
}

/// Max-pool one generated chunk from a source region of `data_type`
/// samples (little-endian bytes, as `fetch_volume_region` returns them) into
/// that chunk's bytes, in the same type. An edge chunk is padded with the
/// source's fill value, as the source's own edge chunks read.
#[allow(clippy::too_many_arguments)]
fn downsample_region_to_generated_chunk(
    source: &[u8],
    data_type: DataType,
    source_region: VolumeRegion,
    region_dims: [u32; 3],
    source_dims: [u32; 3],
    output_dims: [u32; 3],
    level: &LevelGeometry,
    coords: GeneratedChunkCoords,
    fill: FillValue,
) -> Result<Vec<u8>, String> {
    macro_rules! pool_as {
        ($t:ty) => {
            max_pool_region::<$t>(
                source,
                source_region,
                region_dims,
                source_dims,
                output_dims,
                level,
                coords,
                fill,
            )
        };
    }
    match data_type {
        DataType::Uint8 => pool_as!(u8),
        DataType::Uint16 => pool_as!(u16),
        DataType::Uint32 => pool_as!(u32),
        DataType::Int8 => pool_as!(i8),
        DataType::Int16 => pool_as!(i16),
        DataType::Int32 => pool_as!(i32),
        DataType::Float32 => pool_as!(f32),
        DataType::Float64 => pool_as!(f64),
        DataType::Uint64 => pool_as!(u64),
        DataType::Int64 => pool_as!(i64),
        DataType::Float16 => pool_as!(Half),
    }
}

#[allow(clippy::too_many_arguments)]
fn max_pool_region<T: PoolSample>(
    source: &[u8],
    source_region: VolumeRegion,
    region_dims: [u32; 3],
    source_dims: [u32; 3],
    output_dims: [u32; 3],
    level: &LevelGeometry,
    coords: GeneratedChunkCoords,
    fill: FillValue,
) -> Result<Vec<u8>, String> {
    let expected = (region_dims[0] as usize)
        .checked_mul(region_dims[1] as usize)
        .and_then(|v| v.checked_mul(region_dims[2] as usize))
        .ok_or_else(|| "source generated coarse region is too large".to_string())?;
    if source.len() != expected * T::SIZE {
        return Err(format!(
            "source generated coarse region has {} bytes, expected {expected} samples of {} bytes",
            source.len(),
            T::SIZE
        ));
    }
    let sample = |index: usize| T::read(&source[index * T::SIZE..(index + 1) * T::SIZE]);

    let bounds = output_chunk_bounds(output_dims, level, coords)?;
    let chunk_z = level.chunk_shape[2].max(1);
    let chunk_y = level.chunk_shape[3].max(1);
    let chunk_x = level.chunk_shape[4].max(1);
    let chunk_voxels = (chunk_z as usize)
        .checked_mul(chunk_y as usize)
        .and_then(|v| v.checked_mul(chunk_x as usize))
        .ok_or_else(|| "generated coarse chunk is too large".to_string())?;
    let mut chunk = fill.bytes(chunk_voxels * T::SIZE);

    let [in_z, in_y, in_x] = source_dims;
    let [out_z, out_y, out_x] = output_dims;
    let source_stride_y = region_dims[2] as usize;
    let source_stride_z = (region_dims[1] as usize) * source_stride_y;
    let chunk_stride_y = chunk_x as usize;
    let chunk_stride_z = (chunk_y as usize) * chunk_stride_y;

    for oz in bounds.z0..bounds.z1 {
        let (src_z0, src_z1) = scale_range(oz, out_z, in_z);
        for oy in bounds.y0..bounds.y1 {
            let (src_y0, src_y1) = scale_range(oy, out_y, in_y);
            for ox in bounds.x0..bounds.x1 {
                let (src_x0, src_x1) = scale_range(ox, out_x, in_x);
                let mut value: Option<T> = None;
                for iz in src_z0..src_z1 {
                    let local_z = (iz as u64)
                        .checked_sub(source_region.z0)
                        .ok_or_else(|| "generated coarse source z underflow".to_string())?;
                    for iy in src_y0..src_y1 {
                        let local_y = (iy as u64)
                            .checked_sub(source_region.y0)
                            .ok_or_else(|| "generated coarse source y underflow".to_string())?;
                        let base = (local_z as usize) * source_stride_z
                            + (local_y as usize) * source_stride_y;
                        for ix in src_x0..src_x1 {
                            let local_x = (ix as u64)
                                .checked_sub(source_region.x0)
                                .ok_or_else(|| "generated coarse source x underflow".to_string())?;
                            let s = sample(base + local_x as usize);
                            value = Some(value.map_or(s, |v| v.pool_max(s)));
                        }
                    }
                }
                let dst = ((oz - bounds.z0) as usize) * chunk_stride_z
                    + ((oy - bounds.y0) as usize) * chunk_stride_y
                    + (ox - bounds.x0) as usize;
                // `scale_range` never yields an empty window.
                if let Some(value) = value {
                    value.write(&mut chunk[dst * T::SIZE..(dst + 1) * T::SIZE]);
                }
            }
        }
    }

    Ok(chunk)
}

async fn publish_all_chunks_for_plan(
    plan: &GeneratedCoarsePlan,
    status: GeneratedChunkStatus,
    message: Option<String>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    let level = &plan.availability.level;
    for t in 0..level.shape[0] {
        for c in 0..level.shape[1] {
            if let (Ok(t), Ok(c)) = (u32::try_from(t), u32::try_from(c)) {
                publish_chunks_for_tc(
                    plan,
                    t,
                    c,
                    status,
                    message.clone(),
                    cache.clone(),
                    session.clone(),
                    tx.clone(),
                )
                .await;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn publish_chunks_for_tc(
    plan: &GeneratedCoarsePlan,
    t: u32,
    c: u32,
    status: GeneratedChunkStatus,
    message: Option<String>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    for key in plan.chunk_keys_for_tc(t, c) {
        publish_chunk_status(
            &plan.dataset_id,
            &plan.image_id,
            plan.level_index,
            key,
            status,
            message.clone(),
            cache.clone(),
            session.clone(),
            tx.clone(),
        )
        .await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn publish_chunk_status(
    dataset_id: &DatasetId,
    image_id: &ImageId,
    level_index: u32,
    key: String,
    status: GeneratedChunkStatus,
    message: Option<String>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    publish_generated_delta(
        dataset_id.clone(),
        GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: image_id.clone(),
                level_index,
                key,
                status,
                message,
            }],
            histograms: vec![],
        },
        cache,
        session,
        tx,
    )
    .await;
}

async fn publish_generated_delta(
    dataset_id: DatasetId,
    delta: GeneratedAvailabilityDelta,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    cache.apply_delta(delta.clone());
    {
        let mut sess = session.lock().await;
        sess.apply_generated_availability_delta(dataset_id.clone(), delta.clone());
    }
    let msg = ServerMessage::GeneratedAvailabilityUpdate { dataset_id, delta };
    let _ = tx.send(BroadcastItem::GeneratedAvailabilityUpdate {
        json: serde_json::to_string(&msg).unwrap(),
    });
}

fn generated_status_for_source_error(error: &RegionReadError) -> GeneratedChunkStatus {
    match error {
        RegionReadError::Fetch { .. } => GeneratedChunkStatus::FailedTransient,
        RegionReadError::BadLevel { .. }
        | RegionReadError::OutOfBounds { .. }
        | RegionReadError::SpatialOutOfBounds { .. }
        | RegionReadError::UnknownImage(_)
        | RegionReadError::Decode { .. }
        | RegionReadError::ShortChunk { .. }
        | RegionReadError::TooLarge => GeneratedChunkStatus::FailedPermanent,
    }
}

fn generated_status_for_chunk_error(error: &GeneratedChunkBuildError) -> GeneratedChunkStatus {
    match error {
        GeneratedChunkBuildError::Source(source) => generated_status_for_source_error(source),
        GeneratedChunkBuildError::Downsample(_) => GeneratedChunkStatus::FailedPermanent,
    }
}

fn chunks_for_identity_locked(
    state: &DerivedChunkState,
    identity: &str,
) -> Vec<GeneratedChunkStatusUpdate> {
    let levels_for_identity = state
        .level_identities
        .iter()
        .filter_map(|((image_id, level_index), mapped)| {
            (mapped == identity).then_some((image_id.clone(), *level_index))
        })
        .collect::<HashSet<_>>();
    state
        .chunks
        .iter()
        .filter_map(|(key, entry)| {
            levels_for_identity
                .contains(&(key.image_id.clone(), key.level_index))
                .then_some(GeneratedChunkStatusUpdate {
                    image_id: key.image_id.clone(),
                    level_index: key.level_index,
                    key: key.key.clone(),
                    status: entry.status,
                    message: entry.message.clone(),
                })
        })
        .collect()
}

fn expected_generated_chunk_bytes(plan: &GeneratedCoarsePlan) -> u64 {
    checked_product(&[
        plan.availability.level.chunk_shape[2],
        plan.availability.level.chunk_shape[3],
        plan.availability.level.chunk_shape[4],
        data_type_size(plan.output_data_type),
    ])
    .unwrap_or(0)
}

fn dir_size_and_modified(path: &PathBuf) -> io::Result<(u64, std::time::SystemTime)> {
    let mut total = 0_u64;
    let mut oldest = std::time::SystemTime::now();
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((0, oldest)),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let metadata = entry.metadata()?;
        let modified = metadata.modified().unwrap_or(oldest);
        oldest = oldest.min(modified);
        if metadata.is_dir() {
            let (bytes, child_modified) = dir_size_and_modified(&entry.path())?;
            total = total.saturating_add(bytes);
            oldest = oldest.min(child_modified);
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok((total, oldest))
}

/// An image's id with its dataset's id taken off the front.
///
/// Every workspace that opens a source gets a dataset id of its own, and
/// image ids start with it. The generated identities are built from what is
/// left, so every dataset over one source finds the same generated level on
/// disk. The disk cache is already a directory per source, which keeps two
/// sources apart.
fn source_relative_image_id<'a>(dataset_id: &DatasetId, image_id: &'a ImageId) -> &'a str {
    image_id
        .0
        .strip_prefix(dataset_id.0.as_str())
        .unwrap_or(&image_id.0)
}

fn source_content_id_for_image(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    input_fills: &[FillValue],
) -> String {
    let value = serde_json::json!({
        "image": source_relative_image_id(&manifest.dataset_id, &image.image_id),
        "multiscale": &image.multiscale,
        "input_fill_values": input_fills,
        "generator": GENERATED_COARSE_GENERATOR_VERSION,
    });
    hex32(blake3::hash(value.to_string().as_bytes()).as_bytes())
}

fn generated_level_identity(
    source_content_id: &str,
    image_key: &str,
    level: &LevelGeometry,
    config_id: &str,
) -> String {
    let value = serde_json::json!({
        "source_content_id": source_content_id,
        "image_id": image_key,
        "level": level,
        "config_id": config_id,
        "generator": GENERATED_COARSE_GENERATOR_VERSION,
    });
    format!(
        "gc-{}",
        &hex32(blake3::hash(value.to_string().as_bytes()).as_bytes())[..24]
    )
}

fn generated_cache_identity(
    source_content_id: &str,
    image_key: &str,
    generated_level_id: &str,
    level: &LevelGeometry,
    data_type: DataType,
    config_id: &str,
    input_level_candidates: &[usize],
) -> String {
    let value = serde_json::json!({
        "source_content_id": source_content_id,
        "image_id": image_key,
        "input_scope": input_level_candidates,
        "output_geometry": level,
        "output_dtype": data_type,
        "downsample": DOWNSAMPLE_ALGORITHM_VERSION,
        "config_id": config_id,
        "generator": GENERATED_COARSE_GENERATOR_VERSION,
        "generated_level_id": generated_level_id,
    });
    format!(
        "generated-coarse-{}",
        hex32(blake3::hash(value.to_string().as_bytes()).as_bytes())
    )
}

fn generated_output_long_axis(source_shape: [u64; 5], target_long_axis: u64) -> u64 {
    source_shape[3]
        .max(source_shape[4])
        .min(target_long_axis)
        .max(1)
}

fn generated_output_shape(
    source_level0_shape: [u64; 5],
    selected_input_shape: [u64; 5],
    config: &GeneratedCoarseConfig,
) -> [u64; 5] {
    let source_z = source_level0_shape[2].max(1);
    let source_y = source_level0_shape[3].max(1);
    let source_x = source_level0_shape[4].max(1);
    let long_axis = source_y.max(source_x);
    let target_long = long_axis.min(config.target_long_axis).max(1);
    let scale = target_long as f64 / long_axis as f64;
    let out_z = ((source_z as f64) * scale).round().max(1.0) as u64;
    let out_y = ((source_y as f64) * scale).round().max(1.0) as u64;
    let out_x = ((source_x as f64) * scale).round().max(1.0) as u64;
    [
        source_level0_shape[0],
        source_level0_shape[1],
        out_z.min(source_z).min(selected_input_shape[2].max(1)),
        out_y.min(source_y).min(selected_input_shape[3].max(1)),
        out_x.min(source_x).min(selected_input_shape[4].max(1)),
    ]
}

fn input_level_candidates(image: &ImageSpec, target_long_axis: u64) -> Vec<usize> {
    let mut candidates: Vec<(usize, u64)> = image
        .multiscale
        .levels
        .iter()
        .enumerate()
        .filter_map(|(idx, level)| {
            let long_axis = level.shape[3].max(level.shape[4]);
            (long_axis >= target_long_axis).then_some((idx, long_axis))
        })
        .collect();
    candidates.sort_by_key(|(idx, long_axis)| (*long_axis, *idx));
    if candidates.is_empty() {
        vec![0]
    } else {
        candidates.into_iter().map(|(idx, _)| idx).collect()
    }
}

fn generated_chunk_shape(
    output_shape: [u64; 5],
    source_shape: [u64; 5],
    source_chunk_shape: [u64; 5],
    data_type: DataType,
    config: &GeneratedCoarseConfig,
) -> [u64; 5] {
    let bytes_per_voxel = data_type_size(data_type);
    let mut chunk_z = output_chunk_axis_for_source_chunk(
        output_shape[2],
        source_shape[2],
        source_chunk_shape[2],
        config.chunk_long_axis,
        1,
    );
    let mut chunk_y = output_chunk_axis_for_source_chunk(
        output_shape[3],
        source_shape[3],
        source_chunk_shape[3],
        config.chunk_long_axis,
        config.min_chunk_axis,
    );
    let mut chunk_x = output_chunk_axis_for_source_chunk(
        output_shape[4],
        source_shape[4],
        source_chunk_shape[4],
        config.chunk_long_axis,
        config.min_chunk_axis,
    );
    while checked_product(&[chunk_z, chunk_y, chunk_x, bytes_per_voxel])
        .is_some_and(|bytes| bytes > config.max_chunk_bytes)
        && (chunk_z > 1 || chunk_y > 1 || chunk_x > 1)
    {
        if chunk_z >= chunk_y && chunk_z >= chunk_x && chunk_z > 1 {
            chunk_z = chunk_z.div_ceil(2).max(1);
        } else if chunk_y >= chunk_x && chunk_y > 1 {
            chunk_y = chunk_y.div_ceil(2).max(1);
        } else if chunk_x > 1 {
            chunk_x = chunk_x.div_ceil(2).max(1);
        }
    }
    [1, 1, chunk_z, chunk_y, chunk_x]
}

/// One axis of a generated chunk: the output span of one source chunk, or
/// of as many as it takes to reach `floor`, so chunk edges keep following
/// source chunk edges.
fn output_chunk_axis_for_source_chunk(
    output_axis: u64,
    source_axis: u64,
    source_chunk_axis: u64,
    chunk_axis_cap: u64,
    floor: u64,
) -> u64 {
    let output_axis = output_axis.max(1);
    let source_axis = source_axis.max(1);
    let source_chunk_axis = source_chunk_axis.max(1);
    let cap = chunk_axis_cap.max(1);
    let footprint = output_axis
        .saturating_mul(source_chunk_axis)
        .div_ceil(source_axis)
        .max(1);
    let axis = footprint.saturating_mul(floor.div_ceil(footprint).max(1));
    axis.min(output_axis).min(cap)
}

fn generated_scale(source_shape: [u64; 5], output_shape: [u64; 5]) -> [f64; 5] {
    [
        1.0,
        1.0,
        scale_axis(source_shape[2], output_shape[2]),
        scale_axis(source_shape[3], output_shape[3]),
        scale_axis(source_shape[4], output_shape[4]),
    ]
}

fn scale_axis(source: u64, output: u64) -> f64 {
    if output == 0 {
        1.0
    } else {
        source as f64 / output as f64
    }
}

fn next_generated_level_index(levels: &[LevelGeometry]) -> u32 {
    levels
        .iter()
        .map(|level| level.level_index)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

fn grid_shape(shape: [u64; 5], chunk_shape: [u64; 5]) -> [u64; 5] {
    std::array::from_fn(|axis| shape[axis].div_ceil(chunk_shape[axis].max(1)).max(1))
}

fn chunk_key(level_index: u32, t: u32, c: u32, z: u64, y: u64, x: u64) -> String {
    format!("{level_index}/{t}/{c}/{z}/{y}/{x}")
}

fn parse_generated_chunk_key(key: &str) -> Option<GeneratedChunkCoords> {
    let mut parts = key.split('/');
    let level_index = parts.next()?.parse().ok()?;
    let t = parts.next()?.parse().ok()?;
    let c = parts.next()?.parse().ok()?;
    let z = parts.next()?.parse().ok()?;
    let y = parts.next()?.parse().ok()?;
    let x = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(GeneratedChunkCoords {
        level_index,
        t,
        c,
        z,
        y,
        x,
    })
}

fn checked_product(values: &[u64]) -> Option<u64> {
    values
        .iter()
        .try_fold(1_u64, |acc, value| acc.checked_mul(*value))
}

fn data_type_size(data_type: DataType) -> u64 {
    data_type.size_bytes() as u64
}

fn scale_range(out_index: u32, out_len: u32, in_len: u32) -> (u32, u32) {
    let start = ((out_index as u64) * (in_len as u64) / (out_len as u64)) as u32;
    let end = (((out_index as u64 + 1) * (in_len as u64)).div_ceil(out_len as u64)) as u32;
    let end = end.max(start + 1).min(in_len);
    (start.min(in_len.saturating_sub(1)), end)
}

fn hex32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

pub fn merge_generated_availability_into_manifest(
    manifest: &mut DatasetManifest,
    availability: &GeneratedAvailabilitySnapshot,
) {
    for level in &availability.levels {
        let Some(image) = manifest
            .images_mut()
            .iter_mut()
            .find(|image| image.image_id == level.image_id)
        else {
            continue;
        };

        if let Some(existing) = image
            .multiscale
            .levels
            .iter_mut()
            .find(|existing| existing.level_index == level.level.level_index)
        {
            *existing = level.level.clone();
        } else {
            let insert_at = level.level.level_index as usize;
            if insert_at <= image.multiscale.levels.len() {
                image
                    .multiscale
                    .levels
                    .insert(insert_at, level.level.clone());
            } else {
                image.multiscale.levels.push(level.level.clone());
            }
        }

        if let Some(existing) = image
            .multiscale
            .generated_levels
            .iter_mut()
            .find(|existing| existing.level_index == level.info.level_index)
        {
            *existing = level.info.clone();
        } else {
            image.multiscale.generated_levels.push(level.info.clone());
        }

        if level.info.role == GeneratedLevelRole::Coarse {
            image.multiscale.coarse_level_index = Some(level.info.level_index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::{
        Axis, AxisKind, DataType, DatasetId, DatasetKind, Entity, EntityId, EntityKind,
        EntityLabels, GeneratedLevelInfo, GeneratedLevelProvenance, LevelGeometry, MultiscaleInfo,
    };
    use lucida_store::codec::StorageCompression;
    use lucida_store::import_types::{ImageBindingSeed, LevelBindingInfo, ServerBindingSeed};
    use lucida_store::layout::ChunkByteLayout;
    use object_store::ObjectStoreExt;
    use tokio::sync::broadcast;

    fn generated_level() -> GeneratedLevelAvailability {
        GeneratedLevelAvailability {
            image_id: ImageId("img-1".into()),
            info: GeneratedLevelInfo {
                level_index: 1,
                role: GeneratedLevelRole::Coarse,
                provenance: GeneratedLevelProvenance::default(),
            },
            level: LevelGeometry {
                level_index: 1,
                shape: [1, 1, 1, 64, 64],
                chunk_shape: [1, 1, 1, 64, 64],
                grid_shape: [1, 1, 1, 1, 1],
                scale: [1.0, 1.0, 1.0, 4.0, 4.0],
            },
            summary: None,
        }
    }

    fn source_manifest() -> DatasetManifest {
        source_manifest_with_levels(
            vec![LevelGeometry {
                level_index: 0,
                shape: [1, 1, 1, 256, 256],
                chunk_shape: [1, 1, 1, 128, 128],
                grid_shape: [1, 1, 1, 2, 2],
                scale: [1.0, 1.0, 1.0, 1.0, 1.0],
            }],
            None,
            DataType::Uint16,
        )
    }

    fn source_manifest_with_levels(
        levels: Vec<LevelGeometry>,
        coarse_level_index: Option<u32>,
        data_type: DataType,
    ) -> DatasetManifest {
        let entity_id = EntityId("entity-1".into());
        DatasetManifest::new(
            DatasetId("ds-1".into()),
            "test".into(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels::default(),
            }],
            vec![],
            vec![lucida_content::ImageSpec {
                image_id: ImageId("img-1".into()),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".into(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".into(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".into(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels,
                    coarse_level_index,
                    generated_levels: vec![],
                    data_type,
                    pinned_axes: vec![],
                    downsampling_method: None,
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        )
    }

    fn level(level_index: u32, shape: [u64; 5], chunk_shape: [u64; 5]) -> LevelGeometry {
        LevelGeometry {
            level_index,
            shape,
            chunk_shape,
            grid_shape: grid_shape(shape, chunk_shape),
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        }
    }

    fn binding_seed_for(levels: &[LevelGeometry]) -> ServerBindingSeed {
        binding_seed_for_data_type(levels, DataType::Uint16)
    }

    /// A binding that knows no image, so every fill value reads as zero.
    fn no_binding() -> ChunkResolver {
        ChunkResolver::new(&ServerBindingSeed { images: vec![] })
    }

    fn source_path(resolver: &ChunkResolver, key: &str) -> object_store::path::Path {
        resolver
            .resolve(
                &ImageId("img-1".into()),
                &lucida_content::ChunkKey::parse(key).unwrap(),
            )
            .unwrap()
            .path()
            .clone()
    }

    fn binding_seed_for_data_type(
        levels: &[LevelGeometry],
        data_type: DataType,
    ) -> ServerBindingSeed {
        binding_seed_with_fill(levels, data_type, FillValue::default())
    }

    fn binding_seed_with_fill(
        levels: &[LevelGeometry],
        data_type: DataType,
        fill: FillValue,
    ) -> ServerBindingSeed {
        ServerBindingSeed {
            images: vec![ImageBindingSeed {
                image_id: ImageId("img-1".into()),
                axes_names: vec!["t".into(), "c".into(), "z".into(), "y".into(), "x".into()],
                store_prefix: None,
                levels: levels
                    .iter()
                    .map(|level| {
                        let chunk_bytes = checked_product(&[
                            level.chunk_shape[2],
                            level.chunk_shape[3],
                            level.chunk_shape[4],
                            data_type_size(data_type),
                        ])
                        .unwrap() as usize;
                        LevelBindingInfo {
                            level_index: level.level_index,
                            path: level.level_index.to_string(),
                            compression: StorageCompression::None,
                            chunk_shape: level.chunk_shape.to_vec(),
                            chunk_byte_layout: ChunkByteLayout {
                                canonical_byte_size: chunk_bytes,
                                on_disk_byte_size: chunk_bytes,
                                byte_stride_t: 0,
                                byte_stride_c: 0,
                                chunk_size_t: 1,
                                chunk_size_c: 1,
                            },
                            chunk_key_encoding: Default::default(),
                            fill_value: fill,
                            shard: None,
                            regrid: None,
                        }
                    })
                    .collect(),
            }],
        }
    }

    /// Count every chunk of `(t, c)` toward its histogram, as generating
    /// them all does, so the level's chunks there can be adopted later.
    fn complete_histogram(
        cache: &DerivedChunkCache,
        plan: &GeneratedCoarsePlan,
        t: u32,
        c: u32,
    ) -> GeneratedLevelHistogram {
        let mut completed = None;
        for key in plan.chunk_keys_for_tc(t, c) {
            assert!(completed.is_none(), "completed before its last chunk");
            let coords = parse_generated_chunk_key(&key).unwrap();
            completed =
                cache.count_histogram(plan, coords, &key, &SampleHistogram::of([coords.x as f64]));
        }
        completed.expect("the last chunk completes the histogram")
    }

    fn service_for_plan(
        manifest: DatasetManifest,
        plan: GeneratedCoarsePlan,
        config: GeneratedSchedulingConfig,
    ) -> GeneratedCoarseService {
        let cache = Arc::new(DerivedChunkCache::default());
        cache.upsert_level(plan.availability.clone());
        service_with_cache(manifest, plan, config, cache)
    }

    fn service_with_cache(
        manifest: DatasetManifest,
        plan: GeneratedCoarsePlan,
        config: GeneratedSchedulingConfig,
        cache: Arc<DerivedChunkCache>,
    ) -> GeneratedCoarseService {
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cached = Arc::new(CachedStore::new(store, 1024 * 1024));
        let image = &manifest.images()[0];
        let resolver = Arc::new(ChunkResolver::new(&binding_seed_for_data_type(
            &image.multiscale.levels,
            image.multiscale.data_type,
        )));
        let (tx, _rx) = broadcast::channel(16);
        GeneratedCoarseService::new(
            vec![plan],
            Arc::new(manifest),
            cached,
            resolver,
            cache,
            Arc::new(AsyncMutex::new(Session::new())),
            tx,
            config,
        )
    }

    fn interest(
        dataset_id: DatasetId,
        image_id: ImageId,
        key: &str,
        lane: ViewerInterestLane,
        timestamp_ms: u64,
    ) -> ViewerInterestHint {
        ViewerInterestHint {
            client_id: None,
            dataset_id,
            generation: 1,
            t: 0,
            z: 0,
            channels: vec![0],
            mode: lucida_core::protocol::ViewerInterestMode::Slice,
            viewport: None,
            desired_keys: vec![ViewerInterestChunkKey {
                image_id,
                key: key.into(),
                lane,
            }],
            predicted_keys: vec![],
            interaction: lucida_core::protocol::ViewerInteractionMode::Idle,
            timestamp_ms,
            ttl_ms: 10_000,
        }
    }

    #[test]
    fn generated_level_without_chunk_status_is_pending() {
        let cache = DerivedChunkCache::default();
        cache.upsert_level(generated_level());

        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Status { status, .. } => {
                assert_eq!(status, GeneratedChunkStatus::Pending);
            }
            DerivedChunkLookup::Ready(_) => panic!("expected pending"),
        }
    }

    #[test]
    fn seeded_ready_chunk_returns_bytes() {
        let cache = DerivedChunkCache::default();
        cache.upsert_level(generated_level());
        cache.seed_ready_chunk(
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        );

        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => assert_eq!(bytes, vec![1, 2, 3, 4]),
            DerivedChunkLookup::Status { status, .. } => {
                panic!("expected ready, got {status:?}");
            }
        }
    }

    #[test]
    fn generated_coarse_planner_skips_images_with_source_coarse() {
        let manifest = source_manifest_with_levels(
            vec![
                level(0, [1, 1, 1, 4096, 4096], [1, 1, 1, 512, 512]),
                level(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]),
            ],
            Some(1),
            DataType::Uint16,
        );

        let plans = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        );

        assert!(plans.is_empty());
    }

    #[test]
    fn generated_coarse_planner_uses_nearest_finer_input_and_bounded_chunks() {
        let manifest = source_manifest_with_levels(
            vec![
                level(0, [1, 1, 1, 4096, 4096], [1, 1, 1, 512, 512]),
                level(1, [1, 1, 1, 1024, 1024], [1, 1, 1, 512, 512]),
                level(2, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]),
            ],
            None,
            DataType::Uint16,
        );
        let config = GeneratedCoarseConfig {
            target_long_axis: 512,
            chunk_long_axis: 512,
            max_chunk_bytes: 128,
            min_chunk_axis: 1,
        };

        let plans = plan_generated_coarse_for_manifest(&manifest, &no_binding(), config);

        assert_eq!(plans.len(), 1);
        let plan = &plans[0];
        assert_eq!(plan.input_level_candidates, vec![1, 0]);
        assert_eq!(plan.availability.level.shape, [1, 1, 1, 512, 512]);
        let chunk = plan.availability.level.chunk_shape;
        assert!(
            checked_product(&[
                chunk[2],
                chunk[3],
                chunk[4],
                data_type_size(DataType::Uint16)
            ])
            .is_some_and(|bytes| bytes <= 128)
        );
        assert_eq!(
            plan.availability.info.provenance.generator,
            GENERATED_COARSE_GENERATOR_VERSION
        );
        assert_eq!(
            plan.availability.info.provenance.source_content_id,
            Some(plan.source_content_id.clone())
        );
    }

    #[test]
    fn generated_coarse_planner_downsamples_z_and_aligns_chunks_to_source_footprint() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 2480, 8058, 7718], [1, 1, 32, 1024, 1024])],
            None,
            DataType::Float32,
        );

        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");

        assert_eq!(plan.availability.level.shape, [1, 1, 158, 512, 490]);
        assert_eq!(plan.availability.level.chunk_shape, [1, 1, 3, 66, 66]);
        assert_eq!(plan.availability.level.grid_shape, [1, 1, 53, 8, 8]);
    }

    #[test]
    fn small_source_chunks_are_batched_into_generated_chunks_at_least_the_floor_across() {
        // Pooled to 512 across, one 64-sample source chunk spans 11 samples:
        // 2209 generated chunks if each held one.
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 3000, 3000], [1, 1, 1, 64, 64])],
            None,
            DataType::Uint16,
        );

        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");

        let level = &plan.availability.level;
        assert_eq!(level.shape, [1, 1, 1, 512, 512]);
        assert_eq!(
            level.chunk_shape,
            [1, 1, 1, 66, 66],
            "six source chunks a side"
        );
        assert_eq!(level.grid_shape, [1, 1, 1, 8, 8]);
    }

    #[test]
    fn a_generated_level_smaller_than_the_floor_is_one_chunk_across() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 40, 3000], [1, 1, 1, 8, 64])],
            None,
            DataType::Uint16,
        );

        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");

        assert_eq!(plan.availability.level.shape, [1, 1, 1, 7, 512]);
        assert_eq!(plan.availability.level.chunk_shape, [1, 1, 1, 7, 66]);
    }

    #[test]
    fn generated_chunk_job_key_carries_identity_scope() {
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");

        let key = plan.job_key(2, 3, "1/2/3/0/0/0".into());

        assert_eq!(key.source_content_id, plan.source_content_id);
        assert_eq!(key.generated_level_id, plan.generated_level_id);
        assert_eq!(key.image_id, ImageId("img-1".into()));
        assert_eq!(key.t, 2);
        assert_eq!(key.c, 3);
        assert_eq!(key.chunk_key, "1/2/3/0/0/0");
        assert_eq!(key.config_id, plan.config.config_id());
    }

    /// Pools a whole `in_dims` source into one generated chunk of `out_dims`.
    fn pool_whole(
        source: &[u8],
        data_type: DataType,
        in_dims: [u32; 3],
        out_dims: [u32; 3],
    ) -> Vec<u8> {
        let shape = [
            1,
            1,
            out_dims[0] as u64,
            out_dims[1] as u64,
            out_dims[2] as u64,
        ];
        let level = LevelGeometry {
            level_index: 1,
            shape,
            chunk_shape: shape,
            grid_shape: [1; 5],
            scale: [1.0; 5],
        };
        let coords = GeneratedChunkCoords {
            level_index: 1,
            t: 0,
            c: 0,
            z: 0,
            y: 0,
            x: 0,
        };
        let region =
            source_region_for_output_chunk(in_dims, out_dims, &level, coords).expect("region");
        downsample_region_to_generated_chunk(
            source,
            data_type,
            region,
            in_dims,
            in_dims,
            out_dims,
            &level,
            coords,
            FillValue::default(),
        )
        .expect("pooled")
    }

    #[test]
    fn max_downsample_preserves_sparse_source_pixels() {
        let input: Vec<u8> = (0_u16..16).flat_map(u16::to_le_bytes).collect();

        let bytes = pool_whole(&input, DataType::Uint16, [1, 4, 4], [1, 2, 2]);
        let output: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes(*b))
            .collect();

        assert_eq!(output, vec![5, 7, 13, 15]);
    }

    #[test]
    fn generated_chunk_pads_edge_chunks_with_the_fill_value() {
        let level = LevelGeometry {
            level_index: 1,
            shape: [1, 1, 1, 3, 3],
            chunk_shape: [1, 1, 1, 2, 2],
            grid_shape: [1, 1, 1, 2, 2],
            scale: [1.0; 5],
        };
        let coords = GeneratedChunkCoords {
            level_index: 1,
            t: 0,
            c: 0,
            z: 0,
            y: 1,
            x: 1,
        };
        let input: Vec<u8> = (1_u16..=9).flat_map(u16::to_le_bytes).collect();
        let region =
            source_region_for_output_chunk([1, 3, 3], [1, 3, 3], &level, coords).expect("region");
        let source = &input[16..18];

        let bytes = downsample_region_to_generated_chunk(
            source,
            DataType::Uint16,
            region,
            [1, 1, 1],
            [1, 3, 3],
            [1, 3, 3],
            &level,
            coords,
            FillValue::parse(&serde_json::json!(7), DataType::Uint16).unwrap(),
        )
        .expect("pooled");
        let values: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes(*b))
            .collect();

        assert_eq!(values, vec![9, 7, 7, 7]);
    }

    /// Generated samples are source samples: negative and out-of-[0, 1]
    /// floats keep their values, an all-negative cell stays negative, and NaN
    /// shows only where every source sample is NaN.
    #[test]
    fn generated_float32_chunk_keeps_source_values() {
        let nan = f32::NAN;
        #[rustfmt::skip]
        let input: [f32; 16] = [
            -7.0, -3.0,   500.25, 2.0,
            -9.0, -1.5,   -5.0,   1.0,
            nan,  4.0,    nan,    nan,
            nan,  nan,    nan,    nan,
        ];
        let bytes: Vec<u8> = input.iter().flat_map(|v| v.to_le_bytes()).collect();

        let pooled = pool_whole(&bytes, DataType::Float32, [1, 4, 4], [1, 2, 2]);
        let output: Vec<f32> = pooled
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();

        assert_eq!(&output[..3], &[-1.5, 500.25, 4.0]);
        assert!(output[3].is_nan());
    }

    #[test]
    fn generated_signed_and_wide_chunks_keep_source_values() {
        let int16: Vec<u8> = [-32768_i16, -2, -30000, -1]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&int16, DataType::Int16, [1, 2, 2], [1, 1, 1]);
        assert_eq!(i16::from_le_bytes([pooled[0], pooled[1]]), -1);

        let float64: Vec<u8> = [1.0e300_f64, -2.5, 3.0, 0.0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&float64, DataType::Float64, [1, 2, 2], [1, 1, 1]);
        assert_eq!(f64::from_le_bytes(pooled.try_into().unwrap()), 1.0e300);

        let uint32: Vec<u8> = [70_000_u32, 4_000_000_000, 1, 2]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&uint32, DataType::Uint32, [1, 2, 2], [1, 1, 1]);
        assert_eq!(
            u32::from_le_bytes(pooled.try_into().unwrap()),
            4_000_000_000
        );

        let int64: Vec<u8> = [i64::MIN, -(1_i64 << 60), -3, -(1_i64 << 62)]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&int64, DataType::Int64, [1, 2, 2], [1, 1, 1]);
        assert_eq!(i64::from_le_bytes(pooled.try_into().unwrap()), -3);

        let uint64: Vec<u8> = [u64::MAX - 1, 1, (1_u64 << 63) + 1, 0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&uint64, DataType::Uint64, [1, 2, 2], [1, 1, 1]);
        assert_eq!(u64::from_le_bytes(pooled.try_into().unwrap()), u64::MAX - 1);
    }

    /// A level's histogram counts 64-bit integers and halves in their own
    /// units, as the values they hold.
    #[test]
    fn generated_histograms_count_wide_and_half_samples_as_their_values() {
        let whole = VolumeRegion {
            z0: 0,
            z1: 1,
            y0: 0,
            y1: 2,
            x0: 0,
            x1: 2,
        };
        let int64 = [-6_000_000_000_i64, 3, 1 << 40, -1];
        let bytes: Vec<u8> = int64.iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(
            region_histogram(&bytes, DataType::Int64, whole, [1, 2, 2], whole).unwrap(),
            SampleHistogram::of(int64.map(|v| v as f64)),
        );
        let uint64 = [u64::MAX, 0, 1 << 63, 7];
        let bytes: Vec<u8> = uint64.iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(
            region_histogram(&bytes, DataType::Uint64, whole, [1, 2, 2], whole).unwrap(),
            SampleHistogram::of(uint64.map(|v| v as f64)),
        );
        // -2.0, 0.5, NaN (left out), 65504.
        let halves: Vec<u8> = [0xc000_u16, 0x3800, 0x7e00, 0x7bff]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        assert_eq!(
            region_histogram(&halves, DataType::Float16, whole, [1, 2, 2], whole).unwrap(),
            SampleHistogram::of([-2.0, 0.5, 65504.0]),
        );
    }

    /// Halves pool by value, not by bits: a negative half's bits are larger
    /// than any positive one's, and NaN loses to any number.
    #[test]
    fn generated_float16_chunk_pools_by_value() {
        // -2.0, 0.5, NaN, a subnormal.
        let halves: Vec<u8> = [0xc000_u16, 0x3800, 0x7e00, 0x0001]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&halves, DataType::Float16, [1, 2, 2], [1, 1, 1]);
        assert_eq!(u16::from_le_bytes(pooled.try_into().unwrap()), 0x3800);

        let negatives: Vec<u8> = [0xc000_u16, 0xbc00, 0x8001, 0xfc00]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&negatives, DataType::Float16, [1, 2, 2], [1, 1, 1]);
        assert_eq!(u16::from_le_bytes(pooled.try_into().unwrap()), 0x8001);

        let all_nan: Vec<u8> = [0x7e00_u16; 4]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let pooled = pool_whole(&all_nan, DataType::Float16, [1, 2, 2], [1, 1, 1]);
        assert_eq!(u16::from_le_bytes(pooled.try_into().unwrap()), 0x7e00);
    }

    #[test]
    fn on_disk_ready_chunk_reuses_across_cache_instances() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [7; 16]);
        cache
            .put_ready_chunk_atomic(
                "identity",
                ImageId("img-1".into()),
                1,
                "1/0/0/0/0/0".into(),
                vec![1, 2, 3, 4],
            )
            .unwrap();

        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [7; 16]);
        let adopt = || {
            reopened
                .load_ready_chunk("identity", ImageId("img-1".into()), 1, "1/0/0/0/0/0".into())
                .unwrap()
        };
        // Generating it is the only way to count its samples until its
        // timepoint and channel has a histogram.
        assert!(!adopt());
        reopened.apply_delta(GeneratedAvailabilityDelta {
            histograms: vec![GeneratedLevelHistogram {
                image_id: ImageId("img-1".into()),
                level_index: 1,
                t: 0,
                c: 0,
                bins: vec![],
            }],
            ..Default::default()
        });
        assert!(adopt());
        match reopened.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => assert_eq!(bytes, vec![1, 2, 3, 4]),
            DerivedChunkLookup::Status { status, .. } => panic!("expected ready, got {status:?}"),
        }

        let chunk_dir = dir.path().join(hex16(&[7; 16])).join("identity").join("L1");
        let leftovers: Vec<_> = fs::read_dir(chunk_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn register_generated_plan_recovers_ready_chunks_from_readiness_index() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [9; 16]);
        cache.register_generated_plan(&plan).unwrap();
        let bytes = vec![1_u8; expected_generated_chunk_bytes(&plan) as usize];
        cache
            .put_ready_chunk_atomic(
                &plan.cache_identity,
                plan.image_id.clone(),
                plan.level_index,
                "1/0/0/0/0/0".into(),
                bytes.clone(),
            )
            .unwrap();
        cache.set_chunk_status(
            plan.image_id.clone(),
            plan.level_index,
            "1/0/0/0/0/0".into(),
            GeneratedChunkStatus::Ready,
            None,
        );
        let histogram = complete_histogram(&cache, &plan, 0, 0);

        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [9; 16]);
        let delta = reopened.register_generated_plan(&plan).unwrap();

        assert_eq!(delta.histograms, vec![histogram]);
        assert_eq!(delta.chunks.len(), 1);
        assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
        match reopened.lookup(&plan.image_id, plan.level_index, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(recovered) => assert_eq!(recovered, bytes),
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected recovered bytes, got {status:?}: {message:?}");
            }
        }
    }

    #[test]
    fn register_generated_plan_scans_when_readiness_index_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [10; 16]);
        cache.register_generated_plan(&plan).unwrap();
        let bytes = vec![0_u8; expected_generated_chunk_bytes(&plan) as usize];
        cache
            .put_ready_chunk_atomic(
                &plan.cache_identity,
                plan.image_id.clone(),
                plan.level_index,
                "1/0/0/0/0/0".into(),
                bytes,
            )
            .unwrap();
        complete_histogram(&cache, &plan, 0, 0);
        let _ = fs::remove_file(
            cache
                .disk
                .as_ref()
                .unwrap()
                .index_path(&plan.cache_identity),
        );

        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [10; 16]);
        let delta = reopened.register_generated_plan(&plan).unwrap();

        assert_eq!(delta.chunks.len(), 1);
        assert_eq!(delta.chunks[0].key, "1/0/0/0/0/0");
        assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
    }

    #[test]
    fn corrupted_generated_chunk_is_not_recovered_as_ready() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [11; 16]);
        cache.register_generated_plan(&plan).unwrap();
        let path = cache.disk.as_ref().unwrap().chunk_path(
            &plan.cache_identity,
            plan.level_index,
            "1/0/0/0/0/0",
        );
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, [1_u8]).unwrap();

        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [11; 16]);
        let delta = reopened.register_generated_plan(&plan).unwrap();

        assert!(delta.chunks.is_empty());
    }

    #[test]
    fn disk_budget_eviction_withdraws_missing_ready_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");
        let cache =
            DerivedChunkCache::new_on_disk_with_budget(dir.path().to_path_buf(), [12; 16], Some(1));
        cache.register_generated_plan(&plan).unwrap();
        let delta = cache
            .put_ready_chunk_atomic(
                &plan.cache_identity,
                plan.image_id.clone(),
                plan.level_index,
                "1/0/0/0/0/0".into(),
                vec![1, 2, 3, 4],
            )
            .unwrap();

        let telemetry = cache.telemetry();
        assert!(telemetry.evictions > 0);
        assert!(telemetry.bytes <= 1);

        assert_eq!(delta.chunks.len(), 1);
        assert_eq!(delta.chunks[0].key, "1/0/0/0/0/0");
        assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Unavailable);
        assert_eq!(
            delta.chunks[0].message.as_deref(),
            Some("generated chunk was evicted from derived cache")
        );
    }

    #[tokio::test]
    async fn generated_coarse_materializes_from_fake_source_without_mutating_source() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use tokio::sync::broadcast;

        let source_level = level(0, [1, 1, 1, 4, 4], [1, 1, 1, 4, 4]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 2,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let seed = binding_seed_for(&[source_level]);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let source_path = source_path(&resolver, "0/0/0/0/0/0");
        let mut source_bytes = Vec::new();
        for value in 0_u16..16 {
            source_bytes.extend_from_slice(&value.to_le_bytes());
        }
        store
            .put(&source_path, PutPayload::from(source_bytes.clone()))
            .await
            .unwrap();

        let cache = Arc::new(DerivedChunkCache::new_on_disk(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            [8; 16],
        ));
        cache.upsert_level(plan.availability.clone());
        let session = Arc::new(AsyncMutex::new(Session::new()));
        let (tx, _rx) = broadcast::channel(16);

        materialize_generated_coarse_plan(
            plan.clone(),
            Arc::new(manifest),
            Arc::new(CachedStore::new(store.clone(), 1024 * 1024)),
            resolver,
            cache.clone(),
            session,
            tx,
        )
        .await;

        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => {
                let values: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .copied()
                    .map(u16::from_le_bytes)
                    .collect();
                assert_eq!(values, vec![5, 7, 13, 15]);
            }
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected generated bytes, got {status:?}: {message:?}");
            }
        }
        let after = store
            .get(&source_path)
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(&after[..], &source_bytes[..]);
    }

    #[tokio::test]
    async fn generated_coarse_materializes_one_chunk_without_fetching_full_source() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use tokio::sync::broadcast;

        let source_level = level(0, [1, 1, 1, 4, 4], [1, 1, 1, 2, 2]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 4,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let seed = binding_seed_for(&[source_level]);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let source_path = source_path(&resolver, "0/0/0/0/0/0");
        let mut source_bytes = Vec::new();
        for value in [10_u16, 20, 30, 40] {
            source_bytes.extend_from_slice(&value.to_le_bytes());
        }
        store
            .put(&source_path, PutPayload::from(source_bytes))
            .await
            .unwrap();

        let cache = Arc::new(DerivedChunkCache::new_on_disk(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            [9; 16],
        ));
        cache.upsert_level(plan.availability.clone());
        let session = Arc::new(AsyncMutex::new(Session::new()));
        let (tx, _rx) = broadcast::channel(16);
        let manifest = Arc::new(manifest);
        let cached = Arc::new(CachedStore::new(store, 1024 * 1024));

        let result = materialize_generated_coarse_key(
            &plan,
            parse_generated_chunk_key("1/0/0/0/0/0").unwrap(),
            manifest.clone(),
            cached.clone(),
            resolver.clone(),
            cache.clone(),
            session.clone(),
            tx.clone(),
            || async { false },
        )
        .await;
        assert_eq!(result, MaterializeOneResult::Ready);

        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => {
                let values: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .copied()
                    .map(u16::from_le_bytes)
                    .collect();
                assert_eq!(values, vec![10, 20, 30, 40]);
            }
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected generated bytes, got {status:?}: {message:?}");
            }
        }
    }

    fn chunk(n: u64) -> String {
        chunk_key(1, 0, 0, 0, 0, n)
    }

    #[test]
    fn generated_bytes_share_one_budget_and_evict_the_coldest() {
        let memory = GeneratedChunkMemory::new(10);
        let first = DerivedChunkCache::default().with_memory(memory.clone());
        let second = DerivedChunkCache::default().with_memory(memory.clone());
        let image = ImageId("img-1".into());
        for cache in [&first, &second] {
            cache.upsert_level(generated_level());
        }

        first.seed_ready_chunk(image.clone(), 1, chunk(0), vec![1; 4]);
        first.seed_ready_chunk(image.clone(), 1, chunk(1), vec![2; 4]);
        // Touch chunk 0 so chunk 1 is the coldest across both caches.
        assert!(matches!(
            first.lookup(&image, 1, &chunk(0)),
            DerivedChunkLookup::Ready(_)
        ));
        second.seed_ready_chunk(image.clone(), 1, chunk(0), vec![3; 4]);

        assert!(memory.current_bytes() <= 10);
        assert!(matches!(
            first.lookup(&image, 1, &chunk(0)),
            DerivedChunkLookup::Ready(_)
        ));
        assert!(matches!(
            second.lookup(&image, 1, &chunk(0)),
            DerivedChunkLookup::Ready(bytes) if bytes == vec![3; 4]
        ));
        assert_eq!(first.telemetry().evictions, 1);
        assert_eq!(first.telemetry().budget_bytes, Some(10));

        // Without a disk copy, an evicted chunk is generated again, and says
        // so instead of claiming to be ready with nothing to send.
        assert!(first.needs_regeneration(&image, 1, &chunk(1)));
        match first.lookup(&image, 1, &chunk(1)) {
            DerivedChunkLookup::Status { status, .. } => {
                assert_eq!(status, GeneratedChunkStatus::Pending)
            }
            DerivedChunkLookup::Ready(_) => panic!("evicted bytes were served"),
        }

        drop(first);
        assert_eq!(memory.current_bytes(), 4, "a dropped cache frees its bytes");
    }

    #[test]
    fn an_evicted_generated_chunk_is_read_back_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let memory = GeneratedChunkMemory::new(4);
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [3; 16])
            .with_memory(memory.clone());
        let image = ImageId("img-1".into());
        cache
            .put_ready_chunk_atomic("identity", image.clone(), 1, chunk(0), vec![1, 2, 3, 4])
            .unwrap();
        cache
            .put_ready_chunk_atomic("identity", image.clone(), 1, chunk(1), vec![5, 6, 7, 8])
            .unwrap();
        assert_eq!(memory.current_bytes(), 4);

        assert!(!cache.needs_regeneration(&image, 1, &chunk(0)));
        match cache.lookup(&image, 1, &chunk(0)) {
            DerivedChunkLookup::Ready(bytes) => assert_eq!(bytes, vec![1, 2, 3, 4]),
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected the disk copy, got {status:?}: {message:?}")
            }
        }
        assert_eq!(memory.current_bytes(), 4, "reading back stays in budget");
    }

    #[tokio::test]
    async fn a_request_for_an_evicted_chunk_with_no_disk_copy_queues_it_again() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let cache =
            Arc::new(DerivedChunkCache::default().with_memory(GeneratedChunkMemory::new(4)));
        cache.upsert_level(plan.availability.clone());
        let service = service_with_cache(
            manifest,
            plan.clone(),
            GeneratedSchedulingConfig::default(),
            cache.clone(),
        );
        let key = chunk_key(plan.level_index, 0, 0, 0, 0, 0);
        let work_key = GeneratedWorkKey {
            dataset_id: plan.dataset_id.clone(),
            image_id: plan.image_id.clone(),
            level_index: plan.level_index,
            key: key.clone(),
        };
        service
            .inner
            .state
            .lock()
            .await
            .completed_keys
            .insert(work_key);
        cache.seed_ready_chunk(
            plan.image_id.clone(),
            plan.level_index,
            key.clone(),
            vec![1; 4],
        );
        cache.seed_ready_chunk(
            plan.image_id.clone(),
            plan.level_index,
            chunk_key(plan.level_index, 0, 0, 0, 0, 1),
            vec![2; 4],
        );

        service
            .enqueue_chunk_request(1, &plan.image_id, plan.level_index, &key)
            .await;

        assert_eq!(service.telemetry().await.queued_requested, 1);
    }

    /// Two datasets over one source: the second workspace to open a source
    /// gets a dataset id of its own, and its image ids carry it.
    fn manifest_as_dataset(dataset: &str) -> DatasetManifest {
        let manifest = source_manifest();
        let mut image = manifest.images()[0].clone();
        image.image_id = ImageId(format!("{dataset}:image:0"));
        DatasetManifest::new(
            DatasetId(dataset.into()),
            manifest.name.clone(),
            manifest.kind.clone(),
            manifest.entities().to_vec(),
            vec![],
            vec![image],
            vec![],
            None,
        )
    }

    #[test]
    fn a_second_dataset_over_one_source_reuses_the_generated_level_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let first_plan = plan_generated_coarse_for_manifest(
            &manifest_as_dataset("ds-first"),
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .unwrap();
        let second_plan = plan_generated_coarse_for_manifest(
            &manifest_as_dataset("ds-second"),
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .unwrap();
        assert_ne!(first_plan.image_id, second_plan.image_id);
        assert_eq!(first_plan.cache_identity, second_plan.cache_identity);

        let first = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [13; 16]);
        first.register_generated_plan(&first_plan).unwrap();
        let bytes = vec![9_u8; expected_generated_chunk_bytes(&first_plan) as usize];
        let key = chunk_key(first_plan.level_index, 0, 0, 0, 0, 0);
        first
            .put_ready_chunk_atomic(
                &first_plan.cache_identity,
                first_plan.image_id.clone(),
                first_plan.level_index,
                key.clone(),
                bytes.clone(),
            )
            .unwrap();
        let histogram = complete_histogram(&first, &first_plan, 0, 0);
        // A failure recorded by the first dataset, carried in its index.
        first.set_chunk_status(
            first_plan.image_id.clone(),
            first_plan.level_index,
            chunk_key(first_plan.level_index, 0, 0, 0, 0, 1),
            GeneratedChunkStatus::FailedPermanent,
            None,
        );
        first.persist_readiness_indexes();

        let second = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [13; 16]);
        let delta = second.register_generated_plan(&second_plan).unwrap();

        assert_eq!(delta.chunks.len(), 2);
        assert!(
            delta
                .chunks
                .iter()
                .all(|chunk| chunk.image_id == second_plan.image_id)
        );
        assert_eq!(
            delta.histograms,
            vec![GeneratedLevelHistogram {
                image_id: second_plan.image_id.clone(),
                ..histogram
            }]
        );
        match second.lookup(&second_plan.image_id, second_plan.level_index, &key) {
            DerivedChunkLookup::Ready(recovered) => assert_eq!(recovered, bytes),
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected the first dataset's chunk, got {status:?}: {message:?}")
            }
        }
    }

    #[test]
    fn a_chunk_file_outranks_a_stale_status_in_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan_generated_coarse_for_manifest(
            &source_manifest(),
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .unwrap();
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [14; 16]);
        cache.register_generated_plan(&plan).unwrap();
        let key = chunk_key(plan.level_index, 0, 0, 0, 0, 0);
        cache.set_chunk_status(
            plan.image_id.clone(),
            plan.level_index,
            key.clone(),
            GeneratedChunkStatus::FailedTransient,
            None,
        );
        cache.persist_readiness_indexes();
        cache
            .put_ready_chunk_atomic(
                &plan.cache_identity,
                plan.image_id.clone(),
                plan.level_index,
                key.clone(),
                vec![0; expected_generated_chunk_bytes(&plan) as usize],
            )
            .unwrap();
        complete_histogram(&cache, &plan, 0, 0);

        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [14; 16]);
        let delta = reopened.register_generated_plan(&plan).unwrap();

        assert_eq!(delta.chunks.len(), 1);
        assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
    }

    #[test]
    fn storing_a_chunk_reads_nothing_about_the_chunks_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan_generated_coarse_for_manifest(
            &source_manifest(),
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .unwrap();
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [15; 16]);
        cache.register_generated_plan(&plan).unwrap();
        let put = |n: u64| {
            cache
                .put_ready_chunk_atomic(
                    &plan.cache_identity,
                    plan.image_id.clone(),
                    plan.level_index,
                    chunk_key(plan.level_index, 0, 0, 0, 0, n),
                    vec![0; 8],
                )
                .unwrap()
        };
        put(0);
        // Gone behind the cache's back. A put that checked every ready chunk
        // on disk would find this one missing and withdraw it, which made
        // each chunk slower than the last as a level filled.
        let disk = cache.disk.as_ref().unwrap();
        fs::remove_file(disk.chunk_path(
            &plan.cache_identity,
            plan.level_index,
            &chunk_key(plan.level_index, 0, 0, 0, 0, 0),
        ))
        .unwrap();

        assert!(put(1).chunks.is_empty());
        // A status change does not rewrite the level's index either.
        assert!(!disk.index_path(&plan.cache_identity).exists());
        cache.persist_readiness_indexes();
        assert!(disk.index_path(&plan.cache_identity).exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn background_fill_generates_every_chunk_a_few_at_a_time() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 256, 256], [1, 1, 1, 64, 64])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 256,
                chunk_long_axis: 64,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        assert_eq!(plan.availability.level.grid_shape, [1, 1, 1, 4, 4]);
        let service = service_for_plan(
            manifest,
            plan.clone(),
            GeneratedSchedulingConfig {
                background_chunk_limit: 3,
                ..GeneratedSchedulingConfig::default()
            },
        );

        service.enqueue_background_fill().await;
        assert_eq!(service.telemetry().await.queued_background, 3);
        service.start();
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while service.telemetry().await.completed < 16 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the whole level is generated");

        for key in plan.chunk_keys_for_all_tc() {
            assert!(
                service
                    .inner
                    .cache
                    .is_ready(&plan.image_id, plan.level_index, &key)
            );
        }
        let telemetry = service.telemetry().await;
        assert_eq!(telemetry.queued_background, 0);
        assert_eq!(telemetry.completed, 16);
    }

    /// Sixteen chunks of one level, filled in the background on `cache` until
    /// the fill stops. Answers how many it generated.
    async fn fill_until_stopped(
        cache: impl FnOnce(&GeneratedCoarsePlan) -> DerivedChunkCache,
    ) -> u64 {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 256, 256], [1, 1, 1, 64, 64])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 256,
                chunk_long_axis: 64,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let cache = Arc::new(cache(&plan));
        cache.register_generated_plan(&plan).unwrap();
        let service = service_with_cache(
            manifest,
            plan,
            GeneratedSchedulingConfig {
                background_chunk_limit: 1,
                ..GeneratedSchedulingConfig::default()
            },
            cache,
        );

        service.enqueue_background_fill().await;
        service.start();
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                let telemetry = service.telemetry().await;
                if telemetry.queued_background == 0 && telemetry.running == 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the fill stops");
        service.telemetry().await.completed
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn background_fill_covers_what_the_memory_budget_holds() {
        let completed = fill_until_stopped(|plan| {
            let three_chunks = 3 * expected_generated_chunk_bytes(plan);
            DerivedChunkCache::default().with_memory(GeneratedChunkMemory::new(three_chunks))
        })
        .await;
        assert_eq!(completed, 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn background_fill_stops_once_the_disk_cache_evicts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        // A budget smaller than one chunk: the first write evicts.
        let completed = fill_until_stopped(move |_| {
            DerivedChunkCache::new_on_disk_with_budget(root, [16; 16], Some(1))
        })
        .await;
        assert_eq!(completed, 1);
    }

    /// A two-channel level of 16 chunks per channel, on a disk cache whose
    /// memory budget holds three of them.
    fn two_channel_service(dir: &std::path::Path) -> (GeneratedCoarseService, GeneratedCoarsePlan) {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 2, 1, 256, 256], [1, 1, 1, 64, 64])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 256,
                chunk_long_axis: 64,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        assert_eq!(plan.chunk_keys_for_tc(0, 1).len(), 16);
        let cache = Arc::new(
            DerivedChunkCache::new_on_disk(dir.to_path_buf(), [17; 16]).with_memory(
                GeneratedChunkMemory::new(3 * expected_generated_chunk_bytes(&plan)),
            ),
        );
        cache.register_generated_plan(&plan).unwrap();
        let service = service_with_cache(
            manifest,
            plan.clone(),
            GeneratedSchedulingConfig {
                background_chunk_limit: 2,
                ..GeneratedSchedulingConfig::default()
            },
            cache,
        );
        (service, plan)
    }

    async fn until_idle(service: &GeneratedCoarseService) {
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                let telemetry = service.telemetry().await;
                if telemetry.queued_background == 0 && telemetry.running == 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the service goes idle");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn background_work_completes_the_channels_a_view_shows_past_the_byte_cap() {
        let dir = tempfile::tempdir().unwrap();
        let (service, plan) = two_channel_service(dir.path());
        service.enqueue_background_fill().await;
        service.start();
        until_idle(&service).await;
        assert_eq!(
            service.telemetry().await.completed,
            3,
            "the walk stops at the byte cap"
        );

        // A view of channel 1 wants a chunk of the source level, not the
        // generated one: it shows the channel all the same.
        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "0/0/1/0/0/0",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while !service
                .inner
                .cache
                .histogram_complete(&plan.image_id, plan.level_index, 0, 1)
            {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the shown channel's histogram completes");
        until_idle(&service).await;

        let cache = &service.inner.cache;
        for key in plan.chunk_keys_for_tc(0, 1) {
            assert!(cache.is_ready(&plan.image_id, plan.level_index, &key));
        }
        assert!(
            !cache.histogram_complete(&plan.image_id, plan.level_index, 0, 0),
            "no view shows channel 0"
        );
        assert_eq!(service.telemetry().await.completed, 3 + 16);
    }

    #[tokio::test]
    async fn what_a_view_shows_follows_the_clients_latest_hint_until_it_leaves() {
        let dir = tempfile::tempdir().unwrap();
        let (service, plan) = two_channel_service(dir.path());
        let shows = |channel: u32| {
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                &format!("0/0/{channel}/0/0/0"),
                ViewerInterestLane::Visible,
                current_unix_millis(),
            )
        };
        let tc = |channel: u32| (plan.image_id.clone(), plan.level_index, 0, channel);

        service.apply_viewer_interest(1, shows(1)).await;
        {
            let state = service.inner.state.lock().await;
            let shown: Vec<_> = state.shown.values().flatten().cloned().collect();
            assert_eq!(shown, vec![tc(1)]);
            assert_eq!(
                state.shown_cursor.get(&tc(1)),
                Some(&2),
                "two chunks queued"
            );
        }

        service.apply_viewer_interest(1, shows(0)).await;
        {
            let state = service.inner.state.lock().await;
            let shown: Vec<_> = state.shown.values().flatten().cloned().collect();
            assert_eq!(shown, vec![tc(0)]);
            assert!(!state.shown_cursor.contains_key(&tc(1)));
        }

        service.remove_client_interest(1).await;
        let state = service.inner.state.lock().await;
        assert!(state.shown.is_empty());
        assert!(state.shown_cursor.is_empty());
    }

    /// A level of 35 by 35 chunks generated one at a time onto a real disk
    /// cache, with each chunk's ready status published as the service does.
    async fn generate_level_timed(root: &std::path::Path) -> Vec<std::time::Duration> {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use tokio::sync::broadcast;

        let side = 35 * 64;
        let source_level = level(0, [1, 1, 1, side, side], [1, 1, 1, 64, 64]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: side,
                chunk_long_axis: 64,
                max_chunk_bytes: 64 * 64 * 2,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        assert_eq!(plan.availability.level.grid_shape, [1, 1, 1, 35, 35]);
        let seed = binding_seed_for(&[source_level]);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        for y in 0..35 {
            for x in 0..35 {
                let path = source_path(&resolver, &format!("0/0/0/0/{y}/{x}"));
                store
                    .put(&path, PutPayload::from(vec![7_u8; 64 * 64 * 2]))
                    .await
                    .unwrap();
            }
        }
        let cache = Arc::new(DerivedChunkCache::new_on_disk(root.to_path_buf(), [21; 16]));
        cache.register_generated_plan(&plan).unwrap();
        let session = Arc::new(AsyncMutex::new(Session::new()));
        let (tx, _rx) = broadcast::channel(16);
        let manifest = Arc::new(manifest);
        let cached = Arc::new(CachedStore::new(store, 64 * 1024 * 1024));

        let mut elapsed = Vec::new();
        for key in plan.chunk_keys_for_tc(0, 0) {
            let started = Instant::now();
            let result = materialize_generated_coarse_key(
                &plan,
                parse_generated_chunk_key(&key).unwrap(),
                manifest.clone(),
                cached.clone(),
                resolver.clone(),
                cache.clone(),
                session.clone(),
                tx.clone(),
                || async { false },
            )
            .await;
            assert_eq!(result, MaterializeOneResult::Ready);
            elapsed.push(started.elapsed());
        }
        elapsed
    }

    #[tokio::test]
    #[ignore = "a measurement, not a check: prints chunks per second as a level fills"]
    async fn generation_rate_across_one_level() {
        let dir = tempfile::tempdir().unwrap();
        let elapsed = generate_level_timed(dir.path()).await;
        for (window, times) in elapsed.chunks(175).enumerate() {
            let total: std::time::Duration = times.iter().sum();
            println!(
                "chunks {:>4}..{:>4}: {:>6.1} chunks/s",
                window * 175,
                window * 175 + times.len(),
                times.len() as f64 / total.as_secs_f64()
            );
        }
    }

    #[tokio::test]
    async fn generated_coarse_materializes_float32_source_chunks() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use tokio::sync::broadcast;

        let source_level = level(0, [1, 1, 1, 2, 2], [1, 1, 1, 2, 2]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Float32);
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 2,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let seed = binding_seed_for_data_type(&[source_level], DataType::Float32);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let source_path = source_path(&resolver, "0/0/0/0/0/0");
        let mut source_bytes = Vec::new();
        for value in [-0.5_f32, 0.5, 1.0, 750.0] {
            source_bytes.extend_from_slice(&value.to_le_bytes());
        }
        store
            .put(&source_path, PutPayload::from(source_bytes))
            .await
            .unwrap();

        let cache = Arc::new(DerivedChunkCache::new_on_disk(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            [10; 16],
        ));
        cache.upsert_level(plan.availability.clone());
        let session = Arc::new(AsyncMutex::new(Session::new()));
        let (tx, _rx) = broadcast::channel(16);
        let coords = parse_generated_chunk_key("1/0/0/0/0/0").unwrap();

        let result = materialize_generated_coarse_key(
            &plan,
            coords,
            Arc::new(manifest),
            Arc::new(CachedStore::new(store, 1024 * 1024)),
            resolver,
            cache.clone(),
            session,
            tx,
            || async { false },
        )
        .await;

        assert_eq!(result, MaterializeOneResult::Ready);
        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => {
                let values: Vec<f32> = bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .copied()
                    .map(f32::from_le_bytes)
                    .collect();
                assert_eq!(values, vec![-0.5, 0.5, 1.0, 750.0]);
            }
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected generated bytes, got {status:?}: {message:?}");
            }
        }
    }

    #[tokio::test]
    async fn generated_coarse_reads_missing_source_chunks_as_the_fill_value() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use tokio::sync::broadcast;

        let source_level = level(0, [1, 1, 1, 2, 2], [1, 1, 1, 1, 1]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
        let fill = FillValue::parse(&serde_json::json!(5), DataType::Uint16).unwrap();
        let seed = binding_seed_with_fill(&[source_level], DataType::Uint16, fill);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &resolver,
            GeneratedCoarseConfig {
                target_long_axis: 2,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let source_path = source_path(&resolver, "0/0/0/0/0/1");
        store
            .put(&source_path, PutPayload::from(7_u16.to_le_bytes().to_vec()))
            .await
            .unwrap();

        let cache = Arc::new(DerivedChunkCache::new_on_disk(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            [11; 16],
        ));
        cache.upsert_level(plan.availability.clone());
        let session = Arc::new(AsyncMutex::new(Session::new()));
        let (tx, _rx) = broadcast::channel(16);
        let coords = parse_generated_chunk_key("1/0/0/0/0/0").unwrap();

        let result = materialize_generated_coarse_key(
            &plan,
            coords,
            Arc::new(manifest),
            Arc::new(CachedStore::new(store, 1024 * 1024)),
            resolver,
            cache.clone(),
            session,
            tx,
            || async { false },
        )
        .await;

        assert_eq!(result, MaterializeOneResult::Ready);
        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => {
                let values: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .copied()
                    .map(u16::from_le_bytes)
                    .collect();
                assert_eq!(values, vec![5]);
            }
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected generated bytes, got {status:?}: {message:?}");
            }
        }
    }

    /// One source sample of 7 among three unwritten ones, pooled to one
    /// sample, opened three times over one disk cache: under a fill value of
    /// 5, then 9, then 9 again.
    #[tokio::test]
    async fn a_changed_fill_value_regenerates_the_level() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;

        let source_level = level(0, [1, 1, 1, 2, 2], [1, 1, 1, 1, 1]);
        let manifest = Arc::new(source_manifest_with_levels(
            vec![source_level.clone()],
            None,
            DataType::Uint16,
        ));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let dir = tempfile::tempdir().unwrap();
        let mut identities = Vec::new();
        let mut recovered = Vec::new();
        let mut pooled = Vec::new();
        for fill in [5, 9, 9] {
            let fill = FillValue::parse(&serde_json::json!(fill), DataType::Uint16).unwrap();
            let resolver = Arc::new(ChunkResolver::new(&binding_seed_with_fill(
                std::slice::from_ref(&source_level),
                DataType::Uint16,
                fill,
            )));
            store
                .put(
                    &source_path(&resolver, "0/0/0/0/0/1"),
                    PutPayload::from(7_u16.to_le_bytes().to_vec()),
                )
                .await
                .unwrap();
            let plan = plan_generated_coarse_for_manifest(
                &manifest,
                &resolver,
                GeneratedCoarseConfig {
                    target_long_axis: 1,
                    chunk_long_axis: 1,
                    max_chunk_bytes: 64,
                    min_chunk_axis: 1,
                },
            )
            .pop()
            .expect("plan");
            identities.push(plan.cache_identity.clone());
            let cache = Arc::new(DerivedChunkCache::new_on_disk(
                dir.path().to_path_buf(),
                [12; 16],
            ));
            recovered.push(cache.register_generated_plan(&plan).unwrap().chunks.len());
            let (tx, _rx) = broadcast::channel(16);
            materialize_generated_coarse_plan(
                plan.clone(),
                manifest.clone(),
                Arc::new(CachedStore::new(store.clone(), 1024 * 1024)),
                resolver,
                cache.clone(),
                Arc::new(AsyncMutex::new(Session::new())),
                tx,
            )
            .await;
            match cache.lookup(&plan.image_id, plan.level_index, "1/0/0/0/0/0") {
                DerivedChunkLookup::Ready(bytes) => {
                    pooled.push(u16::from_le_bytes([bytes[0], bytes[1]]));
                }
                DerivedChunkLookup::Status { status, message } => {
                    panic!("expected generated bytes, got {status:?}: {message:?}");
                }
            }
        }

        assert_ne!(identities[0], identities[1]);
        assert_eq!(identities[1], identities[2]);
        assert_eq!(recovered, vec![0, 0, 1], "only the same fill value reuses");
        assert_eq!(pooled, vec![7, 9, 9]);
    }

    /// Every availability delta sent on `rx` so far.
    fn sent_deltas(rx: &mut broadcast::Receiver<BroadcastItem>) -> Vec<GeneratedAvailabilityDelta> {
        let mut out = Vec::new();
        while let Ok(item) = rx.try_recv() {
            if let BroadcastItem::GeneratedAvailabilityUpdate { json } = item
                && let Ok(ServerMessage::GeneratedAvailabilityUpdate { delta, .. }) =
                    serde_json::from_str(&json)
            {
                out.push(delta);
            }
        }
        out
    }

    /// A 5 × 5 source in 2 × 2 chunks pooled to 2 × 2, so pooling windows
    /// straddle chunk edges, with the chunk at row 0, column 1 never
    /// written. Sample `(y, x)` reads `100 + 10y + x` and the fill is 9.
    async fn five_by_five_source() -> (
        DatasetManifest,
        GeneratedCoarsePlan,
        Arc<CachedStore>,
        Arc<ChunkResolver>,
        Vec<f64>,
    ) {
        use object_store::PutPayload;
        use object_store::memory::InMemory;

        let source_level = level(0, [1, 1, 1, 5, 5], [1, 1, 1, 2, 2]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 2,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        assert_eq!(plan.chunk_keys_for_tc(0, 0).len(), 4);
        let fill = FillValue::parse(&serde_json::json!(9), DataType::Uint16).unwrap();
        let resolver = Arc::new(ChunkResolver::new(&binding_seed_with_fill(
            &[source_level],
            DataType::Uint16,
            fill,
        )));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let sample = |y: u64, x: u64| 100 + 10 * y as u16 + x as u16;
        let mut expected = Vec::new();
        for y in 0..5 {
            for x in 0..5 {
                let written = (y / 2, x / 2) != (0, 1);
                expected.push(f64::from(if written { sample(y, x) } else { 9 }));
            }
        }
        for gy in 0..3_u64 {
            for gx in 0..3_u64 {
                if (gy, gx) == (0, 1) {
                    continue;
                }
                // An edge chunk is stored at full size, padded past the level.
                let bytes: Vec<u8> = (0..4)
                    .flat_map(|i| sample(gy * 2 + i / 2, gx * 2 + i % 2).to_le_bytes())
                    .collect();
                store
                    .put(
                        &source_path(&resolver, &format!("0/0/0/0/{gy}/{gx}")),
                        PutPayload::from(bytes),
                    )
                    .await
                    .unwrap();
            }
        }
        (
            manifest,
            plan,
            Arc::new(CachedStore::new(store, 1024 * 1024)),
            resolver,
            expected,
        )
    }

    #[tokio::test]
    async fn a_generated_level_counts_each_source_sample_once_and_sends_its_histogram_with_its_last_chunk()
     {
        let (manifest, plan, store, resolver, expected) = five_by_five_source().await;
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(DerivedChunkCache::new_on_disk(
            dir.path().to_path_buf(),
            [21; 16],
        ));
        cache.register_generated_plan(&plan).unwrap();
        let session = Arc::new(AsyncMutex::new(Session::new()));
        let (tx, mut rx) = broadcast::channel(64);
        let manifest = Arc::new(manifest);

        materialize_generated_coarse_plan(
            plan.clone(),
            manifest.clone(),
            store.clone(),
            resolver.clone(),
            cache.clone(),
            session.clone(),
            tx.clone(),
        )
        .await;

        let deltas = sent_deltas(&mut rx);
        let with_histogram: Vec<_> = deltas.iter().filter(|d| !d.histograms.is_empty()).collect();
        assert_eq!(
            with_histogram.len(),
            1,
            "one histogram per timepoint and channel"
        );
        let last = deltas.last().unwrap();
        assert_eq!(last.chunks.len(), 1);
        assert_eq!(last.chunks[0].status, GeneratedChunkStatus::Ready);
        let histogram = &last.histograms[0];
        assert_eq!((histogram.t, histogram.c), (0, 0));
        assert_eq!(histogram.image_id, plan.image_id);
        assert_eq!(histogram.bins, SampleHistogram::of(expected).wire_bins());
        assert_eq!(histogram.bins.iter().map(|b| b.2).sum::<u64>(), 25);
        assert_eq!(
            session.lock().await.generated_availability[&plan.dataset_id].histograms,
            vec![histogram.clone()]
        );

        // Generating a chunk again counts nothing twice and sends nothing new.
        let coords = parse_generated_chunk_key(&plan.chunk_keys_for_tc(0, 0)[0]).unwrap();
        let fresh = Arc::new(DerivedChunkCache::default());
        fresh.upsert_level(plan.availability.clone());
        for _ in 0..2 {
            materialize_generated_coarse_key(
                &plan,
                coords,
                manifest.clone(),
                store.clone(),
                resolver.clone(),
                fresh.clone(),
                session.clone(),
                tx.clone(),
                || async { false },
            )
            .await;
        }
        assert!(sent_deltas(&mut rx).iter().all(|d| d.histograms.is_empty()));

        // A later open finds the histogram with the chunks it describes.
        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [21; 16]);
        let delta = reopened.register_generated_plan(&plan).unwrap();
        assert_eq!(delta.histograms, vec![histogram.clone()]);
        assert_eq!(delta.chunks.len(), 4);

        // Without it, the chunks are generated again to count their samples.
        let hist_path = cache.disk.as_ref().unwrap().histogram_path(
            &plan.cache_identity,
            plan.level_index,
            0,
            0,
        );
        fs::remove_file(hist_path).unwrap();
        let bare = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [21; 16]);
        let delta = bare.register_generated_plan(&plan).unwrap();
        assert!(delta.histograms.is_empty());
        assert!(delta.chunks.is_empty());
        assert!(
            !bare
                .load_ready_chunk(
                    &plan.cache_identity,
                    plan.image_id.clone(),
                    plan.level_index,
                    plan.chunk_keys_for_tc(0, 0)[0].clone(),
                )
                .unwrap()
        );
    }

    #[tokio::test]
    async fn viewer_interest_dedupes_duplicate_chunks_to_highest_lane() {
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");
        let key = "1/0/0/0/0/0";
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    key,
                    ViewerInterestLane::Predicted,
                    current_unix_millis(),
                ),
            )
            .await;
        service
            .apply_viewer_interest(
                2,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    key,
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;

        let item = service.pop_next_work_item().await.expect("work");
        assert_eq!(item.lane, GeneratedSchedulingLane::Visible);
        assert_eq!(item.work_key.key, key);
        assert!(service.telemetry().await.deduped > 0);
    }

    #[tokio::test]
    async fn latest_client_interest_replaces_stale_queued_work() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/0/0",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;
        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/0/1",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;

        let telemetry = service.telemetry().await;
        assert_eq!(telemetry.queued_visible, 1);
        assert_eq!(telemetry.canceled, 1);
        let item = service.pop_next_work_item().await.expect("work");
        assert_eq!(item.work_key.key, "1/0/0/0/0/1");
    }

    #[tokio::test]
    async fn expired_viewer_interest_drops_queued_jobs() {
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        )
        .pop()
        .expect("plan");
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());
        let mut hint = interest(
            plan.dataset_id.clone(),
            plan.image_id.clone(),
            "1/0/0/0/0/0",
            ViewerInterestLane::Visible,
            current_unix_millis().saturating_sub(60_000),
        );
        hint.ttl_ms = 1;

        service.apply_viewer_interest(1, hint).await;

        let telemetry = service.telemetry().await;
        assert_eq!(telemetry.queued_visible, 0);
        assert_eq!(telemetry.canceled, 1);
    }

    /// A plan with four generated chunks, `1/0/0/0/{0,1}/{0,1}`.
    fn four_chunk_plan() -> (DatasetManifest, GeneratedCoarsePlan) {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        (manifest, plan)
    }

    #[tokio::test]
    async fn chunk_request_outlives_an_expired_hint() {
        let (manifest, plan) = four_chunk_plan();
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service
            .enqueue_chunk_request(1, &plan.image_id, plan.level_index, "1/0/0/0/0/0")
            .await;
        // An expired hint from the same client prunes everything no live
        // interest names.
        let mut hint = interest(
            plan.dataset_id.clone(),
            plan.image_id.clone(),
            "1/0/0/0/0/1",
            ViewerInterestLane::Visible,
            current_unix_millis().saturating_sub(60_000),
        );
        hint.ttl_ms = 1;
        service.apply_viewer_interest(1, hint).await;

        assert_eq!(service.telemetry().await.queued_requested, 1);
        let running = service.pop_next_work_item().await.expect("work");
        assert_eq!(running.lane, GeneratedSchedulingLane::Requested);
        assert_eq!(running.work_key.key, "1/0/0/0/0/0");
        assert!(!service.should_cancel(&running).await);
    }

    #[tokio::test]
    async fn disconnect_drops_requested_work() {
        let (manifest, plan) = four_chunk_plan();
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        for client in [1, 2] {
            service
                .enqueue_chunk_request(client, &plan.image_id, plan.level_index, "1/0/0/0/0/0")
                .await;
        }
        service.remove_client_interest(1).await;
        assert_eq!(service.telemetry().await.queued_requested, 1);

        service.remove_client_interest(2).await;
        let telemetry = service.telemetry().await;
        assert_eq!(telemetry.queued_requested, 0);
        assert_eq!(telemetry.canceled, 1);
    }

    #[tokio::test]
    async fn hinted_visible_work_runs_before_requested_work() {
        let (manifest, plan) = four_chunk_plan();
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service.enqueue_background_fill().await;
        service
            .enqueue_chunk_request(1, &plan.image_id, plan.level_index, "1/0/0/0/0/0")
            .await;
        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/1/1",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;

        let first = service.pop_next_work_item().await.expect("work");
        assert_eq!(first.work_key.key, "1/0/0/0/1/1");
        let second = service.pop_next_work_item().await.expect("work");
        assert_eq!(second.lane, GeneratedSchedulingLane::Requested);
        assert_eq!(second.work_key.key, "1/0/0/0/0/0");
    }

    #[tokio::test]
    async fn visible_work_yields_background_fill() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service.enqueue_background_fill().await;
        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/0/1",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;

        let item = service.pop_next_work_item().await.expect("work");
        assert_eq!(item.lane, GeneratedSchedulingLane::Visible);
        assert_eq!(item.work_key.key, "1/0/0/0/0/1");
    }

    #[tokio::test]
    async fn running_work_observes_cancellation_after_reprioritization() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/0/0",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;
        let running = service.pop_next_work_item().await.expect("running");
        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/0/1",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;

        assert!(service.should_cancel(&running).await);
    }

    #[tokio::test]
    async fn shutdown_cancels_queued_work_and_rejects_new_interest() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
                min_chunk_axis: 1,
            },
        )
        .pop()
        .expect("plan");
        let service =
            service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

        service.enqueue_background_fill().await;
        assert!(service.telemetry().await.queued_background > 0);

        let telemetry = service.shutdown("test").await;
        assert!(service.is_shutdown().await);
        assert_eq!(telemetry.queued_background, 0);
        assert!(telemetry.canceled > 0);
        assert!(service.pop_next_work_item().await.is_none());

        service
            .apply_viewer_interest(
                1,
                interest(
                    plan.dataset_id.clone(),
                    plan.image_id.clone(),
                    "1/0/0/0/0/0",
                    ViewerInterestLane::Visible,
                    current_unix_millis(),
                ),
            )
            .await;
        assert_eq!(service.telemetry().await.queued_visible, 0);
    }

    #[test]
    fn generated_source_failures_are_classified_for_retry() {
        let transient = RegionReadError::Fetch {
            image: ImageId("img-1".into()),
            key: "0/0/0/0/0/0".into(),
            message: "temporary object-store failure".into(),
        };
        let permanent = RegionReadError::ShortChunk {
            image: ImageId("img-1".into()),
            key: "0/0/0/0/0/0".into(),
            got: 1,
            expected: 4,
        };

        assert_eq!(
            generated_status_for_source_error(&transient),
            GeneratedChunkStatus::FailedTransient
        );
        assert_eq!(
            generated_status_for_source_error(&permanent),
            GeneratedChunkStatus::FailedPermanent
        );
    }

    #[test]
    fn explicit_statuses_are_returned() {
        let cache = DerivedChunkCache::default();
        cache.upsert_level(generated_level());
        for status in [
            GeneratedChunkStatus::Unavailable,
            GeneratedChunkStatus::FailedTransient,
            GeneratedChunkStatus::FailedPermanent,
        ] {
            cache.set_chunk_status(
                ImageId("img-1".into()),
                1,
                "1/0/0/0/0/0".into(),
                status,
                Some("status".into()),
            );
            match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
                DerivedChunkLookup::Status { status: got, .. } => assert_eq!(got, status),
                DerivedChunkLookup::Ready(_) => panic!("expected status"),
            }
        }
    }

    /// The minimap draws each tile of a collection from its coarse level, so
    /// a tile without a source coarse level needs a generated one of its own.
    #[test]
    fn every_collection_tile_without_a_source_coarse_level_gets_a_generated_one() {
        let single = source_manifest_with_levels(
            vec![level(0, [1, 2, 1, 3000, 3000], [1, 1, 1, 64, 64])],
            None,
            DataType::Uint16,
        );
        let template = &single.images()[0];
        let (entities, images): (Vec<_>, Vec<_>) = ["A/1/0", "A/2/0", "B/1/0"]
            .iter()
            .map(|tile| {
                let owner = EntityId(format!("plate:tile:{tile}"));
                let entity = Entity {
                    id: owner.clone(),
                    kind: EntityKind::Tile,
                    parent: None,
                    labels: EntityLabels::default(),
                };
                let image = lucida_content::ImageSpec {
                    image_id: ImageId(format!("plate:image:{tile}")),
                    owner,
                    multiscale: template.multiscale.clone(),
                };
                (entity, image)
            })
            .unzip();
        let mut manifest = DatasetManifest::new(
            DatasetId("plate".into()),
            "plate".into(),
            DatasetKind::Collection {
                rows: vec!["A".into(), "B".into()],
                columns: vec!["1".into(), "2".into()],
                positioning_mode: lucida_content::PositioningMode::Derived,
                has_explicit_positions: false,
            },
            entities,
            vec![],
            images,
            vec![],
            None,
        );

        let plans = plan_generated_coarse_for_manifest(
            &manifest,
            &no_binding(),
            GeneratedCoarseConfig::default(),
        );
        assert_eq!(plans.len(), 3);
        let identities: HashSet<_> = plans.iter().map(|p| p.cache_identity.clone()).collect();
        assert_eq!(identities.len(), 3, "each tile caches its own level");

        let cache = DerivedChunkCache::default();
        for plan in &plans {
            cache.register_generated_plan(plan).unwrap();
        }
        merge_generated_availability_into_manifest(&mut manifest, &cache.snapshot());
        for (image, plan) in manifest.images().iter().zip(&plans) {
            assert_eq!(
                image.multiscale.coarse_level_index,
                Some(plan.level_index),
                "{} has a coarse level",
                image.image_id.0
            );
        }
    }

    #[test]
    fn availability_merges_into_client_visible_manifest() {
        let mut manifest = source_manifest();
        let snapshot = GeneratedAvailabilitySnapshot {
            levels: vec![generated_level()],
            chunks: vec![],
            histograms: vec![],
        };

        merge_generated_availability_into_manifest(&mut manifest, &snapshot);

        let multiscale = &manifest.images()[0].multiscale;
        assert_eq!(multiscale.levels.len(), 2);
        assert_eq!(multiscale.generated_levels.len(), 1);
        assert_eq!(multiscale.coarse_level_index, Some(1));
    }
}
