use super::materialize::expected_generated_chunk_bytes;
use super::*;

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

#[derive(Debug, Clone, Default, Serialize)]
pub(super) struct DerivedReadinessIndex {
    pub(super) chunks: Vec<GeneratedChunkStatusUpdate>,
}

#[derive(Debug)]
struct DerivedDiskRootQuota {
    root_dir: PathBuf,
    state: Mutex<DerivedDiskRootQuotaState>,
}

#[derive(Debug)]
struct DerivedDiskRootQuotaState {
    budget_bytes: Option<u64>,
    entry_budget: u64,
    evictions: u64,
    total_bytes: u64,
    total_entries: u64,
    reserved_bytes: u64,
    reserved_entries: u64,
    scopes: HashMap<PathBuf, DerivedDiskScopeUsage>,
    oldest_scopes: BTreeSet<(std::time::SystemTime, PathBuf)>,
    accounting_valid: bool,
    #[cfg(test)]
    reconciliation_scans: u64,
    #[cfg(test)]
    injected_remove_failure: bool,
}

#[derive(Debug, Clone, Copy)]
struct DerivedDiskScopeUsage {
    bytes: u64,
    entries: u64,
    last_modified: std::time::SystemTime,
}

struct DerivedDiskRootLedger {
    total_bytes: u64,
    total_entries: u64,
    scopes: HashMap<PathBuf, DerivedDiskScopeUsage>,
    oldest_scopes: BTreeSet<(std::time::SystemTime, PathBuf)>,
}
#[derive(Clone)]
pub struct GeneratedReadyBytes {
    bytes: Arc<Vec<u8>>,
    _reservation: Arc<MemoryReservation>,
}

impl std::fmt::Debug for GeneratedReadyBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GeneratedReadyBytes")
            .field("len", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl std::ops::Deref for GeneratedReadyBytes {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}

impl GeneratedReadyBytes {
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl PartialEq<Vec<u8>> for GeneratedReadyBytes {
    fn eq(&self, other: &Vec<u8>) -> bool {
        self.bytes.as_slice() == other.as_slice()
    }
}

#[derive(Debug, Clone)]
pub enum DerivedChunkLookup {
    Ready(GeneratedChunkReadHandle),
    Status {
        status: GeneratedChunkStatus,
        failure: Option<FailureDescriptor>,
        message: Option<String>,
    },
}

/// A validated generated-chunk readiness token. Looking up a disk-backed
/// chunk only probes its metadata; the payload is not read or charged to the
/// resident-memory budget until the caller has admitted the response to its
/// transport budget and invokes [`Self::read`].
#[derive(Clone)]
pub struct GeneratedChunkReadHandle {
    payload_len: usize,
    source: GeneratedChunkReadSource,
}

#[derive(Clone)]
enum GeneratedChunkReadSource {
    Resident(GeneratedReadyBytes),
    Disk {
        state: Arc<Mutex<DerivedChunkState>>,
        disk: Arc<DerivedDiskCache>,
        resident: Arc<SharedObjectCache>,
        level_identity: String,
        image_id: ImageId,
        level_index: u32,
        key: String,
        expected_bytes: u64,
    },
    #[cfg(test)]
    PanicForTest,
}

impl std::fmt::Debug for GeneratedChunkReadHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let storage = match self.source {
            GeneratedChunkReadSource::Resident(_) => DerivedCacheStorage::Memory,
            GeneratedChunkReadSource::Disk { .. } => DerivedCacheStorage::Disk,
            #[cfg(test)]
            GeneratedChunkReadSource::PanicForTest => DerivedCacheStorage::Memory,
        };
        f.debug_struct("GeneratedChunkReadHandle")
            .field("payload_len", &self.payload_len)
            .field("storage", &storage)
            .finish_non_exhaustive()
    }
}

impl GeneratedChunkReadHandle {
    pub fn len(&self) -> usize {
        self.payload_len
    }

    pub fn is_empty(&self) -> bool {
        self.payload_len == 0
    }

    /// Read without blocking an async executor on filesystem I/O. Resident
    /// handles complete inline; only disk-backed work is dispatched to the
    /// blocking pool. The outer result reports a blocking-worker failure and
    /// the inner result reports the payload read itself.
    pub async fn read_async(
        self,
    ) -> Result<io::Result<Option<GeneratedReadyBytes>>, tokio::task::JoinError> {
        if matches!(&self.source, GeneratedChunkReadSource::Resident(_)) {
            return Ok(self.read());
        }
        tokio::task::spawn_blocking(move || self.read()).await
    }

    /// Materialize the payload after the caller has reserved its downstream
    /// capacity. `None` means the probed disk entry disappeared or its level
    /// identity was superseded before the read completed.
    pub fn read(self) -> io::Result<Option<GeneratedReadyBytes>> {
        match self.source {
            GeneratedChunkReadSource::Resident(bytes) => Ok(Some(bytes)),
            GeneratedChunkReadSource::Disk {
                state,
                disk,
                resident,
                level_identity,
                image_id,
                level_index,
                key,
                expected_bytes,
            } => {
                if !generated_identity_matches(
                    &state,
                    &level_identity,
                    &image_id,
                    level_index,
                    expected_bytes,
                ) {
                    return Ok(None);
                }
                let path = disk.chunk_path(&level_identity, &image_id, level_index, &key);
                let mut file = match File::open(path) {
                    Ok(file) => file,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                    Err(error) => return Err(error),
                };
                let reservation = resident
                    .reserve_resident(MemoryCategory::GeneratedReady, self.payload_len)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::OutOfMemory,
                            "process memory budget is full for generated chunk read",
                        )
                    })?;
                let mut bytes = Vec::new();
                bytes.try_reserve_exact(self.payload_len).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::OutOfMemory,
                        "generated chunk payload allocation failed",
                    )
                })?;
                bytes.resize(self.payload_len, 0);
                #[cfg(test)]
                {
                    disk.payload_buffer_high_water
                        .fetch_max(bytes.len(), Ordering::Relaxed);
                    disk.payload_read_attempts.fetch_add(1, Ordering::Relaxed);
                }
                file.read_exact(&mut bytes).map_err(|error| {
                    if error.kind() == io::ErrorKind::UnexpectedEof {
                        io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "generated chunk shrank while it was being read",
                        )
                    } else {
                        error
                    }
                })?;
                let mut extra = [0_u8; 1];
                match file.read_exact(&mut extra) {
                    Ok(()) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "generated chunk grew while it was being read",
                        ));
                    }
                    Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {}
                    Err(error) => return Err(error),
                }
                if !generated_identity_matches(
                    &state,
                    &level_identity,
                    &image_id,
                    level_index,
                    expected_bytes,
                ) {
                    return Ok(None);
                }
                Ok(Some(GeneratedReadyBytes {
                    bytes: Arc::new(bytes),
                    _reservation: Arc::new(reservation),
                }))
            }
            #[cfg(test)]
            GeneratedChunkReadSource::PanicForTest => {
                panic!("injected generated chunk blocking-read panic")
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn panicking_for_test(payload_len: usize) -> Self {
        Self {
            payload_len,
            source: GeneratedChunkReadSource::PanicForTest,
        }
    }
}

fn generated_identity_matches(
    state: &Arc<Mutex<DerivedChunkState>>,
    level_identity: &str,
    image_id: &ImageId,
    level_index: u32,
    expected_bytes: u64,
) -> bool {
    let state = state.lock().unwrap();
    state
        .level_identities
        .get(&(image_id.clone(), level_index))
        .is_some_and(|current| current == level_identity)
        && state
            .level_expected_chunk_bytes
            .get(&(image_id.clone(), level_index))
            .is_some_and(|current| *current == expected_bytes)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DerivedChunkKey {
    image_id: ImageId,
    level_index: u32,
    key: String,
}

#[derive(Debug, Clone, Copy)]
enum GeneratedStatusKind {
    Level,
    Chunk,
}

/// One cardinality budget shared by every generated cache owned by a
/// workspace manager. The protocol ceilings are aggregate runtime ceilings:
/// multiplying them by the number of dataset bindings would defeat the
/// allocation bound.
#[derive(Debug)]
pub(crate) struct GeneratedStatusBudget {
    level_entries: AtomicUsize,
    chunk_entries: AtomicUsize,
    max_level_entries: usize,
    max_chunk_entries: usize,
}

impl GeneratedStatusBudget {
    pub(crate) fn runtime() -> Arc<Self> {
        static PROCESS_BUDGET: OnceLock<Arc<GeneratedStatusBudget>> = OnceLock::new();
        Arc::clone(PROCESS_BUDGET.get_or_init(|| {
            Self::with_limits(
                lucida_protocol::MAX_GENERATED_RUNTIME_LEVELS,
                lucida_protocol::MAX_GENERATED_RUNTIME_CHUNKS,
            )
        }))
    }

    pub(crate) fn with_limits(max_level_entries: usize, max_chunk_entries: usize) -> Arc<Self> {
        Arc::new(Self {
            level_entries: AtomicUsize::new(0),
            chunk_entries: AtomicUsize::new(0),
            max_level_entries,
            max_chunk_entries,
        })
    }

    fn try_acquire(self: &Arc<Self>, kind: GeneratedStatusKind) -> Option<GeneratedStatusPermit> {
        let (counter, limit) = match kind {
            GeneratedStatusKind::Level => (&self.level_entries, self.max_level_entries),
            GeneratedStatusKind::Chunk => (&self.chunk_entries, self.max_chunk_entries),
        };
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(1).filter(|next| *next <= limit)
            })
            .ok()?;
        Some(GeneratedStatusPermit {
            budget: Arc::clone(self),
            kind,
        })
    }

    #[cfg(test)]
    pub(super) fn counts(&self) -> (usize, usize) {
        (
            self.level_entries.load(Ordering::Acquire),
            self.chunk_entries.load(Ordering::Acquire),
        )
    }
}

#[derive(Debug)]
struct GeneratedStatusPermit {
    budget: Arc<GeneratedStatusBudget>,
    kind: GeneratedStatusKind,
}

impl Drop for GeneratedStatusPermit {
    fn drop(&mut self) {
        let counter = match self.kind {
            GeneratedStatusKind::Level => &self.budget.level_entries,
            GeneratedStatusKind::Chunk => &self.budget.chunk_entries,
        };
        let previous = counter.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "generated status budget underflow");
    }
}

