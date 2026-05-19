use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use lucida_content::{
    DataType, DatasetId, DatasetKind, DatasetManifest, GeneratedLevelInfo,
    GeneratedLevelProvenance, GeneratedLevelRole, ImageId, ImageSpec, LevelGeometry,
};
use lucida_core::protocol::{
    ClientId, ServerMessage, ViewerInterestChunkKey, ViewerInterestHint, ViewerInterestLane,
};
use lucida_protocol::{
    GeneratedAvailabilityDelta, GeneratedAvailabilitySnapshot, GeneratedChunkStatus,
    GeneratedChunkStatusUpdate, GeneratedLevelAvailability, GeneratedLevelSummary,
};
use lucida_store::cache::CachedStore;
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast};

use crate::BroadcastItem;
use crate::binding::ChunkResolver;
use crate::proxy::{BuildSourceError, fetch_dense_volume};
use crate::session::Session;

pub const GENERATED_COARSE_GENERATOR_VERSION: &str = "generated-coarse-v1";
const DEFAULT_TARGET_LONG_AXIS: u64 = 512;
const DEFAULT_CHUNK_LONG_AXIS: u64 = 256;
const DEFAULT_MAX_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const DOWNSAMPLE_ALGORITHM_VERSION: &str = "box-average-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedCoarseConfig {
    pub target_long_axis: u64,
    pub chunk_long_axis: u64,
    pub max_chunk_bytes: u64,
}

impl Default for GeneratedCoarseConfig {
    fn default() -> Self {
        Self {
            target_long_axis: DEFAULT_TARGET_LONG_AXIS,
            chunk_long_axis: DEFAULT_CHUNK_LONG_AXIS,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
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
    Predicted,
    Background,
}

impl GeneratedSchedulingLane {
    fn rank(self) -> u8 {
        match self {
            GeneratedSchedulingLane::Visible => 0,
            GeneratedSchedulingLane::Predicted => 1,
            GeneratedSchedulingLane::Background => 2,
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
    pub queued_predicted: usize,
    pub queued_background: usize,
    pub running: usize,
    pub completed: u64,
    pub failed: u64,
    pub canceled: u64,
    pub deduped: u64,
    pub cache_reused: u64,
}

#[derive(Clone)]
pub struct GeneratedCoarseService {
    inner: Arc<GeneratedCoarseServiceInner>,
}

struct GeneratedCoarseServiceInner {
    plans: HashMap<(ImageId, u32), GeneratedCoarsePlan>,
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
    interests: HashMap<(ClientId, DatasetId), ViewerInterestHint>,
    queued: VecDeque<GeneratedWorkItem>,
    queued_keys: HashMap<GeneratedWorkKey, GeneratedSchedulingLane>,
    running: HashSet<GeneratedWorkKey>,
    completed_keys: HashSet<GeneratedWorkKey>,
    completed: u64,
    failed: u64,
    canceled: u64,
    deduped: u64,
    cache_reused: u64,
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
    bytes: Option<Vec<u8>>,
}

#[derive(Debug, Default)]
struct DerivedChunkState {
    availability: GeneratedAvailabilitySnapshot,
    chunks: HashMap<DerivedChunkKey, DerivedChunkEntry>,
}

#[derive(Debug)]
struct DerivedDiskCache {
    root_dir: PathBuf,
    url_hash: [u8; 16],
    tmp_counter: AtomicU64,
}

/// In-memory runtime registry for generated levels and seeded fake chunks.
///
/// Durable cache materialization lands in the next slice. This registry still
/// gives the server a source-aware resolver contract now: generated level keys
/// do not hit source storage, and unready generated chunks return explicit
/// statuses instead of disappearing as timeouts.
#[derive(Debug, Clone, Default)]
pub struct DerivedChunkCache {
    inner: Arc<Mutex<DerivedChunkState>>,
    disk: Option<Arc<DerivedDiskCache>>,
}

impl DerivedChunkCache {
    pub fn new(snapshot: GeneratedAvailabilitySnapshot) -> Self {
        let cache = Self::default();
        cache.replace_snapshot(snapshot);
        cache
    }

    pub fn new_on_disk(root_dir: PathBuf, url_hash: [u8; 16]) -> Self {
        let disk = match fs::create_dir_all(&root_dir) {
            Ok(()) => Some(Arc::new(DerivedDiskCache {
                root_dir,
                url_hash,
                tmp_counter: AtomicU64::new(0),
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
        }
    }

    pub fn snapshot(&self) -> GeneratedAvailabilitySnapshot {
        self.inner.lock().unwrap().availability.clone()
    }

    pub fn replace_snapshot(&self, snapshot: GeneratedAvailabilitySnapshot) {
        let mut state = self.inner.lock().unwrap();
        state.availability = snapshot.clone();
        state.chunks.clear();
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
                    bytes: None,
                },
            );
        }
    }

    pub fn apply_delta(&self, delta: GeneratedAvailabilityDelta) {
        let mut state = self.inner.lock().unwrap();
        state.availability.apply_delta(delta.clone());
        for chunk in delta.chunks {
            let key = DerivedChunkKey {
                image_id: chunk.image_id,
                level_index: chunk.level_index,
                key: chunk.key,
            };
            state
                .chunks
                .entry(key)
                .and_modify(|entry| {
                    entry.status = chunk.status;
                    entry.message = chunk.message.clone();
                    if chunk.status != GeneratedChunkStatus::Ready {
                        entry.bytes = None;
                    }
                })
                .or_insert(DerivedChunkEntry {
                    status: chunk.status,
                    message: chunk.message,
                    bytes: None,
                });
        }
    }

    pub fn upsert_level(&self, level: GeneratedLevelAvailability) {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: vec![],
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
        });
    }

    pub fn seed_ready_chunk(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) {
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
        });
        state.chunks.insert(
            DerivedChunkKey {
                image_id,
                level_index,
                key,
            },
            DerivedChunkEntry {
                status: GeneratedChunkStatus::Ready,
                message: None,
                bytes: Some(bytes),
            },
        );
    }

