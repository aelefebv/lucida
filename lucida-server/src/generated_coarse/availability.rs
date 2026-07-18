use super::*;

#[derive(Clone)]
pub(super) struct GeneratedDeltaBroadcaster {
    sender: Arc<OnceLock<mpsc::Sender<GeneratedBroadcastCommand>>>,
    tx: BroadcastSender,
}

enum GeneratedBroadcastCommand {
    Delta {
        dataset_id: DatasetId,
        delta: GeneratedAvailabilityDelta,
    },
    Flush(oneshot::Sender<()>),
}

#[derive(Default)]
struct PendingGeneratedBroadcasts {
    datasets: HashMap<DatasetId, PendingGeneratedDatasetDelta>,
    dataset_order: VecDeque<DatasetId>,
    entries: usize,
}

#[derive(Default)]
struct PendingGeneratedDatasetDelta {
    levels: HashMap<(ImageId, u32), GeneratedLevelAvailability>,
    level_order: VecDeque<(ImageId, u32)>,
    chunks: HashMap<(ImageId, u32, String), GeneratedChunkStatusUpdate>,
    chunk_order: VecDeque<(ImageId, u32, String)>,
}

impl GeneratedDeltaBroadcaster {
    pub(super) fn new(tx: BroadcastSender) -> Self {
        Self {
            sender: Arc::new(OnceLock::new()),
            tx,
        }
    }

    fn sender(&self) -> &mpsc::Sender<GeneratedBroadcastCommand> {
        self.sender.get_or_init(|| {
            // Lazy startup keeps the service constructible in synchronous
            // tests while guaranteeing that every real async publication uses
            // the coalescing actor rather than a weaker fallback mode.
            let (sender, receiver) = mpsc::channel(GENERATED_DELTA_QUEUE_CAPACITY);
            tokio::spawn(run_generated_broadcasts(receiver, self.tx.clone()));
            sender
        })
    }

    pub(super) async fn enqueue(&self, dataset_id: DatasetId, delta: GeneratedAvailabilityDelta) {
        let mut levels = delta.levels.into_iter().peekable();
        let mut chunks = delta.chunks.into_iter().peekable();
        while levels.peek().is_some() || chunks.peek().is_some() {
            let mut fragment = GeneratedAvailabilityDelta::default();
            while fragment.levels.len() + fragment.chunks.len() < GENERATED_DELTA_BATCH_SIZE {
                if let Some(level) = levels.next() {
                    fragment.levels.push(level);
                } else if let Some(chunk) = chunks.next() {
                    fragment.chunks.push(chunk);
                } else {
                    break;
                }
            }
            self.enqueue_fragment(dataset_id.clone(), fragment).await;
        }
    }

    async fn enqueue_fragment(&self, dataset_id: DatasetId, delta: GeneratedAvailabilityDelta) {
        let command = GeneratedBroadcastCommand::Delta { dataset_id, delta };
        if let Err(mpsc::error::SendError(GeneratedBroadcastCommand::Delta { dataset_id, delta })) =
            self.sender().send(command).await
        {
            broadcast_generated_delta(&self.tx, dataset_id, delta);
        }
    }

    pub(super) async fn flush(&self) {
        let Some(sender) = self.sender.get() else {
            return;
        };
        let (done_tx, done_rx) = oneshot::channel();
        if sender
            .send(GeneratedBroadcastCommand::Flush(done_tx))
            .await
            .is_ok()
        {
            let _ = done_rx.await;
        }
    }
}

impl PendingGeneratedBroadcasts {
    fn merge(&mut self, dataset_id: DatasetId, delta: GeneratedAvailabilityDelta) {
        if !self.datasets.contains_key(&dataset_id) {
            self.dataset_order.push_back(dataset_id.clone());
        }
        let pending = self.datasets.entry(dataset_id).or_default();
        let before = pending.len();
        pending.merge(delta);
        self.entries = self
            .entries
            .saturating_add(pending.len().saturating_sub(before));
    }

    fn take_batch(&mut self) -> Option<(DatasetId, GeneratedAvailabilityDelta)> {
        while let Some(dataset_id) = self.dataset_order.pop_front() {
            let (delta, has_more) = {
                let pending = self.datasets.get_mut(&dataset_id)?;
                let delta = pending.take_batch(GENERATED_DELTA_BATCH_SIZE);
                let removed = delta.levels.len() + delta.chunks.len();
                self.entries = self.entries.saturating_sub(removed);
                (delta, !pending.is_empty())
            };
            if has_more {
                self.dataset_order.push_back(dataset_id.clone());
            } else {
                self.datasets.remove(&dataset_id);
            }
            if !delta.levels.is_empty() || !delta.chunks.is_empty() {
                return Some((dataset_id, delta));
            }
        }
        None
    }