#[derive(Debug, Default)]
pub(super) struct DerivedChunkState {
    pub(super) availability: GeneratedAvailabilityIndex,
    ready_bytes: HashMap<DerivedChunkKey, GeneratedReadyBytes>,
    pub(super) level_identities: HashMap<(ImageId, u32), String>,
    level_expected_chunk_bytes: HashMap<(ImageId, u32), u64>,
    level_status_permits: HashMap<(ImageId, u32), GeneratedStatusPermit>,
    chunk_status_permits: HashMap<DerivedChunkKey, GeneratedStatusPermit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedCacheTelemetry {
    pub storage: DerivedCacheStorage,
    pub bytes: u64,
    pub budget_bytes: Option<u64>,
    /// Persistent filesystem entries (files plus directories) charged to the
    /// shared generated-cache root.
    pub entries: u64,
    pub entry_budget: Option<u64>,
    pub root_dir: Option<PathBuf>,
    pub evictions: u64,
    pub accounting_healthy: bool,
}

impl Default for DerivedCacheTelemetry {
    fn default() -> Self {
        Self {
            storage: DerivedCacheStorage::Memory,
            bytes: 0,
            budget_bytes: None,
            entries: 0,
            entry_budget: None,
            root_dir: None,
            evictions: 0,
            accounting_healthy: true,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DerivedCacheStorage {
    #[default]
    Memory,
    Disk,
}

#[derive(Debug)]
pub(super) struct DerivedDiskCache {
    root_dir: PathBuf,
    source_scope: PathBuf,
    root_quota: Arc<DerivedDiskRootQuota>,
    tmp_counter: AtomicU64,
    maintenance_tx: Option<SyncSender<DiskMaintenanceCommand>>,
    maintenance_dropped: AtomicU64,
    #[cfg(test)]
    payload_read_attempts: AtomicU64,
    #[cfg(test)]
    payload_buffer_high_water: AtomicUsize,
}

#[derive(Debug)]
enum DiskMaintenanceCommand {
    Status {
        level_identity: String,
        update: GeneratedChunkStatusUpdate,
    },
    #[cfg(test)]
    Barrier(oneshot::Sender<()>),
    Checkpoint {
        indexes: Vec<ReadinessCheckpoint>,
        max_serialized_bytes: usize,
        done: oneshot::Sender<io::Result<()>>,
    },
}

#[derive(Debug)]
struct ReadinessCheckpoint {
    level_identity: String,
    chunks: Vec<GeneratedChunkStatusUpdate>,
}

fn shared_disk_root_quota(
    root_dir: &std::path::Path,
    requested_budget: Option<u64>,
    requested_entry_budget: u64,
) -> Arc<DerivedDiskRootQuota> {
    // Keep the invariant at the coordinator boundary so every current or
    // future disk constructor gets a finite ceiling. `None` is compatibility
    // syntax for the explicit process default, never an unbounded mode.
    let requested_budget =
        Some(requested_budget.unwrap_or(crate::DEFAULT_GENERATED_DISK_BUDGET_BYTES));
    static ROOT_QUOTAS: OnceLock<Mutex<HashMap<PathBuf, Weak<DerivedDiskRootQuota>>>> =
        OnceLock::new();

    let key = fs::canonicalize(root_dir).unwrap_or_else(|_| root_dir.to_path_buf());
    let mut quotas = ROOT_QUOTAS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    quotas.retain(|_, quota| quota.strong_count() > 0);
    if let Some(existing) = quotas.get(&key).and_then(Weak::upgrade) {
        existing.tighten_limits(requested_budget, requested_entry_budget);
        return existing;
    }

    let quota = Arc::new(DerivedDiskRootQuota::initialize(
        key.clone(),
        requested_budget,
        requested_entry_budget,
    ));
    quotas.insert(key, Arc::downgrade(&quota));
    quota
}

impl DerivedDiskRootQuota {
    fn initialize(root_dir: PathBuf, budget_bytes: Option<u64>, entry_budget: u64) -> Self {
        let (total_bytes, total_entries, scopes, oldest_scopes, accounting_valid) =
            match scan_disk_root(&root_dir) {
                Ok(ledger) => (
                    ledger.total_bytes,
                    ledger.total_entries,
                    ledger.scopes,
                    ledger.oldest_scopes,
                    true,
                ),
                Err(error) => {
                    tracing::warn!(
                        root = %root_dir.display(),
                        error = %error,
                        "generated coarse root accounting initialization failed"
                    );
                    (0, 0, HashMap::new(), BTreeSet::new(), false)
                }
            };
        Self {
            root_dir,
            state: Mutex::new(DerivedDiskRootQuotaState {
                budget_bytes,
                entry_budget,
                evictions: 0,
                total_bytes,
                total_entries,
                reserved_bytes: 0,
                reserved_entries: 0,
                scopes,
                oldest_scopes,
                accounting_valid,
                #[cfg(test)]
                reconciliation_scans: 1,
                #[cfg(test)]
                injected_remove_failure: false,
            }),
        }
    }

    /// Multiple cache instances share one root coordinator. If conflicting
    /// budgets are accidentally supplied for the same root, the stricter
    /// value wins so a later constructor cannot silently relax the process
    /// ceiling.
    fn tighten_limits(&self, requested: Option<u64>, requested_entries: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.budget_bytes = match (state.budget_bytes, requested) {
            (Some(current), Some(requested)) => Some(current.min(requested)),
            (None, Some(requested)) => Some(requested),
            (current, None) => current,
        };
        state.entry_budget = state.entry_budget.min(requested_entries);
    }

    /// Serialize cache-root mutations, reserve the atomic writer's temporary
    /// allocation before it reaches disk, and update the initialized ledger by
    /// the exact replaced-file delta. Filesystem traversal is reserved for
    /// initialization or an explicit reconciliation, never the write path.
    fn mutate_file<T>(
        &self,
        scope: &std::path::Path,
        path: &std::path::Path,
        write_len: usize,
        mutation: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.accounting_valid {
            return Err(io::Error::other(
                "generated cache root accounting is unavailable",
            ));
        }

        // A scope removed outside this coordinator is treated as an explicit
        // whole-scope deletion. Other out-of-process changes require callers
        // to invoke reconciliation rather than making every write rescan.
        if !scope.exists() {
            remove_scope_from_ledger(&mut state, scope);
        }
        let old_file = path_resource_usage(path)?;
        let ancestors = ancestor_paths_under(path, &self.root_dir)?;
        let old_ancestors = resource_usage_for_paths(&ancestors)?;
        let reservation = atomic_write_reservation(
            &self.root_dir,
            write_len,
            ancestors.len(),
            old_ancestors.entries,
        )?;
        self.pre_evict_for_reservation_locked(&mut state, scope, reservation)?;
        let pending = PendingDiskMutation::new(state, reservation)?;
        let result = match mutation() {
            Ok(result) => result,
            Err(mutation_error) => {
                let mut state = pending.finish();
                // The atomic writer normally removes its temporary file via
                // RAII. If cleanup itself fails, or the destination rename
                // succeeded before a directory-sync error, rebuild the root
                // ledger while the mutation lock is still held so no bytes can
                // remain outside quota accounting.
                if let Err(reconcile_error) = self.reconcile_locked(&mut state) {
                    return Err(io::Error::new(
                        mutation_error.kind(),
                        format!(
                            "{mutation_error}; generated cache accounting reconciliation failed: {reconcile_error}"
                        ),
                    ));
                }
                return Err(mutation_error);
            }
        };
        let mut state = pending.finish();
        let (new_file, new_ancestors) = match (
            path_resource_usage(path),
            resource_usage_for_paths(&ancestors),
        ) {
            (Ok(file), Ok(ancestors)) => (file, ancestors),
            (file, ancestors) => {
                let accounting_error = file.err().or_else(|| ancestors.err()).expect("error arm");
                if let Err(reconcile_error) = self.reconcile_locked(&mut state) {
                    return Err(io::Error::new(
                        accounting_error.kind(),
                        format!(
                            "{accounting_error}; generated cache accounting reconciliation failed: {reconcile_error}"
                        ),
                    ));
                }
                return Err(accounting_error);
            }
        };
        update_scope_after_write(
            &mut state,
            scope,
            old_file,
            new_file,
            old_ancestors,
            new_ancestors,
        );
        self.enforce_locked(&mut state)?;
        Ok(result)
    }

    fn pre_evict_for_reservation_locked(
        &self,
        state: &mut DerivedDiskRootQuotaState,
        protected_scope: &std::path::Path,
        reservation: DiskResourceUsage,
    ) -> io::Result<()> {
        let over_limit = |state: &DerivedDiskRootQuotaState| {
            state.budget_bytes.is_some_and(|budget| {
                state
                    .total_bytes
                    .saturating_add(state.reserved_bytes)
                    .saturating_add(reservation.bytes)
                    > budget
            }) || state
                .total_entries
                .saturating_add(state.reserved_entries)
                .saturating_add(reservation.entries)
                > state.entry_budget
        };

        while over_limit(state) {
            // Never reclaim the scope whose destination must remain available
            // until rename commits. If other scopes cannot make enough room,
            // fail before creating the temp file and preserve the old bytes.
            let candidate = state
                .oldest_scopes
                .iter()
                .find(|(_, path)| path != protected_scope)
                .cloned();
            let Some((modified, path)) = candidate else {
                return Err(io::Error::other(
                    "generated cache atomic write cannot admit its temporary allocation within the root quota",
                ));
            };
            let usage = state
                .scopes
                .get(&path)
                .copied()
                .unwrap_or(DerivedDiskScopeUsage {
                    bytes: 0,
                    entries: 0,
                    last_modified: modified,
                });
            #[cfg(test)]
            if state.injected_remove_failure {
                state.accounting_valid = false;
                return Err(io::Error::other(
                    "injected generated cache scope deletion failure",
                ));
            }
            match fs::remove_dir_all(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    state.accounting_valid = false;
                    return Err(error);
                }
            }
            state.oldest_scopes.remove(&(modified, path.clone()));
            state.scopes.remove(&path);
            state.total_bytes = state.total_bytes.saturating_sub(usage.bytes);
            state.total_entries = state.total_entries.saturating_sub(usage.entries);
            state.evictions = state.evictions.saturating_add(1);
        }
        Ok(())
    }

    fn reconcile_locked(&self, state: &mut DerivedDiskRootQuotaState) -> io::Result<()> {
        #[cfg(test)]
        {
            state.reconciliation_scans = state.reconciliation_scans.saturating_add(1);
        }
        match scan_disk_root(&self.root_dir) {
            Ok(ledger) => {
                state.total_bytes = ledger.total_bytes;
                state.total_entries = ledger.total_entries;
                state.scopes = ledger.scopes;
                state.oldest_scopes = ledger.oldest_scopes;
                state.accounting_valid = true;
                self.enforce_locked(state)
            }
            Err(error) => {
                state.accounting_valid = false;
                Err(error)
            }
        }
    }

    fn enforce(&self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.enforce_locked(&mut state)
    }

    fn reconcile(&self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reconcile_locked(&mut state)
    }

    fn enforce_locked(&self, state: &mut DerivedDiskRootQuotaState) -> io::Result<()> {
        if !state.accounting_valid {
            return Err(io::Error::other(
                "generated cache root accounting is unavailable",
            ));
        }
        let result = (|| {
            let over_limit = |state: &DerivedDiskRootQuotaState| {
                state
                    .budget_bytes
                    .is_some_and(|budget| state.total_bytes > budget)
                    || state.total_entries > state.entry_budget
            };
            while over_limit(state) {
                let Some((modified, path)) = state.oldest_scopes.first().cloned() else {
                    break;
                };
                let bytes = state.scopes.get(&path).map_or(0, |scope| scope.bytes);
                let entries = state.scopes.get(&path).map_or(0, |scope| scope.entries);
                #[cfg(test)]
                if state.injected_remove_failure {
                    return Err(io::Error::other(
                        "injected generated cache scope deletion failure",
                    ));
                }
                match fs::remove_dir_all(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                state.oldest_scopes.remove(&(modified, path.clone()));
                state.scopes.remove(&path);
                state.total_bytes = state.total_bytes.saturating_sub(bytes);
                state.total_entries = state.total_entries.saturating_sub(entries);
                state.evictions = state.evictions.saturating_add(1);
            }
            if over_limit(state) {
                return Err(io::Error::other(
                    "generated cache root contains unscoped resources above its budget",
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            // A failed eviction leaves durable bytes above the configured
            // ceiling. Latch the coordinator unhealthy so no later mutation
            // can add more bytes until an explicit reconciliation succeeds.
            state.accounting_valid = false;
        }
        result
    }

    fn telemetry(&self) -> DerivedCacheTelemetry {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        DerivedCacheTelemetry {
            storage: DerivedCacheStorage::Disk,
            bytes: state.total_bytes,
            budget_bytes: state.budget_bytes,
            entries: state.total_entries,
            entry_budget: Some(state.entry_budget),
            root_dir: Some(self.root_dir.clone()),
            evictions: state.evictions,
            accounting_healthy: state.accounting_valid,
        }
    }

    #[cfg(test)]
    fn reconciliation_scans(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reconciliation_scans
    }

    #[cfg(test)]
    fn inject_persistent_remove_failure(&self) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .injected_remove_failure = true;
    }

    #[cfg(test)]
    fn clear_injected_remove_failure(&self) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .injected_remove_failure = false;
    }
}

fn scan_disk_root(root_dir: &std::path::Path) -> io::Result<DerivedDiskRootLedger> {
    let mut total_bytes = 0_u64;
    let mut total_entries = 0_u64;
    let mut scopes = HashMap::new();
    let mut oldest_scopes = BTreeSet::new();
    let entries = match fs::read_dir(root_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DerivedDiskRootLedger {
                total_bytes,
                total_entries,
                scopes,
                oldest_scopes,
            });
        }
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            let path = entry.path();
            let mut usage = metadata_resource_usage(&metadata);
            let (children, child_modified) = dir_resource_usage_and_latest_modified(&path)?;
            usage = usage.saturating_add(children);
            let last_modified = metadata
                .modified()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                .max(child_modified);
            total_bytes = total_bytes.saturating_add(usage.bytes);
            total_entries = total_entries.saturating_add(usage.entries);
            scopes.insert(
                path.clone(),
                DerivedDiskScopeUsage {
                    bytes: usage.bytes,
                    entries: usage.entries,
                    last_modified,
                },
            );
            oldest_scopes.insert((last_modified, path));
        } else {
            let usage = metadata_resource_usage(&metadata);
            total_bytes = total_bytes.saturating_add(usage.bytes);
            total_entries = total_entries.saturating_add(usage.entries);
        }
    }
    Ok(DerivedDiskRootLedger {
        total_bytes,
        total_entries,
        scopes,
        oldest_scopes,
    })
}

#[cfg(test)]
pub(super) fn disk_resource_usage_for_test(root_dir: &std::path::Path) -> io::Result<(u64, u64)> {
    let ledger = scan_disk_root(root_dir)?;
    Ok((ledger.total_bytes, ledger.total_entries))
}

#[cfg(test)]
pub(super) fn initialized_disk_telemetry_for_test(
    root_dir: &std::path::Path,
    byte_budget: u64,
    entry_budget: u64,
) -> DerivedCacheTelemetry {
    DerivedDiskRootQuota::initialize(
        fs::canonicalize(root_dir).unwrap_or_else(|_| root_dir.to_path_buf()),
        Some(byte_budget),
        entry_budget,
    )
    .telemetry()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DiskResourceUsage {
    bytes: u64,
    entries: u64,
}

struct PendingDiskMutation<'a> {
    state: Option<std::sync::MutexGuard<'a, DerivedDiskRootQuotaState>>,
    reservation: DiskResourceUsage,
}

impl<'a> PendingDiskMutation<'a> {
    fn new(
        mut state: std::sync::MutexGuard<'a, DerivedDiskRootQuotaState>,
        reservation: DiskResourceUsage,
    ) -> io::Result<Self> {
        let reserved_bytes = state
            .reserved_bytes
            .checked_add(reservation.bytes)
            .ok_or_else(|| io::Error::other("generated cache byte reservation overflow"))?;
        let reserved_entries = state
            .reserved_entries
            .checked_add(reservation.entries)
            .ok_or_else(|| io::Error::other("generated cache entry reservation overflow"))?;
        state.reserved_bytes = reserved_bytes;
        state.reserved_entries = reserved_entries;
        Ok(Self {
            state: Some(state),
            reservation,
        })
    }

    fn finish(mut self) -> std::sync::MutexGuard<'a, DerivedDiskRootQuotaState> {
        let mut state = self.state.take().expect("pending disk mutation owns state");
        release_disk_reservation(&mut state, self.reservation);
        state
    }
}

impl Drop for PendingDiskMutation<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.state.as_deref_mut() {
            release_disk_reservation(state, self.reservation);
        }
    }
}