    pub fn put_ready_chunk_atomic(
        &self,
        level_identity: &str,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) -> io::Result<()> {
        if let Some(disk) = &self.disk {
            disk.put(level_identity, &image_id, level_index, &key, &bytes)?;
        }
        self.seed_ready_chunk(image_id, level_index, key, bytes);
        Ok(())
    }

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
        let Some(bytes) = disk.get(level_identity, &image_id, level_index, &key)? else {
            return Ok(false);
        };
        self.seed_ready_chunk(image_id, level_index, key, bytes);
        Ok(true)
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
        let state = self.inner.lock().unwrap();
        let chunk_key = DerivedChunkKey {
            image_id: image_id.clone(),
            level_index,
            key: key.to_string(),
        };
        if let Some(entry) = state.chunks.get(&chunk_key) {
            if entry.status == GeneratedChunkStatus::Ready {
                if let Some(bytes) = &entry.bytes {
                    return DerivedChunkLookup::Ready(bytes.clone());
                }
                return DerivedChunkLookup::Status {
                    status: GeneratedChunkStatus::Unavailable,
                    message: Some("generated chunk marked ready but bytes are unavailable".into()),
                };
            }
            return DerivedChunkLookup::Status {
                status: entry.status,
                message: entry.message.clone(),
            };
        }

        if state
            .availability
            .levels
            .iter()
            .any(|level| level.image_id == *image_id && level.info.level_index == level_index)
        {
            return DerivedChunkLookup::Status {
                status: GeneratedChunkStatus::Pending,
                message: None,
            };
        }

        DerivedChunkLookup::Status {
            status: GeneratedChunkStatus::Unavailable,
            message: Some("generated level is not registered".into()),
        }
    }
}

impl DerivedDiskCache {
    fn dataset_dir(&self) -> PathBuf {
        self.root_dir.join(hex16(&self.url_hash))
    }

    fn chunk_path(
        &self,
        level_identity: &str,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
    ) -> PathBuf {
        self.dataset_dir()
            .join(sanitize_segment(level_identity))
            .join(sanitize_segment(&image_id.0))
            .join(format!("L{level_index}"))
            .join(format!("{}.bin", sanitize_segment(key)))
    }

