use super::cache::generated_key_belongs_to_plan;
use super::materialize::expected_generated_chunk_bytes;
use super::*;

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
    broadcasts: GeneratedDeltaBroadcaster,
    config: GeneratedSchedulingConfig,
    state: AsyncMutex<GeneratedSchedulerState>,
    shutdown_gate: AsyncMutex<()>,
    workers: Mutex<GeneratedWorkerTasks>,
    notify: Notify,
    #[cfg(test)]
    worker_barrier: Mutex<Option<TestWorkerBarrier>>,
    #[cfg(test)]
    shutdown_barrier: Mutex<Option<TestWorkerBarrier>>,
}

#[derive(Debug, Default)]
struct GeneratedWorkerTasks {
    started: bool,
    handles: Vec<tokio::task::JoinHandle<()>>,
}

#[cfg(test)]
#[derive(Clone)]
struct TestWorkerBarrier {
    entered: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
}

#[derive(Debug, Default)]
struct GeneratedSchedulerState {
    shutdown_reason: Option<String>,
    interests: HashMap<(ClientId, DatasetId), ViewerInterestHint>,
    queued: VecDeque<GeneratedWorkItem>,
    queued_keys: HashMap<GeneratedWorkKey, GeneratedSchedulingLane>,
    running: HashSet<GeneratedWorkKey>,
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

impl GeneratedCoarseService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        plans: Vec<GeneratedCoarsePlan>,
        manifest: Arc<DatasetManifest>,
        store: Arc<CachedStore>,
        resolver: Arc<ChunkResolver>,
        cache: Arc<DerivedChunkCache>,
        session: Arc<AsyncMutex<Session>>,
        tx: BroadcastSender,
        config: GeneratedSchedulingConfig,
    ) -> Self {
        let plan_map = plans
            .into_iter()
            .map(|plan| ((plan.image_id.clone(), plan.level_index), plan))
            .collect();
        let broadcasts = GeneratedDeltaBroadcaster::new(tx);
        Self {
            inner: Arc::new(GeneratedCoarseServiceInner {
                plans: plan_map,
                manifest,
                store,
                resolver,
                cache,
                session,
                broadcasts,
                config,
                state: AsyncMutex::new(GeneratedSchedulerState::default()),
                shutdown_gate: AsyncMutex::new(()),
                workers: Mutex::new(GeneratedWorkerTasks::default()),
                notify: Notify::new(),
                #[cfg(test)]
                worker_barrier: Mutex::new(None),
                #[cfg(test)]
                shutdown_barrier: Mutex::new(None),
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
        let tx = crate::outbox::broadcast_channel(1, crate::outbox::DEFAULT_BROADCAST_BYTES);
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
        let mut workers = self
            .inner
            .workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if workers.started {
            return;
        }
        workers.started = true;
        let concurrency = self.inner.config.concurrency.max(1);
        for _ in 0..concurrency {
            let service = self.clone();
            workers.handles.push(tokio::spawn(async move {
                service.worker_loop().await;
            }));
        }
    }

    pub async fn shutdown(&self, reason: &str) -> GeneratedSchedulerTelemetry {
        // Serialize the entire withdrawal barrier so every caller observes a
        // service whose workers, cache mutations, session updates, and queued
        // broadcasts have all quiesced before shutdown returns.
        let _shutdown_guard = self.inner.shutdown_gate.lock().await;
        #[cfg(test)]
        let shutdown_barrier = self
            .inner
            .shutdown_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        #[cfg(test)]
        if let Some(barrier) = shutdown_barrier {
            barrier.entered.add_permits(1);
            let _ = barrier.release.acquire().await;
        }
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
        self.inner.notify.notify_waiters();

        // Taking and aborting retained handles closes the detached-task hole:
        // an archive/replacement cannot return while a materializer still owns
        // a future capable of writing cache state or publishing readiness.
        let handles = {
            let mut workers = self
                .inner
                .workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            workers.started = true;
            std::mem::take(&mut workers.handles)
        };
        for handle in &handles {
            handle.abort();
        }
        for handle in handles {
            if let Err(error) = handle.await
                && !error.is_cancelled()
            {
                tracing::warn!(reason, error = %error, "generated coarse worker join failed");
            }
        }
        let canceled_running = {
            let mut state = self.inner.state.lock().await;
            let canceled_running = u64::try_from(state.running.len()).unwrap_or(u64::MAX);
            state.running.clear();
            state.canceled = state.canceled.saturating_add(canceled_running);
            canceled_running
        };
        if let Err(error) = self.inner.cache.persist_readiness_indexes().await {
            tracing::warn!(
                reason,
                error = %error,
                "generated coarse readiness checkpoint did not complete before shutdown"
            );
        }
        self.inner.broadcasts.flush().await;
        let telemetry = self.telemetry().await;
        tracing::info!(
            reason,
            canceled_queued,
            canceled_running,
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
        if !generated_key_belongs_to_plan(plan, key) {
            return;
        }
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
        if !self
            .inner
            .plans
            .values()
            .any(|plan| plan.dataset_id == interest.dataset_id)
        {
            return;
        }
        bound_and_validate_interest(
            &mut interest,
            &self.inner.plans,
            self.inner.config.per_client_key_cap,
        );
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
            &self.inner.cache,
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

    #[cfg(test)]
    pub(crate) async fn has_client_interest(&self, client_id: ClientId) -> bool {
        self.inner
            .state
            .lock()
            .await
            .interests
            .keys()
            .any(|(candidate, _)| *candidate == client_id)
    }

    /// Installs an otherwise inert interest for lifecycle tests that exercise
    /// synchronous client revocation without constructing a real generated
    /// plan. Production interest still goes through exact plan validation.
    #[cfg(test)]
    pub(crate) async fn install_test_client_interest(
        &self,
        client_id: ClientId,
        mut interest: ViewerInterestHint,
    ) {
        interest.client_id = Some(client_id);
        let dataset_id = interest.dataset_id.clone();
        self.inner
            .state
            .lock()
            .await
            .interests
            .insert((client_id, dataset_id), interest);
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
            for t in 0..plan.availability.level.shape[0] {
                for c in 0..plan.availability.level.shape[1] {
                    let (Ok(t), Ok(c)) = (u32::try_from(t), u32::try_from(c)) else {
                        continue;
                    };
                    let remaining = self
                        .inner
                        .config
                        .background_chunk_limit
                        .saturating_sub(admitted);
                    for key in plan.chunk_keys_for_tc(t, c).take(remaining) {
                        let work_key = GeneratedWorkKey {
                            dataset_id: plan.dataset_id.clone(),
                            image_id: plan.image_id.clone(),
                            level_index: plan.level_index,
                            key,
                        };
                        self.enqueue_work(work_key, GeneratedSchedulingLane::Background)
                            .await;
                        admitted += 1;
                    }
                    if admitted >= self.inner.config.background_chunk_limit {
                        return;
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
        enqueue_work_locked(
            &mut state,
            &self.inner.plans,
            &self.inner.cache,
            work_key,
            lane,
        );
        drop(state);
        self.inner.notify.notify_waiters();
    }

    async fn worker_loop(self) {
        loop {
            let Some(item) = self.next_work_item().await else {
                tracing::debug!("generated_coarse.worker_stopped");
                break;
            };
            #[cfg(test)]
            let worker_barrier = {
                self.inner
                    .worker_barrier
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            };
            #[cfg(test)]
            if let Some(barrier) = worker_barrier {
                barrier.entered.add_permits(1);
                let _ = barrier.release.acquire().await;
            }
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
                    state.completed += 1;
                    state.ready_broadcasts += 1;
                }
                MaterializeOneResult::CacheReused => {
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

    pub(super) async fn pop_next_work_item(&self) -> Option<GeneratedWorkItem> {
        let mut state = self.inner.state.lock().await;
        if state.shutdown_reason.is_some() {
            return None;
        }
        expire_interests_locked(&mut state, current_unix_millis());
        prune_stale_queued_locked(&mut state, &self.inner.plans, current_unix_millis());

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
        state.running.insert(item.work_key.clone());
        Some(item)
    }

    pub(super) async fn should_cancel(&self, item: &GeneratedWorkItem) -> bool {
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
        if !generated_key_belongs_to_plan(&plan, &item.work_key.key) {
            tracing::warn!(
                image_id = %item.work_key.image_id.0,
                level_index = item.work_key.level_index,
                "rejected invalid generated work key before materialization"
            );
            return MaterializeOneResult::Failed;
        }
        let coords = parse_generated_chunk_key(&item.work_key.key)
            .expect("validated generated key must parse");
        materialize_generated_coarse_key(
            &plan,
            coords,
            self.inner.manifest.clone(),
            self.inner.store.clone(),
            self.inner.resolver.clone(),
            self.inner.cache.clone(),
            self.inner.session.clone(),
            self.inner.broadcasts.clone(),
            || async { self.should_cancel(item).await },
        )
        .await
    }

    #[cfg(test)]
    pub(crate) fn install_worker_barrier(
        &self,
    ) -> (Arc<tokio::sync::Semaphore>, Arc<tokio::sync::Semaphore>) {
        let barrier = TestWorkerBarrier {
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        };
        *self
            .inner
            .worker_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(barrier.clone());
        (barrier.entered, barrier.release)
    }

    #[cfg(test)]
    pub(crate) fn install_shutdown_barrier(
        &self,
    ) -> (Arc<tokio::sync::Semaphore>, Arc<tokio::sync::Semaphore>) {
        let barrier = TestWorkerBarrier {
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        };
        *self
            .inner
            .shutdown_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(barrier.clone());
        (barrier.entered, barrier.release)
    }

    #[cfg(test)]
    pub(super) async fn retained_interest_key_count(&self) -> usize {
        let state = self.inner.state.lock().await;
        state
            .interests
            .values()
            .map(|interest| interest.desired_keys.len() + interest.predicted_keys.len())
            .sum()
    }

    #[cfg(test)]
    pub(super) fn worker_handle_count(&self) -> usize {
        self.inner
            .workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .handles
            .len()
    }
}

fn bound_and_validate_interest(
    interest: &mut ViewerInterestHint,
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    cap: usize,
) {
    let mut retained = 0usize;
    interest.desired_keys.retain(|key| {
        let valid =
            retained < cap && work_key_from_interest(plans, &interest.dataset_id, key).is_some();
        retained += usize::from(valid);
        valid
    });
    interest.predicted_keys.retain(|key| {
        let valid =
            retained < cap && work_key_from_interest(plans, &interest.dataset_id, key).is_some();
        retained += usize::from(valid);
        valid
    });
}

fn enqueue_interest_locked(
    state: &mut GeneratedSchedulerState,
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    cache: &DerivedChunkCache,
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
            enqueue_work_locked(state, plans, cache, work_key, lane_from_interest_key(key));
            admitted += 1;
        }
    }
}

fn enqueue_work_locked(
    state: &mut GeneratedSchedulerState,
    plans: &HashMap<(ImageId, u32), GeneratedCoarsePlan>,
    cache: &DerivedChunkCache,
    work_key: GeneratedWorkKey,
    lane: GeneratedSchedulingLane,
) {
    let Some(plan) = plans
        .get(&(work_key.image_id.clone(), work_key.level_index))
        .filter(|plan| plan.dataset_id == work_key.dataset_id)
    else {
        return;
    };
    if !generated_key_belongs_to_plan(plan, &work_key.key) {
        return;
    }
    let already_materialized = cache.is_chunk_materialized(
        &work_key.image_id,
        work_key.level_index,
        &work_key.key,
        expected_generated_chunk_bytes(plan),
    );
    if already_materialized || state.running.contains(&work_key) {
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
    if &plan.dataset_id != dataset_id || !generated_key_belongs_to_plan(plan, &key.key) {
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

pub(super) fn current_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}