fn release_disk_reservation(state: &mut DerivedDiskRootQuotaState, reservation: DiskResourceUsage) {
    state.reserved_bytes = state.reserved_bytes.saturating_sub(reservation.bytes);
    state.reserved_entries = state.reserved_entries.saturating_sub(reservation.entries);
}

impl DiskResourceUsage {
    fn saturating_add(self, other: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_add(other.bytes),
            entries: self.entries.saturating_add(other.entries),
        }
    }
}

fn atomic_write_reservation(
    root_dir: &std::path::Path,
    write_len: usize,
    ancestor_count: usize,
    existing_ancestor_count: u64,
) -> io::Result<DiskResourceUsage> {
    const PORTABLE_MIN_ALLOCATION_BYTES: u64 = 4 * 1024;
    #[cfg(unix)]
    let allocation_unit = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(root_dir)
            .map(|metadata| metadata.blksize())
            .unwrap_or(PORTABLE_MIN_ALLOCATION_BYTES)
            .max(PORTABLE_MIN_ALLOCATION_BYTES)
    };
    #[cfg(not(unix))]
    let allocation_unit = PORTABLE_MIN_ALLOCATION_BYTES;
    let write_len = u64::try_from(write_len).unwrap_or(u64::MAX);
    let rounded_file = (write_len.saturating_add(allocation_unit.saturating_sub(1))
        / allocation_unit)
        .saturating_mul(allocation_unit);
    let missing_ancestors = u64::try_from(ancestor_count)
        .unwrap_or(u64::MAX)
        .saturating_sub(existing_ancestor_count);
    Ok(DiskResourceUsage {
        // One allocation unit of file slack covers extent rounding, and one
        // covers growth of the parent directory while the extra temp entry is
        // live. Missing directories are charged independently.
        bytes: rounded_file
            .max(allocation_unit)
            .saturating_add(allocation_unit)
            .saturating_add(allocation_unit)
            .saturating_add(missing_ancestors.saturating_mul(allocation_unit)),
        entries: 1_u64.saturating_add(missing_ancestors),
    })
}

#[cfg(test)]
pub(super) fn atomic_write_reservation_for_test(
    root_dir: &std::path::Path,
    path: &std::path::Path,
    write_len: usize,
) -> io::Result<(u64, u64)> {
    let ancestors = ancestor_paths_under(path, root_dir)?;
    let existing = resource_usage_for_paths(&ancestors)?;
    let reservation =
        atomic_write_reservation(root_dir, write_len, ancestors.len(), existing.entries)?;
    Ok((reservation.bytes, reservation.entries))
}

#[cfg(test)]
pub(super) fn path_resource_usage_for_test(path: &std::path::Path) -> io::Result<(u64, u64)> {
    let usage = path_resource_usage(path)?;
    Ok((usage.bytes, usage.entries))
}

fn metadata_resource_usage(metadata: &fs::Metadata) -> DiskResourceUsage {
    const PORTABLE_MIN_ALLOCATION_BYTES: u64 = 4 * 1024;
    #[cfg(unix)]
    let allocated = {
        use std::os::unix::fs::MetadataExt;
        metadata.blocks().saturating_mul(512)
    };
    #[cfg(not(unix))]
    let allocated = 0;
    DiskResourceUsage {
        // `len` makes sparse files conservative; allocated blocks makes small
        // files and filesystem metadata truthful on Unix. The minimum is the
        // portable fallback where allocation data is unavailable.
        bytes: allocated
            .max(metadata.len())
            .max(PORTABLE_MIN_ALLOCATION_BYTES),
        entries: 1,
    }
}

fn path_resource_usage(path: &std::path::Path) -> io::Result<DiskResourceUsage> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata_resource_usage(&metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DiskResourceUsage::default()),
        Err(error) => Err(error),
    }
}