    fn get(
        &self,
        level_identity: &str,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
    ) -> io::Result<Option<Vec<u8>>> {
        let path = self.chunk_path(level_identity, image_id, level_index, key);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    fn put(
        &self,
        level_identity: &str,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
        bytes: &[u8],
    ) -> io::Result<()> {
        let path = self.chunk_path(level_identity, image_id, level_index, key);
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

        match fs::rename(&tmp_path, &path) {
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

pub fn plan_generated_coarse_for_manifest(
    manifest: &DatasetManifest,
    config: GeneratedCoarseConfig,
) -> Vec<GeneratedCoarsePlan> {
    manifest
        .images()
        .iter()
        .filter_map(|image| plan_generated_coarse_for_image(manifest, image, config.clone()))
        .collect()
}

fn plan_generated_coarse_for_image(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    config: GeneratedCoarseConfig,
) -> Option<GeneratedCoarsePlan> {
    if image.multiscale.coarse_level_index.is_some() || image.multiscale.levels.is_empty() {
        return None;
    }

    let source_content_id = source_content_id_for_image(manifest, image);
    let output_long_axis =
        generated_output_long_axis(image.multiscale.levels[0].shape, config.target_long_axis);
    let candidates = input_level_candidates(image, output_long_axis);
    let selected_input = candidates.first().copied().unwrap_or(0);
    let selected_level = &image.multiscale.levels[selected_input];
    let source_level0 = &image.multiscale.levels[0];
    let output_shape = generated_output_shape(source_level0.shape, selected_level.shape, &config);
    let chunk_shape = generated_chunk_shape(output_shape, image.multiscale.data_type, &config);
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
    let generated_level_id =
        generated_level_identity(&source_content_id, &image.image_id, &level, &config_id);
    let cache_identity = generated_cache_identity(
        &source_content_id,
        &image.image_id,
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
        let plan_map = plans
            .into_iter()
            .map(|plan| ((plan.image_id.clone(), plan.level_index), plan))
            .collect();
        Self {
            inner: Arc::new(GeneratedCoarseServiceInner {
                plans: plan_map,
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

    pub async fn enqueue_chunk_request(&self, image_id: &ImageId, level_index: u32, key: &str) {
        let Some(plan) = self.inner.plans.get(&(image_id.clone(), level_index)) else {
            return;
        };
        let work_key = GeneratedWorkKey {
            dataset_id: plan.dataset_id.clone(),
            image_id: image_id.clone(),
            level_index,
            key: key.to_string(),
        };
        self.enqueue_work(work_key, GeneratedSchedulingLane::Visible)
            .await;
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
        expire_interests_locked(&mut state, now_ms);
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
        drop(state);
        self.inner.notify.notify_waiters();
    }

    pub async fn remove_client_interest(&self, client_id: ClientId) {
        let mut state = self.inner.state.lock().await;
        state.interests.retain(|(cid, _), _| *cid != client_id);
        prune_stale_queued_locked(&mut state, &self.inner.plans, current_unix_millis());
        drop(state);
        self.inner.notify.notify_waiters();
    }

    pub async fn telemetry(&self) -> GeneratedSchedulerTelemetry {
        let state = self.inner.state.lock().await;
        telemetry_locked(&state)
    }

    pub async fn enqueue_background_fill(&self) {
        if self.inner.config.background_chunk_limit == 0 {
            return;
        }
        let mut admitted = 0usize;
        for plan in self.inner.plans.values() {
            'tc: for t in 0..plan.availability.level.shape[0] {
                for c in 0..plan.availability.level.shape[1] {
                    let (Ok(t), Ok(c)) = (u32::try_from(t), u32::try_from(c)) else {
                        continue;
                    };
                    for key in plan.chunk_keys_for_tc(t, c) {
                        let work_key = GeneratedWorkKey {
                            dataset_id: plan.dataset_id.clone(),
                            image_id: plan.image_id.clone(),
                            level_index: plan.level_index,
                            key,
                        };
                        self.enqueue_work(work_key, GeneratedSchedulingLane::Background)
                            .await;
                        admitted += 1;
                        if admitted >= self.inner.config.background_chunk_limit {
                            break 'tc;
                        }
                    }
                }
            }
        }
    }

    async fn enqueue_work(&self, work_key: GeneratedWorkKey, lane: GeneratedSchedulingLane) {
        let mut state = self.inner.state.lock().await;
        enqueue_work_locked(&mut state, work_key, lane);
        drop(state);
        self.inner.notify.notify_waiters();
    }

    async fn worker_loop(self) {
        loop {
            let item = self.next_work_item().await;
            if self.should_cancel(&item).await {
                self.mark_canceled(item.work_key).await;
                continue;
            }
            let result = self.materialize_work_item(&item).await;
            let mut state = self.inner.state.lock().await;
            state.running.remove(&item.work_key);
            match result {
                MaterializeOneResult::Ready => {
                    state.completed_keys.insert(item.work_key);
                    state.completed += 1;
                }
                MaterializeOneResult::CacheReused => {
                    state.completed_keys.insert(item.work_key);
                    state.completed += 1;
                    state.cache_reused += 1;
                }
                MaterializeOneResult::Failed => {
                    state.failed += 1;
                }
                MaterializeOneResult::Canceled => {
                    state.canceled += 1;
                }
            }
        }
    }

    async fn next_work_item(&self) -> GeneratedWorkItem {
        loop {
            if let Some(item) = self.pop_next_work_item().await {
                return item;
            }
            self.inner.notify.notified().await;
        }
    }

    async fn pop_next_work_item(&self) -> Option<GeneratedWorkItem> {
        let mut state = self.inner.state.lock().await;
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
    let mut wanted = HashSet::new();
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

fn telemetry_locked(state: &GeneratedSchedulerState) -> GeneratedSchedulerTelemetry {
    let mut telemetry = GeneratedSchedulerTelemetry {
        running: state.running.len(),
        completed: state.completed,
        failed: state.failed,
        canceled: state.canceled,
        deduped: state.deduped,
        cache_reused: state.cache_reused,
        ..GeneratedSchedulerTelemetry::default()
    };
    for item in &state.queued {
        match item.lane {
            GeneratedSchedulingLane::Visible => telemetry.queued_visible += 1,
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
            chunks: vec![],
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
    let Some(image) = manifest
        .images()
        .iter()
        .find(|image| image.image_id == plan.image_id)
        .cloned()
    else {
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
    };

    if image.multiscale.data_type != DataType::Uint16 {
        publish_all_chunks_for_plan(
            &plan,
            GeneratedChunkStatus::FailedPermanent,
            Some(format!(
                "generated coarse currently supports Uint16 source data, got {:?}",
                image.multiscale.data_type
            )),
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

            let source_volume =
                fetch_with_fallback(&manifest, &image, t, c, &plan, &store, &resolver).await;
            let (source_data, source_dims) = match source_volume {
                Ok((data, dims)) => (data, dims),
                Err(e) => {
                    let status = generated_status_for_source_error(&e);
                    publish_chunks_for_tc(
                        &plan,
                        t,
                        c,
                        status,
                        Some(e.to_string()),
                        cache.clone(),
                        session.clone(),
                        tx.clone(),
                    )
                    .await;
                    continue;
                }
            };

            let output_dims = [
                u32::try_from(level.shape[2]).unwrap_or(u32::MAX),
                u32::try_from(level.shape[3]).unwrap_or(u32::MAX),
                u32::try_from(level.shape[4]).unwrap_or(u32::MAX),
            ];
            let output = match downsample_u16_box(&source_data, source_dims, output_dims) {
                Ok(output) => output,
                Err(e) => {
                    publish_chunks_for_tc(
                        &plan,
                        t,
                        c,
                        GeneratedChunkStatus::FailedPermanent,
                        Some(e),
                        cache.clone(),
                        session.clone(),
                        tx.clone(),
                    )
                    .await;
                    continue;
                }
            };

            materialize_chunks_for_tc(
                &plan,
                t,
                c,
                &output,
                cache.clone(),
                session.clone(),
                tx.clone(),
            )
            .await;
        }
    }
}

async fn fetch_with_fallback(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    t: u32,
    c: u32,
    plan: &GeneratedCoarsePlan,
    store: &Arc<CachedStore>,
    resolver: &Arc<ChunkResolver>,
) -> Result<(Vec<u16>, [u32; 3]), BuildSourceError> {
    let mut last_error = None;
    for level in &plan.input_level_candidates {
        match fetch_dense_volume(manifest, image, t, c, *level, store, resolver).await {
            Ok((data, dims, _voxel_to_image)) => return Ok((data, dims)),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.unwrap_or(BuildSourceError::BadLevel {
        image: image.image_id.clone(),
        level: 0,
    }))
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
    match cache.load_ready_chunk(
        &plan.cache_identity,
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
    ) {
        Ok(true) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::Ready,
                None,
                cache,
                session,
                tx,
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

    if image.multiscale.data_type != DataType::Uint16 {
        publish_chunk_status(
            &plan.dataset_id,
            &plan.image_id,
            plan.level_index,
            key,
            GeneratedChunkStatus::FailedPermanent,
            Some(format!(
                "generated coarse currently supports Uint16 source data, got {:?}",
                image.multiscale.data_type
            )),
            cache,
            session,
            tx,
        )
        .await;
        return MaterializeOneResult::Failed;
    }

    let (source_data, source_dims) = match fetch_with_fallback(
        &manifest, &image, coords.t, coords.c, plan, &store, &resolver,
    )
    .await
    {
        Ok((data, dims)) => (data, dims),
        Err(e) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                generated_status_for_source_error(&e),
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

    let level = &plan.availability.level;
    let output_dims = [
        u32::try_from(level.shape[2]).unwrap_or(u32::MAX),
        u32::try_from(level.shape[3]).unwrap_or(u32::MAX),
        u32::try_from(level.shape[4]).unwrap_or(u32::MAX),
    ];
    let output = match downsample_u16_box(&source_data, source_dims, output_dims) {
        Ok(output) => output,
        Err(e) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::FailedPermanent,
                Some(e),
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

    let bytes = encode_generated_chunk_bytes(&output, level, coords.z, coords.y, coords.x);
    match cache.put_ready_chunk_atomic(
        &plan.cache_identity,
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
        bytes,
    ) {
        Ok(()) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::Ready,
                None,
                cache,
                session,
                tx,
            )
            .await;
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

async fn materialize_chunks_for_tc(
    plan: &GeneratedCoarsePlan,
    t: u32,
    c: u32,
    output: &[u16],
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
) {
    let level = &plan.availability.level;
    for gz in 0..level.grid_shape[2] {
        for gy in 0..level.grid_shape[3] {
            for gx in 0..level.grid_shape[4] {
                let key = chunk_key(plan.level_index, t, c, gz, gy, gx);
                match cache.load_ready_chunk(
                    &plan.cache_identity,
                    plan.image_id.clone(),
                    plan.level_index,
                    key.clone(),
                ) {
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
                        continue;
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

                let bytes = encode_generated_chunk_bytes(output, level, gz, gy, gx);
                match cache.put_ready_chunk_atomic(
                    &plan.cache_identity,
                    plan.image_id.clone(),
                    plan.level_index,
                    key.clone(),
                    bytes,
                ) {
                    Ok(()) => {
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
                    }
                    Err(e) => {
                        publish_chunk_status(
                            &plan.dataset_id,
                            &plan.image_id,
                            plan.level_index,
                            key,
                            GeneratedChunkStatus::FailedTransient,
                            Some(e.to_string()),
                            cache.clone(),
                            session.clone(),
                            tx.clone(),
                        )
                        .await;
                    }
                }
            }
        }
    }
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

fn generated_status_for_source_error(error: &BuildSourceError) -> GeneratedChunkStatus {
    match error {
        BuildSourceError::Fetch { .. } => GeneratedChunkStatus::FailedTransient,
        BuildSourceError::MissingEntity(_)
        | BuildSourceError::MissingImage(_)
        | BuildSourceError::NoFields(_)
        | BuildSourceError::BadLevel { .. }
        | BuildSourceError::OutOfBounds { .. }
        | BuildSourceError::UnknownImage(_)
        | BuildSourceError::Decode { .. }
        | BuildSourceError::ShortChunk { .. }
        | BuildSourceError::TooLarge => GeneratedChunkStatus::FailedPermanent,
    }
}

fn source_content_id_for_image(manifest: &DatasetManifest, image: &ImageSpec) -> String {
    let value = serde_json::json!({
        "dataset_id": &manifest.dataset_id.0,
        "image": image,
        "generator": GENERATED_COARSE_GENERATOR_VERSION,
    });
    hex32(blake3::hash(value.to_string().as_bytes()).as_bytes())
}

fn generated_level_identity(
    source_content_id: &str,
    image_id: &ImageId,
    level: &LevelGeometry,
    config_id: &str,
) -> String {
    let value = serde_json::json!({
        "source_content_id": source_content_id,
        "image_id": &image_id.0,
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
    image_id: &ImageId,
    generated_level_id: &str,
    level: &LevelGeometry,
    data_type: DataType,
    config_id: &str,
    input_level_candidates: &[usize],
) -> String {
    let value = serde_json::json!({
        "source_content_id": source_content_id,
        "image_id": &image_id.0,
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
    let source_y = source_level0_shape[3].max(1);
    let source_x = source_level0_shape[4].max(1);
    let long_axis = source_y.max(source_x);
    let target_long = long_axis.min(config.target_long_axis).max(1);
    let scale = target_long as f64 / long_axis as f64;
    let out_y = ((source_y as f64) * scale).round().max(1.0) as u64;
    let out_x = ((source_x as f64) * scale).round().max(1.0) as u64;
    [
        source_level0_shape[0],
        source_level0_shape[1],
        selected_input_shape[2].max(1),
        out_y.min(source_y),
        out_x.min(source_x),
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
    data_type: DataType,
    config: &GeneratedCoarseConfig,
) -> [u64; 5] {
    let bytes_per_voxel = data_type_size(data_type);
    let mut chunk_y = output_shape[3].min(config.chunk_long_axis).max(1);
    let mut chunk_x = output_shape[4].min(config.chunk_long_axis).max(1);
    let chunk_z = 1_u64.min(output_shape[2]).max(1);
    while checked_product(&[chunk_z, chunk_y, chunk_x, bytes_per_voxel])
        .is_some_and(|bytes| bytes > config.max_chunk_bytes)
        && (chunk_y > 1 || chunk_x > 1)
    {
        if chunk_y >= chunk_x && chunk_y > 1 {
            chunk_y = chunk_y.div_ceil(2).max(1);
        } else if chunk_x > 1 {
            chunk_x = chunk_x.div_ceil(2).max(1);
        }
    }
    [1, 1, chunk_z, chunk_y, chunk_x]
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
    match data_type {
        DataType::Uint8 => 1,
        DataType::Uint16 => 2,
        DataType::Uint32 | DataType::Float32 => 4,
        DataType::Float64 => 8,
    }
}

fn downsample_u16_box(
    input: &[u16],
    input_dims: [u32; 3],
    output_dims: [u32; 3],
) -> Result<Vec<u16>, String> {
    let [in_z, in_y, in_x] = input_dims;
    let [out_z, out_y, out_x] = output_dims;
    let expected = (in_z as usize)
        .checked_mul(in_y as usize)
        .and_then(|v| v.checked_mul(in_x as usize))
        .ok_or_else(|| "source generated coarse volume is too large".to_string())?;
    if input.len() != expected {
        return Err(format!(
            "source generated coarse volume has {} voxels, expected {expected}",
            input.len()
        ));
    }
    if input_dims == output_dims {
        return Ok(input.to_vec());
    }

    let output_len = (out_z as usize)
        .checked_mul(out_y as usize)
        .and_then(|v| v.checked_mul(out_x as usize))
        .ok_or_else(|| "output generated coarse volume is too large".to_string())?;
    let mut output = vec![0_u16; output_len];
    let out_stride_y = out_x as usize;
    let out_stride_z = (out_y as usize) * out_stride_y;
    let in_stride_y = in_x as usize;
    let in_stride_z = (in_y as usize) * in_stride_y;

    for oz in 0..out_z {
        let (z0, z1) = scale_range(oz, out_z, in_z);
        for oy in 0..out_y {
            let (y0, y1) = scale_range(oy, out_y, in_y);
            for ox in 0..out_x {
                let (x0, x1) = scale_range(ox, out_x, in_x);
                let mut sum = 0_u64;
                let mut count = 0_u64;
                for iz in z0..z1 {
                    for iy in y0..y1 {
                        let base = (iz as usize) * in_stride_z + (iy as usize) * in_stride_y;
                        for ix in x0..x1 {
                            sum += input[base + ix as usize] as u64;
                            count += 1;
                        }
                    }
                }
                let value = if count == 0 {
                    0
                } else {
                    ((sum + count / 2) / count) as u16
                };
                let out_idx =
                    (oz as usize) * out_stride_z + (oy as usize) * out_stride_y + ox as usize;
                output[out_idx] = value;
            }
        }
    }
    Ok(output)
}

fn scale_range(out_index: u32, out_len: u32, in_len: u32) -> (u32, u32) {
    let start = ((out_index as u64) * (in_len as u64) / (out_len as u64)) as u32;
    let end = (((out_index as u64 + 1) * (in_len as u64)).div_ceil(out_len as u64)) as u32;
    let end = end.max(start + 1).min(in_len);
    (start.min(in_len.saturating_sub(1)), end)
}

fn encode_generated_chunk_bytes(
    output: &[u16],
    level: &LevelGeometry,
    gz: u64,
    gy: u64,
    gx: u64,
) -> Vec<u8> {
    let chunk_z = level.chunk_shape[2];
    let chunk_y = level.chunk_shape[3];
    let chunk_x = level.chunk_shape[4];
    let level_z = level.shape[2];
    let level_y = level.shape[3];
    let level_x = level.shape[4];
    let chunk_voxels = (chunk_z as usize) * (chunk_y as usize) * (chunk_x as usize);
    let mut chunk = vec![0_u16; chunk_voxels];
    let out_stride_y = level_x as usize;
    let out_stride_z = (level_y as usize) * out_stride_y;
    let chunk_stride_y = chunk_x as usize;
    let chunk_stride_z = (chunk_y as usize) * chunk_stride_y;
    let z0 = gz * chunk_z;
    let y0 = gy * chunk_y;
    let x0 = gx * chunk_x;
    let z_end = (z0 + chunk_z).min(level_z);
    let y_end = (y0 + chunk_y).min(level_y);
    let x_end = (x0 + chunk_x).min(level_x);

    for z in z0..z_end {
        for y in y0..y_end {
            let src_base = (z as usize) * out_stride_z + (y as usize) * out_stride_y;
            let dst_base =
                ((z - z0) as usize) * chunk_stride_z + ((y - y0) as usize) * chunk_stride_y;
            for x in x0..x_end {
                chunk[dst_base + (x - x0) as usize] = output[src_base + x as usize];
            }
        }
    }

    let mut bytes = Vec::with_capacity(chunk.len() * 2);
    for value in chunk {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
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
        ServerBindingSeed {
            images: vec![ImageBindingSeed {
                image_id: ImageId("img-1".into()),
                axes_names: vec!["t".into(), "c".into(), "z".into(), "y".into(), "x".into()],
                store_prefix: None,
                levels: levels
                    .iter()
                    .map(|level| LevelBindingInfo {
                        level_index: level.level_index,
                        compression: StorageCompression::None,
                        chunk_shape: level.chunk_shape.to_vec(),
                        chunk_byte_layout: ChunkByteLayout {
                            canonical_byte_size: checked_product(&[
                                level.chunk_shape[2],
                                level.chunk_shape[3],
                                level.chunk_shape[4],
                                2,
                            ])
                            .unwrap() as usize,
                            on_disk_byte_size: 0,
                            byte_stride_t: 0,
                            byte_stride_c: 0,
                            chunk_size_t: 1,
                            chunk_size_c: 1,
                        },
                    })
                    .collect(),
            }],
        }
    }

    fn service_for_plan(
        manifest: DatasetManifest,
        plan: GeneratedCoarsePlan,
        config: GeneratedSchedulingConfig,
    ) -> GeneratedCoarseService {
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cached = Arc::new(CachedStore::new(store, 1024 * 1024));
        let resolver = Arc::new(ChunkResolver::new(&binding_seed_for(
            &manifest.images()[0].multiscale.levels,
        )));
        let cache = Arc::new(DerivedChunkCache::default());
        cache.upsert_level(plan.availability.clone());
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

        let plans = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default());

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
        };

        let plans = plan_generated_coarse_for_manifest(&manifest, config);

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
    fn generated_chunk_job_key_carries_identity_scope() {
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
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

    #[test]
    fn box_downsample_averages_source_pixels() {
        let input: Vec<u16> = (0..16).collect();

        let output = downsample_u16_box(&input, [1, 4, 4], [1, 2, 2]).unwrap();

        assert_eq!(output, vec![3, 5, 11, 13]);
    }

    #[test]
    fn generated_chunk_encoding_pads_edge_chunks_to_nominal_shape() {
        let level = LevelGeometry {
            level_index: 1,
            shape: [1, 1, 1, 3, 3],
            chunk_shape: [1, 1, 1, 2, 2],
            grid_shape: [1, 1, 1, 2, 2],
            scale: [1.0; 5],
        };
        let output: Vec<u16> = (1..=9).collect();

        let bytes = encode_generated_chunk_bytes(&output, &level, 0, 1, 1);
        let values: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();

        assert_eq!(values, vec![9, 0, 0, 0]);
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
        assert!(
            reopened
                .load_ready_chunk("identity", ImageId("img-1".into()), 1, "1/0/0/0/0/0".into())
                .unwrap()
        );
        match reopened.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => assert_eq!(bytes, vec![1, 2, 3, 4]),
            DerivedChunkLookup::Status { status, .. } => panic!("expected ready, got {status:?}"),
        }

        let chunk_dir = dir
            .path()
            .join(hex16(&[7; 16]))
            .join("identity")
            .join("img-1")
            .join("L1");
        let leftovers: Vec<_> = fs::read_dir(chunk_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[tokio::test]
    async fn generated_coarse_materializes_from_fake_source_without_mutating_source() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use object_store::path::Path;
        use tokio::sync::broadcast;

        let source_level = level(0, [1, 1, 1, 4, 4], [1, 1, 1, 4, 4]);
        let manifest =
            source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            GeneratedCoarseConfig {
                target_long_axis: 2,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
            },
        )
        .pop()
        .expect("plan");
        let seed = binding_seed_for(&[source_level]);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let source_path = Path::from("0/c/0/0/0/0/0");
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
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                assert_eq!(values, vec![3, 5, 11, 13]);
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
    async fn viewer_interest_dedupes_duplicate_chunks_to_highest_lane() {
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
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
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
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
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
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

    #[tokio::test]
    async fn visible_work_yields_background_fill() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
            None,
            DataType::Uint16,
        );
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
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
            GeneratedCoarseConfig {
                target_long_axis: 512,
                chunk_long_axis: 256,
                max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
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

    #[test]
    fn generated_source_failures_are_classified_for_retry() {
        let transient = BuildSourceError::Fetch {
            image: ImageId("img-1".into()),
            key: "0/0/0/0/0/0".into(),
            message: "temporary object-store failure".into(),
        };
        let permanent = BuildSourceError::ShortChunk {
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

    #[test]
    fn availability_merges_into_client_visible_manifest() {
        let mut manifest = source_manifest();
        let snapshot = GeneratedAvailabilitySnapshot {
            levels: vec![generated_level()],
            chunks: vec![],
        };

        merge_generated_availability_into_manifest(&mut manifest, &snapshot);

        let multiscale = &manifest.images()[0].multiscale;
        assert_eq!(multiscale.levels.len(), 2);
        assert_eq!(multiscale.generated_levels.len(), 1);
        assert_eq!(multiscale.coarse_level_index, Some(1));
    }
}
