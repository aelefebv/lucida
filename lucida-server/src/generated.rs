use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast};

use crate::BroadcastItem;
use crate::binding::ChunkResolver;
use crate::proxy::{BuildSourceError, VolumeRegion, fetch_volume_region};
use crate::session::Session;

pub const GENERATED_COARSE_GENERATOR_VERSION: &str = "generated-coarse-v2";
const DEFAULT_TARGET_LONG_AXIS: u64 = 512;
const DEFAULT_CHUNK_LONG_AXIS: u64 = 256;
const DEFAULT_MAX_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const DOWNSAMPLE_ALGORITHM_VERSION: &str = "max-pool-v1";

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
    ready_broadcasts: u64,
    materialization_latency_samples: u64,
    materialization_latency_total_ms: u64,
    last_materialization_latency_ms: u64,
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
    bytes: Option<Vec<u8>>,
}

#[derive(Debug, Default)]
struct DerivedChunkState {
    availability: GeneratedAvailabilitySnapshot,
    chunks: HashMap<DerivedChunkKey, DerivedChunkEntry>,
    level_identities: HashMap<(ImageId, u32), String>,
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
    tmp_counter: AtomicU64,
    eviction_counter: AtomicU64,
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
        }
    }

    pub fn snapshot(&self) -> GeneratedAvailabilitySnapshot {
        self.inner.lock().unwrap().availability.clone()
    }

    pub fn replace_snapshot(&self, snapshot: GeneratedAvailabilitySnapshot) {
        let mut state = self.inner.lock().unwrap();
        state.availability = snapshot.clone();
        state.chunks.clear();
        state.level_identities.clear();
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
        let indexes = {
            let mut state = self.inner.lock().unwrap();
            state.availability.apply_delta(delta.clone());
            let mut affected_identities = HashSet::new();
            for chunk in delta.chunks {
                let image_id = chunk.image_id;
                let level_index = chunk.level_index;
                if let Some(identity) = state
                    .level_identities
                    .get(&(image_id.clone(), level_index))
                    .cloned()
                {
                    affected_identities.insert(identity);
                }
                let key = DerivedChunkKey {
                    image_id,
                    level_index,
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
            affected_identities
                .into_iter()
                .map(|identity| {
                    let chunks = chunks_for_identity_locked(&state, &identity);
                    (identity, chunks)
                })
                .collect::<Vec<_>>()
        };

        if let Some(disk) = &self.disk {
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

    pub fn register_generated_plan(
        &self,
        plan: &GeneratedCoarsePlan,
    ) -> io::Result<GeneratedAvailabilityDelta> {
        if let Some(disk) = &self.disk {
            disk.put_manifest(plan)?;
        }

        let recovered_chunks = if let Some(disk) = &self.disk {
            disk.recover_readiness(plan)?
        } else {
            vec![]
        };
        let delta = GeneratedAvailabilityDelta {
            levels: vec![plan.availability.clone()],
            chunks: recovered_chunks,
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

    pub fn missing_ready_delta(&self) -> GeneratedAvailabilityDelta {
        let Some(disk) = &self.disk else {
            return GeneratedAvailabilityDelta::default();
        };
        let state = self.inner.lock().unwrap();
        let chunks = state
            .chunks
            .iter()
            .filter_map(|(key, entry)| {
                if entry.status != GeneratedChunkStatus::Ready {
                    return None;
                }
                let identity = state
                    .level_identities
                    .get(&(key.image_id.clone(), key.level_index))?;
                if disk.chunk_exists(identity, &key.image_id, key.level_index, &key.key) {
                    return None;
                }
                Some(GeneratedChunkStatusUpdate {
                    image_id: key.image_id.clone(),
                    level_index: key.level_index,
                    key: key.key.clone(),
                    status: GeneratedChunkStatus::Unavailable,
                    message: Some("generated chunk was evicted from derived cache".into()),
                })
            })
            .collect();
        GeneratedAvailabilityDelta {
            levels: vec![],
            chunks,
        }
    }

    pub fn telemetry(&self) -> DerivedCacheTelemetry {
        if let Some(disk) = &self.disk {
            return disk.telemetry().unwrap_or_default();
        }
        let state = self.inner.lock().unwrap();
        let bytes = state
            .chunks
            .values()
            .filter_map(|entry| entry.bytes.as_ref())
            .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .fold(0_u64, u64::saturating_add);
        DerivedCacheTelemetry {
            storage: DerivedCacheStorage::Memory,
            bytes,
            budget_bytes: None,
            root_dir: None,
            evictions: 0,
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
        let disk_load = {
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
            match disk.get(&identity, image_id, level_index, key) {
                Ok(Some(bytes)) => {
                    self.seed_ready_chunk(
                        image_id.clone(),
                        level_index,
                        key.to_string(),
                        bytes.clone(),
                    );
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

    fn chunk_path(
        &self,
        level_identity: &str,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
    ) -> PathBuf {
        self.identity_dir(level_identity)
            .join(sanitize_segment(&image_id.0))
            .join(format!("L{level_index}"))
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

    fn recover_readiness(
        &self,
        plan: &GeneratedCoarsePlan,
    ) -> io::Result<Vec<GeneratedChunkStatusUpdate>> {
        let expected_bytes = expected_generated_chunk_bytes(plan);
        let mut recovered = Vec::new();
        let mut seen = HashSet::new();

        if let Some(index) = self.read_index(&plan.cache_identity)? {
            for chunk in index.chunks {
                let valid = chunk.status != GeneratedChunkStatus::Ready
                    || self
                        .chunk_file_valid(
                            &plan.cache_identity,
                            &chunk.image_id,
                            chunk.level_index,
                            &chunk.key,
                            expected_bytes,
                        )
                        .unwrap_or(false);
                if valid {
                    seen.insert(chunk.key.clone());
                    recovered.push(chunk);
                }
            }
        }

        for key in self.scan_ready_chunk_keys(plan, expected_bytes)? {
            if seen.insert(key.clone()) {
                recovered.push(GeneratedChunkStatusUpdate {
                    image_id: plan.image_id.clone(),
                    level_index: plan.level_index,
                    key,
                    status: GeneratedChunkStatus::Ready,
                    message: None,
                });
            }
        }
        Ok(recovered)
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
        let dir = self
            .identity_dir(&plan.cache_identity)
            .join(sanitize_segment(&plan.image_id.0))
            .join(format!("L{}", plan.level_index));
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

    fn chunk_file_valid(
        &self,
        level_identity: &str,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
        expected_bytes: u64,
    ) -> io::Result<bool> {
        let metadata =
            match fs::metadata(self.chunk_path(level_identity, image_id, level_index, key)) {
                Ok(metadata) => metadata,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(e) => return Err(e),
            };
        Ok(metadata.len() == expected_bytes)
    }

    fn chunk_exists(
        &self,
        level_identity: &str,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
    ) -> bool {
        self.chunk_path(level_identity, image_id, level_index, key)
            .exists()
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
        self.put_bytes_atomic(&path, bytes)
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
        self.enforce_budget()?;
        Ok(())
    }

    fn enforce_budget(&self) -> io::Result<()> {
        let Some(budget) = self.disk_budget_bytes else {
            return Ok(());
        };
        let dataset_dir = self.dataset_dir();
        let mut identities = Vec::new();
        let mut total = 0_u64;
        let entries = match fs::read_dir(&dataset_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
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
        for (path, bytes, _) in identities {
            if total <= budget {
                break;
            }
            fs::remove_dir_all(&path)?;
            self.eviction_counter.fetch_add(1, Ordering::Relaxed);
            total = total.saturating_sub(bytes);
        }
        Ok(())
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
                state.queued.clear();
                state.queued_keys.clear();
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
        if state.shutdown_reason.is_some() {
            return;
        }
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
        if state.shutdown_reason.is_some() {
            return;
        }
        state.interests.retain(|(cid, _), _| *cid != client_id);
        prune_stale_queued_locked(&mut state, &self.inner.plans, current_unix_millis());
        drop(state);
        self.inner.notify.notify_waiters();
    }

    pub async fn telemetry(&self) -> GeneratedSchedulerTelemetry {
        let cache_telemetry = self.inner.cache.telemetry();
        let state = self.inner.state.lock().await;
        telemetry_locked(&state, cache_telemetry)
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
        if state.shutdown_reason.is_some() {
            return;
        }
        enqueue_work_locked(&mut state, work_key, lane);
        drop(state);
        self.inner.notify.notify_waiters();
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
    Source(BuildSourceError),
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

impl From<BuildSourceError> for GeneratedChunkBuildError {
    fn from(error: BuildSourceError) -> Self {
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

    let bytes = match generate_chunk_with_fallback(
        &manifest, &image, coords, plan, &store, &resolver,
    )
    .await
    {
        Ok(bytes) => bytes,
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
            let withdrawal_delta = cache.missing_ready_delta();
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

async fn generate_chunk_with_fallback(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    coords: GeneratedChunkCoords,
    plan: &GeneratedCoarsePlan,
    store: &Arc<CachedStore>,
    resolver: &Arc<ChunkResolver>,
) -> Result<Vec<u8>, GeneratedChunkBuildError> {
    let mut last_error = None;
    for source_level_index in &plan.input_level_candidates {
        match generate_chunk_from_source_level(
            manifest,
            image,
            coords,
            plan,
            *source_level_index,
            store,
            resolver,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        BuildSourceError::BadLevel {
            image: image.image_id.clone(),
            level: 0,
        }
        .into()
    }))
}

async fn generate_chunk_from_source_level(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    coords: GeneratedChunkCoords,
    plan: &GeneratedCoarsePlan,
    source_level_index: usize,
    store: &Arc<CachedStore>,
    resolver: &Arc<ChunkResolver>,
) -> Result<Vec<u8>, GeneratedChunkBuildError> {
    let source_level = image
        .multiscale
        .levels
        .get(source_level_index)
        .ok_or_else(|| BuildSourceError::BadLevel {
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
        manifest,
        image,
        coords.t,
        coords.c,
        source_level_index,
        source_region,
        store,
        resolver,
    )
    .await?;
    let chunk = downsample_region_to_generated_chunk(
        &source_data,
        source_region,
        region_dims,
        source_dims,
        output_dims,
        level,
        coords,
    )
    .map_err(GeneratedChunkBuildError::Downsample)?;

    Ok(encode_generated_chunk_values(&chunk, plan.output_data_type))
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

fn downsample_region_to_generated_chunk(
    source: &[u16],
    source_region: VolumeRegion,
    region_dims: [u32; 3],
    source_dims: [u32; 3],
    output_dims: [u32; 3],
    level: &LevelGeometry,
    coords: GeneratedChunkCoords,
) -> Result<Vec<u16>, String> {
    let expected = (region_dims[0] as usize)
        .checked_mul(region_dims[1] as usize)
        .and_then(|v| v.checked_mul(region_dims[2] as usize))
        .ok_or_else(|| "source generated coarse region is too large".to_string())?;
    if source.len() != expected {
        return Err(format!(
            "source generated coarse region has {} voxels, expected {expected}",
            source.len()
        ));
    }

    let bounds = output_chunk_bounds(output_dims, level, coords)?;
    let chunk_z = level.chunk_shape[2].max(1);
    let chunk_y = level.chunk_shape[3].max(1);
    let chunk_x = level.chunk_shape[4].max(1);
    let chunk_voxels = (chunk_z as usize)
        .checked_mul(chunk_y as usize)
        .and_then(|v| v.checked_mul(chunk_x as usize))
        .ok_or_else(|| "generated coarse chunk is too large".to_string())?;
    let mut chunk = vec![0_u16; chunk_voxels];

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
                let mut value = 0_u16;
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
                            value = value.max(source[base + local_x as usize]);
                        }
                    }
                }
                let dst = ((oz - bounds.z0) as usize) * chunk_stride_z
                    + ((oy - bounds.y0) as usize) * chunk_stride_y
                    + (ox - bounds.x0) as usize;
                chunk[dst] = value;
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
        | BuildSourceError::NoTiles(_)
        | BuildSourceError::BadLevel { .. }
        | BuildSourceError::OutOfBounds { .. }
        | BuildSourceError::SpatialOutOfBounds { .. }
        | BuildSourceError::UnknownImage(_)
        | BuildSourceError::Decode { .. }
        | BuildSourceError::ShortChunk { .. }
        | BuildSourceError::TooLarge => GeneratedChunkStatus::FailedPermanent,
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
    );
    let mut chunk_y = output_chunk_axis_for_source_chunk(
        output_shape[3],
        source_shape[3],
        source_chunk_shape[3],
        config.chunk_long_axis,
    );
    let mut chunk_x = output_chunk_axis_for_source_chunk(
        output_shape[4],
        source_shape[4],
        source_chunk_shape[4],
        config.chunk_long_axis,
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

fn output_chunk_axis_for_source_chunk(
    output_axis: u64,
    source_axis: u64,
    source_chunk_axis: u64,
    chunk_axis_cap: u64,
) -> u64 {
    let output_axis = output_axis.max(1);
    let source_axis = source_axis.max(1);
    let source_chunk_axis = source_chunk_axis.max(1);
    let cap = chunk_axis_cap.max(1);
    let axis = output_axis
        .saturating_mul(source_chunk_axis)
        .div_ceil(source_axis)
        .max(1);
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
    match data_type {
        DataType::Uint8 => 1,
        DataType::Uint16 => 2,
        DataType::Uint32 | DataType::Float32 => 4,
        DataType::Float64 => 8,
    }
}

#[cfg(test)]
fn downsample_u16_max(
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
                let mut value = 0_u16;
                for iz in z0..z1 {
                    for iy in y0..y1 {
                        let base = (iz as usize) * in_stride_z + (iy as usize) * in_stride_y;
                        for ix in x0..x1 {
                            value = value.max(input[base + ix as usize]);
                        }
                    }
                }
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

#[cfg(test)]
fn encode_generated_chunk_bytes(
    output: &[u16],
    level: &LevelGeometry,
    gz: u64,
    gy: u64,
    gx: u64,
    output_data_type: DataType,
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

    encode_generated_chunk_values(&chunk, output_data_type)
}

fn encode_generated_chunk_values(chunk: &[u16], output_data_type: DataType) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(chunk.len() * data_type_size(output_data_type) as usize);
    for value in chunk {
        encode_u16_as_data_type(*value, output_data_type, &mut bytes);
    }
    bytes
}

fn encode_u16_as_data_type(value: u16, data_type: DataType, out: &mut Vec<u8>) {
    match data_type {
        DataType::Uint8 => out.push(value.min(u8::MAX as u16) as u8),
        DataType::Uint16 => out.extend_from_slice(&value.to_le_bytes()),
        DataType::Uint32 => out.extend_from_slice(&(value as u32).to_le_bytes()),
        DataType::Float32 => {
            out.extend_from_slice(&((value as f32) / (u16::MAX as f32)).to_le_bytes())
        }
        DataType::Float64 => {
            out.extend_from_slice(&((value as f64) / (u16::MAX as f64)).to_le_bytes())
        }
    }
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

    fn source_path(resolver: &ChunkResolver, key: &str) -> object_store::path::Path {
        resolver
            .resolve(&ImageId("img-1".into()), key)
            .unwrap()
            .path()
            .clone()
    }

    fn binding_seed_for_data_type(
        levels: &[LevelGeometry],
        data_type: DataType,
    ) -> ServerBindingSeed {
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
                                data_type_size(data_type),
                            ])
                            .unwrap() as usize,
                            on_disk_byte_size: 0,
                            byte_stride_t: 0,
                            byte_stride_c: 0,
                            chunk_size_t: 1,
                            chunk_size_c: 1,
                        },
                        shard: None,
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
        let image = &manifest.images()[0];
        let resolver = Arc::new(ChunkResolver::new(&binding_seed_for_data_type(
            &image.multiscale.levels,
            image.multiscale.data_type,
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
    fn generated_coarse_planner_downsamples_z_and_aligns_chunks_to_source_footprint() {
        let manifest = source_manifest_with_levels(
            vec![level(0, [1, 1, 2480, 8058, 7718], [1, 1, 32, 1024, 1024])],
            None,
            DataType::Float32,
        );

        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");

        assert_eq!(plan.availability.level.shape, [1, 1, 158, 512, 490]);
        assert_eq!(plan.availability.level.chunk_shape, [1, 1, 3, 66, 66]);
        assert_eq!(plan.availability.level.grid_shape, [1, 1, 53, 8, 8]);
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
    fn max_downsample_preserves_sparse_source_pixels() {
        let input: Vec<u16> = (0..16).collect();

        let output = downsample_u16_max(&input, [1, 4, 4], [1, 2, 2]).unwrap();

        assert_eq!(output, vec![5, 7, 13, 15]);
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

        let bytes = encode_generated_chunk_bytes(&output, &level, 0, 1, 1, DataType::Uint16);
        let values: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_le_bytes)
            .collect();

        assert_eq!(values, vec![9, 0, 0, 0]);
    }

    #[test]
    fn generated_chunk_encoding_preserves_float32_wire_format() {
        let level = LevelGeometry {
            level_index: 1,
            shape: [1, 1, 1, 2, 2],
            chunk_shape: [1, 1, 1, 2, 2],
            grid_shape: [1, 1, 1, 1, 1],
            scale: [1.0; 5],
        };
        let output = vec![0, 32768, 65535, 16384];

        let bytes = encode_generated_chunk_bytes(&output, &level, 0, 0, 0, DataType::Float32);
        let values: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .copied()
            .map(f32::from_le_bytes)
            .collect();

        assert_eq!(bytes.len(), 16);
        assert_eq!(values[0], 0.0);
        assert!((values[1] - 0.5).abs() < 0.00002);
        assert_eq!(values[2], 1.0);
        assert!((values[3] - 0.25).abs() < 0.00002);
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

    #[test]
    fn register_generated_plan_recovers_ready_chunks_from_readiness_index() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = source_manifest();
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
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

        let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [9; 16]);
        let delta = reopened.register_generated_plan(&plan).unwrap();

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
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
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
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");
        let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [11; 16]);
        cache.register_generated_plan(&plan).unwrap();
        let path = cache.disk.as_ref().unwrap().chunk_path(
            &plan.cache_identity,
            &plan.image_id,
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
        let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");
        let cache =
            DerivedChunkCache::new_on_disk_with_budget(dir.path().to_path_buf(), [12; 16], Some(1));
        cache.register_generated_plan(&plan).unwrap();
        cache
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

        let delta = cache.missing_ready_delta();

        assert_eq!(delta.chunks.len(), 1);
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
            GeneratedCoarseConfig {
                target_long_axis: 4,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
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
            GeneratedCoarseConfig {
                target_long_axis: 2,
                chunk_long_axis: 2,
                max_chunk_bytes: 64,
            },
        )
        .pop()
        .expect("plan");
        let seed = binding_seed_for_data_type(&[source_level], DataType::Float32);
        let resolver = Arc::new(ChunkResolver::new(&seed));
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let source_path = source_path(&resolver, "0/0/0/0/0/0");
        let mut source_bytes = Vec::new();
        for value in [0.0_f32, 0.5, 1.0, 2.0] {
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
                assert!((values[0] - 0.0).abs() < 0.00001);
                assert!((values[1] - 0.5).abs() < 0.00002);
                assert!((values[2] - 1.0).abs() < 0.00001);
                assert!((values[3] - 1.0).abs() < 0.00001);
            }
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected generated bytes, got {status:?}: {message:?}");
            }
        }
    }

    #[tokio::test]
    async fn generated_coarse_treats_missing_source_chunks_as_zero_fill() {
        use object_store::PutPayload;
        use object_store::memory::InMemory;
        use tokio::sync::broadcast;

        let source_level = level(0, [1, 1, 1, 2, 2], [1, 1, 1, 1, 1]);
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
                assert_eq!(values, vec![0]);
            }
            DerivedChunkLookup::Status { status, message } => {
                panic!("expected generated bytes, got {status:?}: {message:?}");
            }
        }
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

    #[tokio::test]
    async fn shutdown_cancels_queued_work_and_rejects_new_interest() {
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