fn ancestor_paths_under(
    path: &std::path::Path,
    root_dir: &std::path::Path,
) -> io::Result<Vec<PathBuf>> {
    if !path.starts_with(root_dir) {
        return Err(io::Error::other(
            "generated cache mutation escaped its quota root",
        ));
    }
    let mut ancestors = Vec::new();
    let mut current = path.parent();
    while let Some(directory) = current {
        if directory == root_dir {
            break;
        }
        ancestors.push(directory.to_path_buf());
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(io::Error::other(
                    "generated cache mutation ancestor is not a directory",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        current = directory.parent();
    }
    Ok(ancestors)
}

fn resource_usage_for_paths(paths: &[PathBuf]) -> io::Result<DiskResourceUsage> {
    let mut usage = DiskResourceUsage::default();
    for path in paths {
        usage = usage.saturating_add(path_resource_usage(path)?);
    }
    Ok(usage)
}

fn dir_resource_usage_and_latest_modified(
    path: &std::path::Path,
) -> io::Result<(DiskResourceUsage, std::time::SystemTime)> {
    let mut usage = DiskResourceUsage::default();
    let mut latest = std::time::SystemTime::UNIX_EPOCH;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((usage, latest)),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        latest = latest.max(
            metadata
                .modified()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        );
        usage = usage.saturating_add(metadata_resource_usage(&metadata));
        if metadata.is_dir() {
            let (children, child_modified) = dir_resource_usage_and_latest_modified(&entry.path())?;
            usage = usage.saturating_add(children);
            latest = latest.max(child_modified);
        }
    }
    Ok((usage, latest))
}

fn remove_scope_from_ledger(state: &mut DerivedDiskRootQuotaState, scope: &std::path::Path) {
    if let Some(previous) = state.scopes.remove(scope) {
        state
            .oldest_scopes
            .remove(&(previous.last_modified, scope.to_path_buf()));
        state.total_bytes = state.total_bytes.saturating_sub(previous.bytes);
        state.total_entries = state.total_entries.saturating_sub(previous.entries);
    }
}

fn update_scope_after_write(
    state: &mut DerivedDiskRootQuotaState,
    scope: &std::path::Path,
    old_file: DiskResourceUsage,
    new_file: DiskResourceUsage,
    old_ancestors: DiskResourceUsage,
    new_ancestors: DiskResourceUsage,
) {
    let scope_path = scope.to_path_buf();
    let previous = state.scopes.remove(&scope_path);
    if let Some(previous) = previous {
        state
            .oldest_scopes
            .remove(&(previous.last_modified, scope_path.clone()));
    }
    let previous_scope_bytes = previous.map_or(0, |usage| usage.bytes);
    let previous_scope_entries = previous.map_or(0, |usage| usage.entries);
    let bytes = previous_scope_bytes
        .saturating_sub(old_file.bytes)
        .saturating_sub(old_ancestors.bytes)
        .saturating_add(new_file.bytes)
        .saturating_add(new_ancestors.bytes);
    let entries = previous_scope_entries
        .saturating_sub(old_file.entries)
        .saturating_sub(old_ancestors.entries)
        .saturating_add(new_file.entries)
        .saturating_add(new_ancestors.entries);
    let last_modified = std::time::SystemTime::now();
    state.total_bytes = state
        .total_bytes
        .saturating_sub(old_file.bytes)
        .saturating_sub(old_ancestors.bytes)
        .saturating_add(new_file.bytes)
        .saturating_add(new_ancestors.bytes);
    state.total_entries = state
        .total_entries
        .saturating_sub(old_file.entries)
        .saturating_sub(old_ancestors.entries)
        .saturating_add(new_file.entries)
        .saturating_add(new_ancestors.entries);
    state.scopes.insert(
        scope_path.clone(),
        DerivedDiskScopeUsage {
            bytes,
            entries,
            last_modified,
        },
    );
    state.oldest_scopes.insert((last_modified, scope_path));
}

/// In-memory runtime registry for generated levels and seeded fake chunks.
///
/// Durable cache materialization lands in the next slice. This registry still
/// gives the server a source-aware resolver contract now: generated level keys
/// do not hit source storage, and unready generated chunks return explicit
/// statuses instead of disappearing as timeouts.
#[derive(Debug, Clone)]
pub struct DerivedChunkCache {
    pub(super) inner: Arc<Mutex<DerivedChunkState>>,
    pub(super) disk: Option<Arc<DerivedDiskCache>>,
    pub(super) resident: Arc<SharedObjectCache>,
    pub(super) status_budget: Arc<GeneratedStatusBudget>,
}

impl Default for DerivedChunkCache {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(DerivedChunkState::default())),
            disk: None,
            resident: SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024),
            status_budget: GeneratedStatusBudget::runtime(),
        }
    }
}

impl DerivedChunkCache {
    pub fn new(snapshot: GeneratedAvailabilitySnapshot) -> Self {
        let cache = Self::default();
        cache.replace_snapshot(snapshot);
        cache
    }

    #[cfg(test)]
    pub(crate) fn new_with_status_budget(
        snapshot: GeneratedAvailabilitySnapshot,
        status_budget: Arc<GeneratedStatusBudget>,
    ) -> Self {
        let cache = Self {
            status_budget,
            ..Self::default()
        };
        cache.replace_snapshot(snapshot);
        cache
    }

    pub fn new_on_disk(root_dir: PathBuf, url_hash: [u8; 16]) -> Self {
        Self::new_on_disk_with_budget(
            root_dir,
            url_hash,
            Some(crate::DEFAULT_GENERATED_DISK_BUDGET_BYTES),
        )
    }