    fn is_empty(&self) -> bool {
        self.entries == 0
    }
}

impl PendingGeneratedDatasetDelta {
    fn merge(&mut self, delta: GeneratedAvailabilityDelta) {
        for level in delta.levels {
            let key = (level.image_id.clone(), level.info.level_index);
            if !self.levels.contains_key(&key) {
                self.level_order.push_back(key.clone());
            }
            self.levels.insert(key, level);
        }
        for chunk in delta.chunks {
            let key = (chunk.image_id.clone(), chunk.level_index, chunk.key.clone());
            if !self.chunks.contains_key(&key) {
                self.chunk_order.push_back(key.clone());
            }
            self.chunks.insert(key, chunk);
        }
    }

    fn take_batch(&mut self, limit: usize) -> GeneratedAvailabilityDelta {
        let mut delta = GeneratedAvailabilityDelta::default();
        while delta.levels.len() + delta.chunks.len() < limit {
            if let Some(key) = self.level_order.pop_front() {
                if let Some(level) = self.levels.remove(&key) {
                    delta.levels.push(level);
                }
                continue;
            }
            let Some(key) = self.chunk_order.pop_front() else {
                break;
            };
            if let Some(chunk) = self.chunks.remove(&key) {
                delta.chunks.push(chunk);
            }
        }
        delta
    }

    fn len(&self) -> usize {
        self.levels.len() + self.chunks.len()
    }

    fn is_empty(&self) -> bool {
        self.levels.is_empty() && self.chunks.is_empty()
    }
}

async fn run_generated_broadcasts(
    mut receiver: mpsc::Receiver<GeneratedBroadcastCommand>,
    tx: BroadcastSender,
) {
    let mut pending = PendingGeneratedBroadcasts::default();
    let mut deadline = None;
    loop {
        if pending.is_empty() {
            deadline = None;
            let Some(command) = receiver.recv().await else {
                return;
            };
            handle_generated_broadcast_command(command, &mut pending, &tx);
            if !pending.is_empty() {
                deadline = Some(tokio::time::Instant::now() + GENERATED_DELTA_FLUSH_INTERVAL);
            }
        } else {
            let flush_at = deadline
                .unwrap_or_else(|| tokio::time::Instant::now() + GENERATED_DELTA_FLUSH_INTERVAL);
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(flush_at) => {
                    flush_all_generated_broadcasts(&mut pending, &tx);
                    deadline = None;
                }
                command = receiver.recv() => {
                    let Some(command) = command else {
                        flush_all_generated_broadcasts(&mut pending, &tx);
                        return;
                    };
                    if matches!(&command, GeneratedBroadcastCommand::Flush(_)) {
                        deadline = None;
                    }
                    handle_generated_broadcast_command(command, &mut pending, &tx);
                }
            }
        }

        while pending.entries >= GENERATED_DELTA_BATCH_SIZE {
            flush_one_generated_broadcast(&mut pending, &tx);
        }
    }
}

fn handle_generated_broadcast_command(
    command: GeneratedBroadcastCommand,
    pending: &mut PendingGeneratedBroadcasts,
    tx: &BroadcastSender,
) {
    match command {
        GeneratedBroadcastCommand::Delta { dataset_id, delta } => {
            pending.merge(dataset_id, delta);
        }
        GeneratedBroadcastCommand::Flush(done) => {
            flush_all_generated_broadcasts(pending, tx);
            let _ = done.send(());
        }
    }
}

fn flush_one_generated_broadcast(pending: &mut PendingGeneratedBroadcasts, tx: &BroadcastSender) {
    if let Some((dataset_id, delta)) = pending.take_batch() {
        broadcast_generated_delta(tx, dataset_id, delta);
    }
}

fn flush_all_generated_broadcasts(pending: &mut PendingGeneratedBroadcasts, tx: &BroadcastSender) {
    while !pending.is_empty() {
        flush_one_generated_broadcast(pending, tx);
    }
}

pub(super) fn broadcast_generated_delta(
    tx: &BroadcastSender,
    dataset_id: DatasetId,
    delta: GeneratedAvailabilityDelta,
) {
    let msg = ServerMessage::GeneratedAvailabilityUpdate { dataset_id, delta };
    let _ = tx.send(BroadcastEvent::generated_availability(msg));
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