    pub fn new_on_disk_with_budget(
        root_dir: PathBuf,
        url_hash: [u8; 16],
        disk_budget_bytes: Option<u64>,
    ) -> Self {
        Self::new_on_disk_with_budgets(
            root_dir,
            url_hash,
            disk_budget_bytes,
            SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024),
        )
    }

    pub fn new_on_disk_with_budgets(
        root_dir: PathBuf,
        url_hash: [u8; 16],
        disk_budget_bytes: Option<u64>,
        resident: Arc<SharedObjectCache>,
    ) -> Self {
        Self::new_on_disk_scoped(
            root_dir,
            PathBuf::from(hex16(&url_hash)),
            disk_budget_bytes,
            resident,
            GeneratedStatusBudget::runtime(),
        )
    }

    #[cfg(test)]
    pub(crate) fn new_on_disk_with_resource_budgets(
        root_dir: PathBuf,
        url_hash: [u8; 16],
        disk_budget_bytes: Option<u64>,
        resident: Arc<SharedObjectCache>,
        status_budget: Arc<GeneratedStatusBudget>,
    ) -> Self {
        Self::new_on_disk_scoped(
            root_dir,
            PathBuf::from(hex16(&url_hash)),
            disk_budget_bytes,
            resident,
            status_budget,
        )
    }

    /// Production constructor. The full locator digest prevents truncated-id
    /// collisions and the revision directory makes in-place mutation a clean
    /// cache miss without deleting another live generation.
    pub fn new_on_disk_for_source(
        root_dir: PathBuf,
        source: &SourceVersion,
        disk_budget_bytes: Option<u64>,
        resident: Arc<SharedObjectCache>,
    ) -> Self {
        Self::new_on_disk_scoped(
            root_dir,
            PathBuf::from(source.identity.digest_hex()).join(source.revision.as_hex()),
            disk_budget_bytes,
            resident,
            GeneratedStatusBudget::runtime(),
        )
    }

    pub(crate) fn new_on_disk_for_source_with_status_budget(
        root_dir: PathBuf,
        source: &SourceVersion,
        disk_budget_bytes: u64,
        resident: Arc<SharedObjectCache>,
        status_budget: Arc<GeneratedStatusBudget>,
    ) -> Self {
        Self::new_on_disk_scoped(
            root_dir,
            PathBuf::from(source.identity.digest_hex()).join(source.revision.as_hex()),
            Some(disk_budget_bytes),
            resident,
            status_budget,
        )
    }

    fn new_on_disk_scoped(
        root_dir: PathBuf,
        source_scope: PathBuf,
        disk_budget_bytes: Option<u64>,
        resident: Arc<SharedObjectCache>,
        status_budget: Arc<GeneratedStatusBudget>,
    ) -> Self {
        Self::new_on_disk_scoped_with_entry_budget(
            root_dir,
            source_scope,
            disk_budget_bytes,
            crate::DEFAULT_GENERATED_DISK_ENTRY_BUDGET,
            resident,
            status_budget,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_on_disk_with_entry_budget_for_test(
        root_dir: PathBuf,
        url_hash: [u8; 16],
        disk_budget_bytes: u64,
        entry_budget: u64,
    ) -> Self {
        Self::new_on_disk_scoped_with_entry_budget(
            root_dir,
            PathBuf::from(hex16(&url_hash)),
            Some(disk_budget_bytes),
            entry_budget,
            SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024),
            GeneratedStatusBudget::runtime(),
        )
    }

    fn new_on_disk_scoped_with_entry_budget(
        root_dir: PathBuf,
        source_scope: PathBuf,
        disk_budget_bytes: Option<u64>,
        entry_budget: u64,
        resident: Arc<SharedObjectCache>,
        status_budget: Arc<GeneratedStatusBudget>,
    ) -> Self {
        let disk = match fs::create_dir_all(&root_dir) {
            Ok(()) => {
                let root_quota = shared_disk_root_quota(&root_dir, disk_budget_bytes, entry_budget);
                let root_dir = root_quota.root_dir.clone();
                if let Err(error) = root_quota.enforce() {
                    tracing::warn!(
                        root = %root_dir.display(),
                        error = %error,
                        "generated coarse root quota initialization failed"
                    );
                }
                let maintenance_tx = spawn_disk_maintenance_worker(
                    root_dir.clone(),
                    source_scope.clone(),
                    Arc::clone(&root_quota),
                )
                .map_err(|error| {
                    tracing::warn!(
                        error = %error,
                        "generated coarse disk maintenance worker unavailable"
                    );
                    error
                })
                .ok();
                Some(Arc::new(DerivedDiskCache {
                    root_dir,
                    source_scope,
                    root_quota,
                    tmp_counter: AtomicU64::new(0),
                    maintenance_tx,
                    maintenance_dropped: AtomicU64::new(0),
                    #[cfg(test)]
                    payload_read_attempts: AtomicU64::new(0),
                    #[cfg(test)]
                    payload_buffer_high_water: AtomicUsize::new(0),
                }))
            }
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
            resident,
            status_budget,
        }
    }

    pub fn snapshot(&self) -> GeneratedAvailabilitySnapshot {
        self.inner.lock().unwrap().availability.snapshot()
    }

    pub fn replace_snapshot(&self, snapshot: GeneratedAvailabilitySnapshot) {
        let mut state = self.inner.lock().unwrap();
        state.availability = GeneratedAvailabilityIndex::default();
        state.ready_bytes.clear();
        state.level_identities.clear();
        state.level_expected_chunk_bytes.clear();
        state.level_status_permits.clear();
        state.chunk_status_permits.clear();
        self.apply_delta_locked(
            &mut state,
            GeneratedAvailabilityDelta {
                levels: snapshot.levels,
                chunks: snapshot.chunks,
            },
        );
    }

    pub(crate) fn clear_runtime_statuses(&self) {
        self.replace_snapshot(GeneratedAvailabilitySnapshot::default());
    }

    fn apply_delta_locked(
        &self,
        state: &mut DerivedChunkState,
        delta: GeneratedAvailabilityDelta,
    ) -> GeneratedAvailabilityDelta {
        let mut retained = GeneratedAvailabilityDelta::default();
        for level in delta.levels {
            let key = (level.image_id.clone(), level.info.level_index);
            let exists = state
                .availability
                .level(&level.image_id, level.info.level_index)
                .is_some();
            let permit = if exists {
                None
            } else {
                let Some(permit) = self.status_budget.try_acquire(GeneratedStatusKind::Level)
                else {
                    continue;
                };
                Some(permit)
            };
            let stats = state.availability.apply_delta(GeneratedAvailabilityDelta {
                levels: vec![level.clone()],
                chunks: vec![],
            });
            if stats.level_rejections == 0 {
                if let Some(permit) = permit {
                    state.level_status_permits.insert(key, permit);
                }
                retained.levels.push(level);
            }
        }
        for chunk in delta.chunks {
            let key = DerivedChunkKey {
                image_id: chunk.image_id.clone(),
                level_index: chunk.level_index,
                key: chunk.key.clone(),
            };
            let exists = state
                .availability
                .chunk(&chunk.image_id, chunk.level_index, &chunk.key)
                .is_some();
            let permit = if exists {
                None
            } else {
                let Some(permit) = self.status_budget.try_acquire(GeneratedStatusKind::Chunk)
                else {
                    continue;
                };
                Some(permit)
            };
            let stats = state.availability.apply_delta(GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![chunk.clone()],
            });
            if stats.chunk_rejections == 0 {
                if let Some(permit) = permit {
                    state.chunk_status_permits.insert(key, permit);
                }
                retained.chunks.push(chunk);
            }
        }
        retained
    }

    pub fn apply_delta(&self, delta: GeneratedAvailabilityDelta) -> GeneratedAvailabilityDelta {
        let (retained, disk_updates) = {
            let mut state = self.inner.lock().unwrap();
            let retained = self.apply_delta_locked(&mut state, delta);
            let mut disk_updates = Vec::with_capacity(retained.chunks.len());
            for chunk in &retained.chunks {
                let image_id = chunk.image_id.clone();
                let level_index = chunk.level_index;
                if let Some(identity) = state
                    .level_identities
                    .get(&(image_id.clone(), level_index))
                    .cloned()
                {
                    disk_updates.push((identity, chunk.clone()));
                }
                let key = DerivedChunkKey {
                    image_id,
                    level_index,
                    key: chunk.key.clone(),
                };
                if chunk.status != GeneratedChunkStatus::Ready {
                    state.ready_bytes.remove(&key);
                }
            }
            (retained, disk_updates)
        };

        if let Some(disk) = &self.disk {
            for (identity, update) in disk_updates {
                disk.enqueue_status(identity, update);
            }
        }
        retained
    }

    pub fn upsert_level(&self, level: GeneratedLevelAvailability) -> GeneratedAvailabilityDelta {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: vec![],
        })
    }

    pub fn set_chunk_status(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        status: GeneratedChunkStatus,
        message: Option<String>,
    ) -> GeneratedAvailabilityDelta {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id,
                level_index,
                key,
                status,
                failure: status.failure_descriptor(),
                message,
            }],
        })
    }

    pub fn seed_ready_chunk(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) {
        let ready = self.budget_ready_bytes(bytes);
        let mut state = self.inner.lock().unwrap();
        let (status, failure, message) = match ready.as_ref() {
            Ok(_) => (GeneratedChunkStatus::Ready, None, None),
            Err(error) => (
                GeneratedChunkStatus::Unavailable,
                Some(FailureDescriptor::new(FailureCode::ResourceLimit, true)),
                Some(error.to_string()),
            ),
        };
        let update = GeneratedChunkStatusUpdate {
            image_id: image_id.clone(),
            level_index,
            key: key.clone(),
            status,
            failure,
            message: message.clone(),
        };
        let retained_delta = self.apply_delta_locked(
            &mut state,
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![update.clone()],
            },
        );
        let chunk_key = DerivedChunkKey {
            image_id,
            level_index,
            key,
        };
        let retained = !retained_delta.chunks.is_empty();
        match (ready, retained) {
            (Ok(bytes), true) => {
                state.ready_bytes.insert(chunk_key, bytes);
            }
            (Ok(_), false) | (Err(_), _) => {
                state.ready_bytes.remove(&chunk_key);
            }
        }
    }

    pub fn put_ready_chunk_atomic(
        &self,
        level_identity: &str,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) -> io::Result<()> {
        let reservation = self
            .resident
            .reserve_resident(MemoryCategory::GeneratedReady, bytes.len())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::OutOfMemory,
                    "process memory budget is full for generated ready bytes",
                )
            })?;
        self.put_ready_chunk_atomic_reserved(
            level_identity,
            image_id,
            level_index,
            key,
            bytes,
            reservation,
        )
    }

    pub(super) fn put_ready_chunk_atomic_reserved(
        &self,
        level_identity: &str,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
        mut reservation: MemoryReservation,
    ) -> io::Result<()> {
        if reservation.bytes() < bytes.len() {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "generated output exceeded its resident reservation",
            ));
        }
        reservation.shrink_to(bytes.len());
        reservation.reclassify(MemoryCategory::GeneratedReady);
        if let Some(disk) = &self.disk {
            disk.put(level_identity, &image_id, level_index, &key, &bytes)?;
            let mut state = self.inner.lock().unwrap();
            let update = GeneratedChunkStatusUpdate {
                image_id: image_id.clone(),
                level_index,
                key,
                status: GeneratedChunkStatus::Ready,
                failure: None,
                message: None,
            };
            let retained = self.apply_delta_locked(
                &mut state,
                GeneratedAvailabilityDelta {
                    levels: vec![],
                    chunks: vec![update],
                },
            );
            if !retained.chunks.is_empty() {
                let expected_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                state
                    .level_identities
                    .insert((image_id.clone(), level_index), level_identity.to_string());
                state
                    .level_expected_chunk_bytes
                    .entry((image_id, level_index))
                    .or_insert(expected_bytes);
            }
            return Ok(());
        }
        let ready = GeneratedReadyBytes {
            bytes: Arc::new(bytes),
            _reservation: Arc::new(reservation),
        };
        let mut state = self.inner.lock().unwrap();
        let update = GeneratedChunkStatusUpdate {
            image_id: image_id.clone(),
            level_index,
            key: key.clone(),
            status: GeneratedChunkStatus::Ready,
            failure: None,
            message: None,
        };
        let retained = self.apply_delta_locked(
            &mut state,
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![update],
            },
        );
        if !retained.chunks.is_empty() {
            state.ready_bytes.insert(
                DerivedChunkKey {
                    image_id,
                    level_index,
                    key,
                },
                ready,
            );
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "generated status capacity is full for memory-only ready bytes",
            ))
        }
    }

    pub fn load_ready_chunk(
        &self,
        level_identity: &str,
        image_id: ImageId,
        level_index: u32,
        key: String,
        expected_bytes: u64,
    ) -> io::Result<bool> {
        let Some(disk) = &self.disk else {
            return Ok(false);
        };
        if !disk.chunk_file_valid(level_identity, &image_id, level_index, &key, expected_bytes)? {
            return Ok(false);
        }
        let mut state = self.inner.lock().unwrap();
        if state
            .level_expected_chunk_bytes
            .get(&(image_id.clone(), level_index))
            .is_some_and(|registered| *registered != expected_bytes)
        {
            return Ok(false);
        }
        let update = GeneratedChunkStatusUpdate {
            image_id: image_id.clone(),
            level_index,
            key,
            status: GeneratedChunkStatus::Ready,
            failure: None,
            message: None,
        };
        let retained = !self
            .apply_delta_locked(
                &mut state,
                GeneratedAvailabilityDelta {
                    levels: vec![],
                    chunks: vec![update],
                },
            )
            .chunks
            .is_empty();
        if retained {
            state
                .level_identities
                .insert((image_id.clone(), level_index), level_identity.to_string());
            state
                .level_expected_chunk_bytes
                .entry((image_id, level_index))
                .or_insert(expected_bytes);
        }
        Ok(retained)
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

        let retained = self.apply_delta(delta);
        {
            let mut state = self.inner.lock().unwrap();
            if state
                .availability
                .level(&plan.image_id, plan.level_index)
                .is_some()
            {
                state.level_identities.insert(
                    (plan.image_id.clone(), plan.level_index),
                    plan.cache_identity.clone(),
                );
                state.level_expected_chunk_bytes.insert(
                    (plan.image_id.clone(), plan.level_index),
                    expected_generated_chunk_bytes(plan),
                );
            }
        }
        Ok(retained)
    }

    pub async fn persist_readiness_indexes(&self) -> io::Result<()> {
        self.checkpoint_with_timeout(CHECKPOINT_TIMEOUT).await
    }

    pub(super) async fn checkpoint_with_timeout(&self, timeout: Duration) -> io::Result<()> {
        let Some(disk) = &self.disk else {
            return Ok(());
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let indexes = {
            let state = self.inner.lock().unwrap();
            bounded_readiness_checkpoint(&state)
        };
        disk.checkpoint(indexes, deadline).await
    }

    #[cfg(test)]
    pub(super) fn install_stalled_maintenance_worker(
        &mut self,
        stall: Duration,
    ) -> Arc<std::sync::atomic::AtomicBool> {
        let (tx, rx) = sync_channel(1);
        let dequeued = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_dequeued = Arc::clone(&dequeued);
        std::thread::spawn(move || {
            if let Ok(_command) = rx.recv() {
                worker_dequeued.store(true, Ordering::Release);
                std::thread::sleep(stall);
            }
        });
        let disk = Arc::get_mut(self.disk.as_mut().expect("disk cache must exist"))
            .expect("test cache must have one disk owner");
        disk.maintenance_tx = Some(tx);
        dequeued
    }

    pub fn missing_ready_delta(&self) -> GeneratedAvailabilityDelta {
        let Some(disk) = &self.disk else {
            return GeneratedAvailabilityDelta::default();
        };
        let state = self.inner.lock().unwrap();
        let chunks = state
            .availability
            .chunks()
            .filter_map(|entry| {
                if entry.status != GeneratedChunkStatus::Ready {
                    return None;
                }
                let identity = state
                    .level_identities
                    .get(&(entry.image_id.clone(), entry.level_index))?;
                if disk.chunk_exists(identity, &entry.image_id, entry.level_index, &entry.key) {
                    return None;
                }
                Some(GeneratedChunkStatusUpdate {
                    image_id: entry.image_id.clone(),
                    level_index: entry.level_index,
                    key: entry.key.clone(),
                    status: GeneratedChunkStatus::Unavailable,
                    failure: Some(FailureDescriptor::new(FailureCode::Persistence, true)),
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
            return disk.telemetry();
        }
        let state = self.inner.lock().unwrap();
        let bytes = state
            .ready_bytes
            .values()
            .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .fold(0_u64, u64::saturating_add);
        DerivedCacheTelemetry {
            storage: DerivedCacheStorage::Memory,
            bytes,
            budget_bytes: None,
            entries: 0,
            entry_budget: None,
            root_dir: None,
            evictions: 0,
            accounting_healthy: true,
        }
    }

    /// Rebuild the root byte ledger and enforce its ceiling after an external
    /// operator or filesystem repair. Normal writes never rescan the root;
    /// recovery is explicit so a hostile failure cannot cause scan storms.
    pub fn reconcile_disk_accounting(&self) -> io::Result<()> {
        let Some(disk) = &self.disk else {
            return Ok(());
        };
        disk.root_quota.reconcile()
    }

    #[cfg(test)]
    pub(super) fn inject_persistent_quota_remove_failure(&self) {
        self.disk
            .as_ref()
            .expect("disk cache must exist")
            .root_quota
            .inject_persistent_remove_failure();
    }

    #[cfg(test)]
    pub(super) fn clear_persistent_quota_remove_failure(&self) {
        self.disk
            .as_ref()
            .expect("disk cache must exist")
            .root_quota
            .clear_injected_remove_failure();
    }

    pub fn is_generated_level(&self, image_id: &ImageId, level_index: u32) -> bool {
        self.inner
            .lock()
            .unwrap()
            .availability
            .level(image_id, level_index)
            .is_some()
    }

    /// Cheap scheduler admission check that verifies durable readiness, not
    /// merely the last published status. This makes a chunk re-admissible as
    /// soon as an eviction or admin clear removes its bytes.
    pub(super) fn is_chunk_materialized(
        &self,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
        expected_bytes: u64,
    ) -> bool {
        let disk_identity = {
            let state = self.inner.lock().unwrap();
            if !state
                .availability
                .chunk_key_is_registered(image_id, level_index, key)
            {
                return false;
            }
            let chunk_key = DerivedChunkKey {
                image_id: image_id.clone(),
                level_index,
                key: key.to_string(),
            };
            if state.ready_bytes.contains_key(&chunk_key) {
                return true;
            }
            state
                .level_identities
                .get(&(image_id.clone(), level_index))
                .cloned()
        };

        match (disk_identity, &self.disk) {
            (Some(identity), Some(disk)) => disk
                .chunk_file_valid(&identity, image_id, level_index, key, expected_bytes)
                .unwrap_or(false),
            _ => false,
        }
    }

    pub fn lookup(&self, image_id: &ImageId, level_index: u32, key: &str) -> DerivedChunkLookup {
        let disk_load = {
            let state = self.inner.lock().unwrap();
            let chunk_key = DerivedChunkKey {
                image_id: image_id.clone(),
                level_index,
                key: key.to_string(),
            };
            let indexed_ready =
                if let Some(entry) = state.availability.chunk(image_id, level_index, key) {
                    if entry.status == GeneratedChunkStatus::Ready {
                        if let Some(bytes) = state.ready_bytes.get(&chunk_key) {
                            return DerivedChunkLookup::Ready(GeneratedChunkReadHandle {
                                payload_len: bytes.len(),
                                source: GeneratedChunkReadSource::Resident(bytes.clone()),
                            });
                        }
                        true
                    } else {
                        return DerivedChunkLookup::Status {
                            status: entry.status,
                            failure: entry.failure,
                            message: entry.message.clone(),
                        };
                    }
                } else {
                    if !state
                        .availability
                        .chunk_key_is_registered(image_id, level_index, key)
                    {
                        if state.availability.level(image_id, level_index).is_some() {
                            return DerivedChunkLookup::Status {
                                status: GeneratedChunkStatus::Unavailable,
                                failure: Some(FailureDescriptor::new(
                                    FailureCode::InvalidChunkKey,
                                    false,
                                )),
                                message: Some(
                                    "generated chunk key does not belong to the registered level"
                                        .into(),
                                ),
                            };
                        }
                        return DerivedChunkLookup::Status {
                            status: GeneratedChunkStatus::Unavailable,
                            failure: Some(FailureDescriptor::new(FailureCode::UnknownImage, false)),
                            message: Some("generated level is not registered".into()),
                        };
                    }
                    false
                };
            let identity = state
                .level_identities
                .get(&(image_id.clone(), level_index))
                .cloned();
            let expected_bytes = state
                .level_expected_chunk_bytes
                .get(&(image_id.clone(), level_index))
                .copied();
            match (identity, expected_bytes) {
                (Some(identity), Some(expected_bytes)) => {
                    Some((identity, expected_bytes, indexed_ready))
                }
                _ if !indexed_ready => {
                    return DerivedChunkLookup::Status {
                        status: GeneratedChunkStatus::Pending,
                        failure: None,
                        message: None,
                    };
                }
                _ => None,
            }
        };

        if let (Some((identity, expected_bytes, indexed_ready)), Some(disk)) =
            (disk_load, &self.disk)
        {
            match disk.chunk_file_valid(&identity, image_id, level_index, key, expected_bytes) {
                Ok(true) => {
                    let payload_len = match usize::try_from(expected_bytes) {
                        Ok(payload_len) => payload_len,
                        Err(_) => {
                            return DerivedChunkLookup::Status {
                                status: GeneratedChunkStatus::FailedPermanent,
                                failure: Some(FailureDescriptor::new(
                                    FailureCode::ResourceLimit,
                                    false,
                                )),
                                message: Some(
                                    "generated chunk exceeds this platform's address space".into(),
                                ),
                            };
                        }
                    };
                    if !generated_identity_matches(
                        &self.inner,
                        &identity,
                        image_id,
                        level_index,
                        expected_bytes,
                    ) {
                        return DerivedChunkLookup::Status {
                            status: GeneratedChunkStatus::Unavailable,
                            failure: Some(FailureDescriptor::new(FailureCode::Persistence, true)),
                            message: Some(
                                "generated chunk identity changed during readiness lookup".into(),
                            ),
                        };
                    }
                    return DerivedChunkLookup::Ready(GeneratedChunkReadHandle {
                        payload_len,
                        source: GeneratedChunkReadSource::Disk {
                            state: Arc::clone(&self.inner),
                            disk: Arc::clone(disk),
                            resident: Arc::clone(&self.resident),
                            level_identity: identity,
                            image_id: image_id.clone(),
                            level_index,
                            key: key.to_string(),
                            expected_bytes,
                        },
                    });
                }
                Ok(false) if !indexed_ready => {
                    return DerivedChunkLookup::Status {
                        status: GeneratedChunkStatus::Pending,
                        failure: None,
                        message: None,
                    };
                }
                Ok(false) => {}
                Err(e) => {
                    return DerivedChunkLookup::Status {
                        status: GeneratedChunkStatus::FailedTransient,
                        failure: Some(FailureDescriptor::new(FailureCode::Persistence, true)),
                        message: Some(e.to_string()),
                    };
                }
            }
        }

        DerivedChunkLookup::Status {
            status: GeneratedChunkStatus::Unavailable,
            failure: Some(FailureDescriptor::new(FailureCode::Persistence, true)),
            message: Some("generated chunk marked ready but bytes are unavailable".into()),
        }
    }

    fn budget_ready_bytes(&self, bytes: Vec<u8>) -> io::Result<GeneratedReadyBytes> {
        let reservation = self
            .resident
            .reserve_resident(MemoryCategory::GeneratedReady, bytes.len())
            .ok_or_else(|| {
                io::Error::other("process memory budget is full for generated ready bytes")
            })?;
        Ok(GeneratedReadyBytes {
            bytes: Arc::new(bytes),
            _reservation: Arc::new(reservation),
        })
    }

    #[cfg(test)]
    pub(crate) fn disk_payload_read_attempts(&self) -> u64 {
        self.disk
            .as_ref()
            .map_or(0, |disk| disk.payload_read_attempts.load(Ordering::Relaxed))
    }

    #[cfg(test)]
    pub(crate) fn disk_payload_buffer_high_water(&self) -> usize {
        self.disk.as_ref().map_or(0, |disk| {
            disk.payload_buffer_high_water.load(Ordering::Relaxed)
        })
    }
}

fn bounded_readiness_checkpoint(state: &DerivedChunkState) -> Vec<ReadinessCheckpoint> {
    let max_bytes = usize::try_from(MAX_READINESS_INDEX_BYTES).unwrap_or(usize::MAX);
    let mut used_bytes = 0_usize;
    let mut retained_entries = 0_usize;
    let mut identity_indexes = HashMap::<String, usize>::new();
    let mut indexes = Vec::<ReadinessCheckpoint>::new();

    for entry in state
        .availability
        .chunks()
        .take(MAX_CHECKPOINT_SCANNED_STATUS_ENTRIES)
    {
        if retained_entries >= MAX_CHECKPOINT_STATUS_ENTRIES {
            break;
        }
        let entry_bytes = checkpoint_entry_memory_bound(entry);
        if entry_bytes > max_bytes.saturating_sub(used_bytes) {
            continue;
        }
        let Some(identity) = state
            .level_identities
            .get(&(entry.image_id.clone(), entry.level_index))
        else {
            continue;
        };
        let is_new_identity = !identity_indexes.contains_key(identity.as_str());
        if is_new_identity && indexes.len() >= MAX_CHECKPOINT_IDENTITIES {
            continue;
        }
        let identity_bytes = if is_new_identity {
            checkpoint_string_memory_bound(identity).saturating_add(32)
        } else {
            0
        };
        let admitted_bytes = identity_bytes.saturating_add(entry_bytes);
        if admitted_bytes > max_bytes.saturating_sub(used_bytes) {
            continue;
        }
        let index = if let Some(index) = identity_indexes.get(identity.as_str()).copied() {
            index
        } else {
            let index = indexes.len();
            identity_indexes.insert(identity.clone(), index);
            indexes.push(ReadinessCheckpoint {
                level_identity: identity.clone(),
                chunks: Vec::new(),
            });
            index
        };
        indexes[index].chunks.push(entry.clone());
        retained_entries += 1;
        used_bytes = used_bytes.saturating_add(admitted_bytes);
    }
    indexes
}

fn checkpoint_entry_memory_bound(entry: &GeneratedChunkStatusUpdate) -> usize {
    // JSON escaping can expand a character to six bytes. The fixed allowance
    // covers field names, enum values, numeric fields, and Vec/String headers.
    let string_bytes = entry
        .image_id
        .0
        .len()
        .saturating_add(entry.key.len())
        .saturating_add(entry.message.as_ref().map_or(0, String::len));
    checkpoint_string_memory_bound_len(string_bytes).saturating_add(512)
}

fn checkpoint_string_memory_bound(value: &str) -> usize {
    checkpoint_string_memory_bound_len(value.len())
}

fn checkpoint_string_memory_bound_len(len: usize) -> usize {
    len.saturating_mul(6)
}

impl DerivedDiskCache {
    pub(super) fn dataset_dir(&self) -> PathBuf {
        self.root_dir.join(&self.source_scope)
    }

    fn quota_scope(&self) -> io::Result<PathBuf> {
        quota_scope_path(&self.root_quota.root_dir, &self.source_scope)
    }

    fn identity_dir(&self, level_identity: &str) -> PathBuf {
        self.dataset_dir().join(sanitize_segment(level_identity))
    }

    fn manifest_path(&self, level_identity: &str) -> PathBuf {
        self.identity_dir(level_identity).join("manifest.json")
    }

    pub(super) fn index_path(&self, level_identity: &str) -> PathBuf {
        self.identity_dir(level_identity).join("readiness.json")
    }

    fn status_dir(&self, level_identity: &str) -> PathBuf {
        self.identity_dir(level_identity).join("status")
    }

    fn enqueue_status(&self, level_identity: String, update: GeneratedChunkStatusUpdate) {
        let Some(tx) = &self.maintenance_tx else {
            return;
        };
        match tx.try_send(DiskMaintenanceCommand::Status {
            level_identity,
            update,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                let dropped = self.maintenance_dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if dropped.is_power_of_two() {
                    tracing::warn!(
                        dropped,
                        "generated coarse disk maintenance queue saturated; shutdown checkpoint will reconcile"
                    );
                }
            }
        }
    }

    async fn checkpoint(
        &self,
        indexes: Vec<ReadinessCheckpoint>,
        deadline: tokio::time::Instant,
    ) -> io::Result<()> {
        let Some(tx) = &self.maintenance_tx else {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "generated cache maintenance worker is unavailable",
            ));
        };
        let (done_tx, done_rx) = oneshot::channel();
        enqueue_maintenance_until(
            tx,
            DiskMaintenanceCommand::Checkpoint {
                indexes,
                max_serialized_bytes: usize::try_from(MAX_READINESS_INDEX_BYTES)
                    .unwrap_or(usize::MAX),
                done: done_tx,
            },
            deadline,
        )
        .await?;
        match tokio::time::timeout_at(deadline, done_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "generated cache checkpoint worker stopped",
            )),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "generated cache checkpoint deadline elapsed",
            )),
        }
    }

    #[cfg(test)]
    pub(super) async fn maintenance_barrier(&self, timeout: Duration) -> io::Result<()> {
        let Some(tx) = &self.maintenance_tx else {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "generated cache maintenance worker is unavailable",
            ));
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let (done_tx, done_rx) = oneshot::channel();
        enqueue_maintenance_until(tx, DiskMaintenanceCommand::Barrier(done_tx), deadline).await?;
        match tokio::time::timeout_at(deadline, done_rx).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "generated cache maintenance worker stopped",
            )),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "generated cache maintenance barrier deadline elapsed",
            )),
        }
    }

    #[cfg(test)]
    pub(super) fn reconciliation_scans(&self) -> u64 {
        self.root_quota.reconciliation_scans()
    }

    pub(super) fn chunk_path(
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

    fn recover_readiness(
        &self,
        plan: &GeneratedCoarsePlan,
    ) -> io::Result<Vec<GeneratedChunkStatusUpdate>> {
        let expected_bytes = expected_generated_chunk_bytes(plan);
        let recovery_limit = recovery_entry_limit(plan);
        let mut recovered = HashMap::<(ImageId, u32, String), GeneratedChunkStatusUpdate>::new();

        if let Some(index) = self.read_index(&plan.cache_identity, recovery_limit)? {
            for chunk in index.chunks.into_iter().take(recovery_limit) {
                let valid = chunk.image_id == plan.image_id
                    && chunk.level_index == plan.level_index
                    && generated_key_belongs_to_plan(plan, &chunk.key)
                    && (chunk.status != GeneratedChunkStatus::Ready
                        || self
                            .chunk_file_valid(
                                &plan.cache_identity,
                                &chunk.image_id,
                                chunk.level_index,
                                &chunk.key,
                                expected_bytes,
                            )
                            .unwrap_or(false));
                if valid {
                    recovered.insert(
                        (chunk.image_id.clone(), chunk.level_index, chunk.key.clone()),
                        chunk,
                    );
                }
            }
        }

        let remaining = recovery_limit.saturating_sub(recovered.len());
        for chunk in self.read_incremental_statuses(plan, expected_bytes, remaining)? {
            recovered.insert(
                (chunk.image_id.clone(), chunk.level_index, chunk.key.clone()),
                chunk,
            );
        }

        let remaining = recovery_limit.saturating_sub(recovered.len());
        for key in self.scan_ready_chunk_keys(plan, expected_bytes, remaining)? {
            recovered.insert(
                (plan.image_id.clone(), plan.level_index, key.clone()),
                GeneratedChunkStatusUpdate {
                    image_id: plan.image_id.clone(),
                    level_index: plan.level_index,
                    key,
                    status: GeneratedChunkStatus::Ready,
                    failure: None,
                    message: None,
                },
            );
        }
        let mut recovered = recovered.into_values().collect::<Vec<_>>();
        recovered.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(recovered)
    }

    fn read_incremental_statuses(
        &self,
        plan: &GeneratedCoarsePlan,
        expected_bytes: u64,
        limit: usize,
    ) -> io::Result<Vec<GeneratedChunkStatusUpdate>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let entries = match fs::read_dir(self.status_dir(&plan.cache_identity)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut updates = Vec::new();
        for entry in entries.take(limit) {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let bytes = match read_file_bounded(&path, MAX_INCREMENTAL_STATUS_BYTES) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let Ok(update) = serde_json::from_slice::<GeneratedChunkStatusUpdate>(&bytes) else {
                continue;
            };
            if update.image_id != plan.image_id
                || update.level_index != plan.level_index
                || !generated_key_belongs_to_plan(plan, &update.key)
            {
                continue;
            }
            if update.status == GeneratedChunkStatus::Ready
                && !self
                    .chunk_file_valid(
                        &plan.cache_identity,
                        &update.image_id,
                        update.level_index,
                        &update.key,
                        expected_bytes,
                    )
                    .unwrap_or(false)
            {
                continue;
            }
            updates.push(update);
        }
        Ok(updates)
    }

    pub(super) fn read_index(
        &self,
        level_identity: &str,
        limit: usize,
    ) -> io::Result<Option<DerivedReadinessIndex>> {
        let path = self.index_path(level_identity);
        let bytes = match read_file_bounded(&path, MAX_READINESS_INDEX_BYTES) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
        let index = serde::de::DeserializeSeed::deserialize(
            BoundedReadinessIndexSeed {
                limit: limit.min(MAX_RECOVERED_STATUS_ENTRIES),
            },
            &mut deserializer,
        )
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        deserializer
            .end()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        Ok(Some(index))
    }

    fn scan_ready_chunk_keys(
        &self,
        plan: &GeneratedCoarsePlan,
        expected_bytes: u64,
        limit: usize,
    ) -> io::Result<Vec<String>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let dir = self
            .identity_dir(&plan.cache_identity)
            .join(sanitize_segment(&plan.image_id.0))
            .join(format!("L{}", plan.level_index));
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        let mut keys = Vec::new();
        for entry in entries.take(limit) {
            let entry = entry?;
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
            if generated_key_belongs_to_plan(plan, &key) {
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

    pub(super) fn put_bytes_atomic(&self, path: &std::path::Path, bytes: &[u8]) -> io::Result<()> {
        let quota = Arc::clone(&self.root_quota);
        let scope = self.quota_scope()?;
        quota.mutate_file(&scope, path, bytes.len(), || {
            self.put_bytes_atomic_uncoordinated(path, bytes)
        })
    }

    fn put_bytes_atomic_uncoordinated(
        &self,
        path: &std::path::Path,
        bytes: &[u8],
    ) -> io::Result<()> {
        let counter = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
        write_bytes_atomic(path, bytes, counter)
    }

    #[cfg(test)]
    pub(super) fn put_bytes_atomic_injected(
        &self,
        path: &std::path::Path,
        bytes: &[u8],
        failure: AtomicWriteStage,
    ) -> io::Result<()> {
        let scope = self.quota_scope()?;
        self.root_quota.mutate_file(&scope, path, bytes.len(), || {
            let counter = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
            write_bytes_atomic_impl(path, bytes, counter, |stage| {
                if stage == failure {
                    Err(io::Error::other(format!(
                        "injected generated atomic-write {stage:?} failure"
                    )))
                } else {
                    Ok(())
                }
            })
        })
    }

    #[cfg(test)]
    pub(super) fn put_bytes_atomic_with_pre_rename_barrier(
        &self,
        path: &std::path::Path,
        bytes: &[u8],
        reached: std::sync::mpsc::Sender<()>,
        resume: std::sync::mpsc::Receiver<()>,
    ) -> io::Result<()> {
        let scope = self.quota_scope()?;
        self.root_quota.mutate_file(&scope, path, bytes.len(), || {
            let counter = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
            write_bytes_atomic_impl(path, bytes, counter, |stage| {
                if stage == AtomicWriteStage::Rename {
                    reached
                        .send(())
                        .map_err(|_| io::Error::other("pre-rename observer dropped"))?;
                    resume
                        .recv()
                        .map_err(|_| io::Error::other("pre-rename resume dropped"))?;
                }
                Ok(())
            })
        })
    }

    fn telemetry(&self) -> DerivedCacheTelemetry {
        self.root_quota.telemetry()
    }
}

fn recovery_entry_limit(plan: &GeneratedCoarsePlan) -> usize {
    checked_product(&plan.availability.level.grid_shape)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(MAX_RECOVERED_STATUS_ENTRIES)
        .min(MAX_RECOVERED_STATUS_ENTRIES)
}

pub(super) fn generated_key_belongs_to_plan(plan: &GeneratedCoarsePlan, key: &str) -> bool {
    let Some(coords) = parse_generated_chunk_key(key) else {
        return false;
    };
    let grid = plan.availability.level.grid_shape;
    coords.level_index == plan.level_index
        && u64::from(coords.t) < grid[0]
        && u64::from(coords.c) < grid[1]
        && coords.z < grid[2]
        && coords.y < grid[3]
        && coords.x < grid[4]
        && key
            == chunk_key(
                coords.level_index,
                coords.t,
                coords.c,
                coords.z,
                coords.y,
                coords.x,
            )
}

fn read_file_bounded(path: &std::path::Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "generated readiness file exceeds the recovery limit",
        ));
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(0)
            .min(usize::try_from(max_bytes).unwrap_or(usize::MAX)),
    );
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "generated readiness file grew past the recovery limit",
        ));
    }
    Ok(bytes)
}

struct BoundedReadinessIndexSeed {
    limit: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for BoundedReadinessIndexSeed {
    type Value = DerivedReadinessIndex;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_struct(
            "DerivedReadinessIndex",
            &["chunks"],
            BoundedReadinessIndexVisitor { limit: self.limit },
        )
    }
}

struct BoundedReadinessIndexVisitor {
    limit: usize,
}

impl<'de> serde::de::Visitor<'de> for BoundedReadinessIndexVisitor {
    type Value = DerivedReadinessIndex;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a generated readiness index object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut chunks = None;
        while let Some(field) = map.next_key::<String>()? {
            if field == "chunks" {
                if chunks.is_some() {
                    return Err(serde::de::Error::duplicate_field("chunks"));
                }
                chunks = Some(map.next_value_seed(BoundedChunkUpdatesSeed { limit: self.limit })?);
            } else {
                let _ = map.next_value::<serde::de::IgnoredAny>()?;
            }
        }
        Ok(DerivedReadinessIndex {
            chunks: chunks.unwrap_or_default(),
        })
    }
}

struct BoundedChunkUpdatesSeed {
    limit: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for BoundedChunkUpdatesSeed {
    type Value = Vec<GeneratedChunkStatusUpdate>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(BoundedChunkUpdatesVisitor { limit: self.limit })
    }
}

struct BoundedChunkUpdatesVisitor {
    limit: usize,
}

impl<'de> serde::de::Visitor<'de> for BoundedChunkUpdatesVisitor {
    type Value = Vec<GeneratedChunkStatusUpdate>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a generated readiness update array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        let mut chunks = Vec::new();
        while chunks.len() < self.limit {
            let Some(chunk) = sequence.next_element::<GeneratedChunkStatusUpdate>()? else {
                return Ok(chunks);
            };
            chunks.push(chunk);
        }
        while sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {}
        Ok(chunks)
    }
}

struct BoundedVecWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl Write for BoundedVecWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.max_bytes.saturating_sub(self.bytes.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "generated readiness serialization exceeds its byte limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialize_json_bounded<T: Serialize>(value: &T, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut writer = BoundedVecWriter {
        bytes: Vec::with_capacity(max_bytes.min(64 * 1024)),
        max_bytes,
    };
    serde_json::to_writer(&mut writer, value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(writer.bytes)
}

async fn enqueue_maintenance_until(
    tx: &SyncSender<DiskMaintenanceCommand>,
    mut command: DiskMaintenanceCommand,
    deadline: tokio::time::Instant,
) -> io::Result<()> {
    loop {
        match tx.try_send(command) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(returned)) => command = returned,
            Err(TrySendError::Disconnected(_)) => {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "generated cache maintenance worker stopped",
                ));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "generated cache maintenance queue deadline elapsed",
            ));
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(1)).min(deadline),
        )
        .await;
    }
}

fn spawn_disk_maintenance_worker(
    root_dir: PathBuf,
    source_scope: PathBuf,
    root_quota: Arc<DerivedDiskRootQuota>,
) -> io::Result<SyncSender<DiskMaintenanceCommand>> {
    let (tx, rx) = sync_channel(DISK_MAINTENANCE_QUEUE_CAPACITY);
    std::thread::Builder::new()
        .name("lucida-generated-disk".to_string())
        .spawn(move || {
            let mut counter = 0_u64;
            while let Ok(command) = rx.recv() {
                match command {
                    DiskMaintenanceCommand::Status {
                        level_identity,
                        update,
                    } => {
                        let result = write_incremental_status(
                            &root_dir,
                            &source_scope,
                            &level_identity,
                            &update,
                            counter,
                            &root_quota,
                        );
                        if let Err(error) = result {
                            tracing::warn!(
                                error = %error,
                                "generated coarse incremental status persist failed"
                            );
                        }
                        counter = counter.wrapping_add(1);
                    }
                    #[cfg(test)]
                    DiskMaintenanceCommand::Barrier(done) => {
                        let _ = done.send(());
                    }
                    DiskMaintenanceCommand::Checkpoint {
                        indexes,
                        max_serialized_bytes,
                        done,
                    } => {
                        let result = write_readiness_checkpoint(
                            &root_dir,
                            &source_scope,
                            indexes,
                            max_serialized_bytes,
                            &mut counter,
                            &root_quota,
                        );
                        let _ = done.send(result);
                    }
                }
            }
        })?;
    Ok(tx)
}

fn write_incremental_status(
    root_dir: &std::path::Path,
    source_scope: &std::path::Path,
    level_identity: &str,
    update: &GeneratedChunkStatusUpdate,
    counter: u64,
    root_quota: &DerivedDiskRootQuota,
) -> io::Result<()> {
    let status_dir = root_dir
        .join(source_scope)
        .join(sanitize_segment(level_identity))
        .join("status");

    let mut hasher = blake3::Hasher::new();
    hasher.update(&(update.image_id.0.len() as u64).to_le_bytes());
    hasher.update(update.image_id.0.as_bytes());
    hasher.update(&update.level_index.to_le_bytes());
    hasher.update(&(update.key.len() as u64).to_le_bytes());
    hasher.update(update.key.as_bytes());
    let name = format!("{}.json", hasher.finalize().to_hex());
    let path = status_dir.join(&name);
    let bytes = serialize_json_bounded(
        update,
        usize::try_from(MAX_INCREMENTAL_STATUS_BYTES).unwrap_or(usize::MAX),
    )?;
    let scope = quota_scope_path(&root_quota.root_dir, source_scope)?;
    root_quota.mutate_file(&scope, &path, bytes.len(), || {
        write_bytes_atomic(&path, &bytes, counter)
    })
}

fn write_readiness_checkpoint(
    root_dir: &std::path::Path,
    source_scope: &std::path::Path,
    indexes: Vec<ReadinessCheckpoint>,
    max_serialized_bytes: usize,
    counter: &mut u64,
    root_quota: &DerivedDiskRootQuota,
) -> io::Result<()> {
    let scope = quota_scope_path(&root_quota.root_dir, source_scope)?;
    let mut remaining = max_serialized_bytes;
    for ReadinessCheckpoint {
        level_identity,
        chunks,
    } in indexes
    {
        let index = DerivedReadinessIndex { chunks };
        let bytes = serialize_json_bounded(&index, remaining)?;
        remaining = remaining.saturating_sub(bytes.len());
        let path = root_dir
            .join(source_scope)
            .join(sanitize_segment(&level_identity))
            .join("readiness.json");
        root_quota.mutate_file(&scope, &path, bytes.len(), || {
            write_bytes_atomic(&path, &bytes, *counter)
        })?;
        *counter = counter.wrapping_add(1);
    }
    Ok(())
}

fn quota_scope_path(
    root_dir: &std::path::Path,
    source_scope: &std::path::Path,
) -> io::Result<PathBuf> {
    let first = source_scope
        .components()
        .next()
        .ok_or_else(|| io::Error::other("generated cache source scope is empty"))?;
    Ok(root_dir.join(first.as_os_str()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AtomicWriteStage {
    Write,
    FileSync,
    Rename,
    DirectorySync,
}

struct AtomicTempFile {
    path: PathBuf,
    file: Option<File>,
    armed: bool,
}

impl AtomicTempFile {
    fn new(path: PathBuf, file: File) -> Self {
        Self {
            path,
            file: Some(file),
            armed: true,
        }
    }

    fn file_mut(&mut self) -> &mut File {
        self.file.as_mut().expect("atomic temp file is open")
    }

    fn close(&mut self) {
        drop(self.file.take());
    }

    fn cleanup_with(
        &mut self,
        remove: impl FnOnce(&std::path::Path, bool) -> io::Result<()>,
    ) -> io::Result<()> {
        self.close();
        if !self.armed {
            return Ok(());
        }
        let result = remove(&self.path, self.file.is_none());
        if result.is_ok() {
            self.armed = false;
        }
        result
    }

    fn disarm(&mut self) {
        self.close();
        self.armed = false;
    }
}

impl Drop for AtomicTempFile {
    fn drop(&mut self) {
        let _ = self.cleanup_with(|path, _handle_closed| fs::remove_file(path));
    }
}

#[cfg(test)]
pub(super) fn atomic_temp_cleanup_order_probe(path: &std::path::Path) -> io::Result<bool> {
    let file = OpenOptions::new().create_new(true).write(true).open(path)?;
    let mut temp = AtomicTempFile::new(path.to_path_buf(), file);
    let mut observed_closed = false;
    temp.cleanup_with(|candidate, handle_closed| {
        observed_closed = handle_closed;
        fs::remove_file(candidate)
    })?;
    Ok(observed_closed)
}

fn write_bytes_atomic(path: &std::path::Path, bytes: &[u8], counter: u64) -> io::Result<()> {
    write_bytes_atomic_impl(path, bytes, counter, |_| Ok(()))
}

fn write_bytes_atomic_impl(
    path: &std::path::Path,
    bytes: &[u8],
    counter: u64,
    mut inject: impl FnMut(AtomicWriteStage) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "generated cache path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing cache file name"))?
        .to_string_lossy();
    let tmp = parent.join(format!(
        ".{file_name}.tmp.{counter}.{:016x}",
        rand::random::<u64>()
    ));
    let file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
    let mut temp = AtomicTempFile::new(tmp.clone(), file);
    inject(AtomicWriteStage::Write)?;
    temp.file_mut().write_all(bytes)?;
    inject(AtomicWriteStage::FileSync)?;
    temp.file_mut().sync_all()?;
    temp.close();
    inject(AtomicWriteStage::Rename)?;
    fs::rename(&tmp, path)?;
    temp.disarm();
    inject(AtomicWriteStage::DirectorySync)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) fn hex16(bytes: &[u8; 16]) -> String {
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
