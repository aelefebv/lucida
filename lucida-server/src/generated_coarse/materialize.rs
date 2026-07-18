use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MaterializeOneResult {
    Ready,
    CacheReused,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct GeneratedChunkCoords {
    pub(super) level_index: u32,
    pub(super) t: u32,
    pub(super) c: u32,
    pub(super) z: u64,
    pub(super) y: u64,
    pub(super) x: u64,
}

#[derive(Debug)]
enum GeneratedChunkBuildError {
    Source(VolumeReadError),
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

impl GeneratedChunkBuildError {
    fn failure(&self) -> FailureDescriptor {
        match self {
            Self::Source(error) => error.failure(),
            Self::Downsample(_) => FailureDescriptor::new(FailureCode::ChunkOutOfBounds, false),
        }
    }
}

impl From<VolumeReadError> for GeneratedChunkBuildError {
    fn from(error: VolumeReadError) -> Self {
        GeneratedChunkBuildError::Source(error)
    }
}

pub async fn publish_generated_level_availability(
    dataset_id: DatasetId,
    level: GeneratedLevelAvailability,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: BroadcastSender,
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
    tx: BroadcastSender,
) {
    if !manifest
        .images()
        .iter()
        .any(|image| image.image_id == plan.image_id)
    {
        publish_all_chunks_for_plan(
            &plan,
            GeneratedChunkStatus::FailedPermanent,
            Some(FailureDescriptor::new(FailureCode::UnknownImage, false)),
            Some("generated coarse source image disappeared".into()),
            cache,
            session,
            tx,
        )
        .await;
        return;
    }

    let broadcasts = GeneratedDeltaBroadcaster::new(tx);
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
                        Some(FailureDescriptor::new(FailureCode::InvalidChunkKey, false)),
                        Some("generated chunk key is malformed".into()),
                        cache.clone(),
                        session.clone(),
                        broadcasts.clone(),
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
                    broadcasts.clone(),
                    || async { false },
                )
                .await;
            }
        }
    }
    broadcasts.flush().await;
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn materialize_generated_coarse_key<C, Fut>(
    plan: &GeneratedCoarsePlan,
    coords: GeneratedChunkCoords,
    manifest: Arc<DatasetManifest>,
    store: Arc<CachedStore>,
    resolver: Arc<ChunkResolver>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    broadcasts: GeneratedDeltaBroadcaster,
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
        expected_generated_chunk_bytes(plan),
    ) {
        Ok(true) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::Ready,
                None,
                None,
                cache.clone(),
                session.clone(),
                broadcasts.clone(),
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
            Some(FailureDescriptor::new(FailureCode::UnknownImage, false)),
            Some("generated coarse source image disappeared".into()),
            cache,
            session,
            broadcasts,
        )
        .await;
        return MaterializeOneResult::Failed;
    };

    let expected_output_bytes = match usize::try_from(expected_generated_chunk_bytes(plan)) {
        Ok(bytes) => bytes,
        Err(_) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::FailedPermanent,
                Some(FailureDescriptor::new(FailureCode::ResourceLimit, false)),
                Some("generated output exceeds this platform".into()),
                cache,
                session,
                broadcasts,
            )
            .await;
            return MaterializeOneResult::Failed;
        }
    };
    // Downsampling holds a u16 working chunk and its encoded output at once.
    // Three output-byte equivalents covers both UInt8 and UInt16 paths.
    let Some(generation_bytes) = expected_output_bytes.checked_mul(3) else {
        publish_chunk_status(
            &plan.dataset_id,
            &plan.image_id,
            plan.level_index,
            key,
            GeneratedChunkStatus::FailedPermanent,
            Some(FailureDescriptor::new(FailureCode::ResourceLimit, false)),
            Some("generated working-set size overflowed".into()),
            cache,
            session,
            broadcasts,
        )
        .await;
        return MaterializeOneResult::Failed;
    };
    let Some(generation_reservation) =
        store.reserve_resident(MemoryCategory::Decoded, generation_bytes)
    else {
        publish_chunk_status(
            &plan.dataset_id,
            &plan.image_id,
            plan.level_index,
            key,
            GeneratedChunkStatus::FailedTransient,
            Some(FailureDescriptor::new(FailureCode::ResourceLimit, true)),
            Some("process memory budget is full for generated chunk work".into()),
            cache,
            session,
            broadcasts,
        )
        .await;
        return MaterializeOneResult::Failed;
    };

    let bytes = match generate_chunk_with_fallback(&image, coords, plan, &store, &resolver).await {
        Ok(bytes) => bytes,
        Err(e) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                generated_status_for_chunk_error(&e),
                Some(e.failure()),
                Some(e.to_string()),
                cache,
                session,
                broadcasts,
            )
            .await;
            return MaterializeOneResult::Failed;
        }
    };

    if should_cancel().await {
        return MaterializeOneResult::Canceled;
    }
    match cache.put_ready_chunk_atomic_reserved(
        &plan.cache_identity,
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
        bytes,
        generation_reservation,
    ) {
        Ok(()) => {
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::Ready,
                None,
                None,
                cache.clone(),
                session.clone(),
                broadcasts.clone(),
            )
            .await;
            let withdrawal_delta = cache.missing_ready_delta();
            if !withdrawal_delta.chunks.is_empty() {
                publish_generated_delta_coalesced(
                    plan.dataset_id.clone(),
                    withdrawal_delta,
                    cache,
                    session,
                    broadcasts,
                )
                .await;
            }
            MaterializeOneResult::Ready
        }
        Err(e) => {
            let failure_code = if e.kind() == io::ErrorKind::OutOfMemory {
                FailureCode::ResourceLimit
            } else {
                FailureCode::Persistence
            };
            publish_chunk_status(
                &plan.dataset_id,
                &plan.image_id,
                plan.level_index,
                key,
                GeneratedChunkStatus::FailedTransient,
                Some(FailureDescriptor::new(failure_code, true)),
                Some(e.to_string()),
                cache,
                session,
                broadcasts,
            )
            .await;
            MaterializeOneResult::Failed
        }
    }
}

async fn generate_chunk_with_fallback(
    image: &ImageSpec,
    coords: GeneratedChunkCoords,
    plan: &GeneratedCoarsePlan,
    store: &Arc<CachedStore>,
    resolver: &Arc<ChunkResolver>,
) -> Result<Vec<u8>, GeneratedChunkBuildError> {
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
            Ok(bytes) => return Ok(bytes),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        VolumeReadError::BadLevel {
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
) -> Result<Vec<u8>, GeneratedChunkBuildError> {
    let source_level = image
        .multiscale
        .levels
        .get(source_level_index)
        .ok_or_else(|| VolumeReadError::BadLevel {
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
    failure: Option<FailureDescriptor>,
    message: Option<String>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: BroadcastSender,
) {
    let level = &plan.availability.level;
    let mut remaining = MAX_GENERATED_RUNTIME_CHUNKS;
    for t in 0..level.shape[0] {
        for c in 0..level.shape[1] {
            if let (Ok(t), Ok(c)) = (u32::try_from(t), u32::try_from(c)) {
                let published = publish_chunks_for_tc(
                    plan,
                    t,
                    c,
                    status,
                    failure,
                    message.clone(),
                    cache.clone(),
                    session.clone(),
                    tx.clone(),
                    remaining,
                )
                .await;
                remaining = remaining.saturating_sub(published);
                if remaining == 0 {
                    return;
                }
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
    failure: Option<FailureDescriptor>,
    message: Option<String>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: BroadcastSender,
    limit: usize,
) -> usize {
    let mut published = 0usize;
    let mut updates = Vec::with_capacity(limit.min(GENERATED_DELTA_BATCH_SIZE));
    for key in plan.chunk_keys_for_tc(t, c).take(limit) {
        updates.push(GeneratedChunkStatusUpdate {
            image_id: plan.image_id.clone(),
            level_index: plan.level_index,
            key,
            status,
            failure,
            message: message.clone(),
        });
        if updates.len() < GENERATED_DELTA_BATCH_SIZE {
            continue;
        }
        published = published.saturating_add(updates.len());
        publish_generated_delta(
            plan.dataset_id.clone(),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: std::mem::take(&mut updates),
            },
            cache.clone(),
            session.clone(),
            tx.clone(),
        )
        .await;
    }
    if !updates.is_empty() {
        published = published.saturating_add(updates.len());
        publish_generated_delta(
            plan.dataset_id.clone(),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: updates,
            },
            cache,
            session,
            tx,
        )
        .await;
    }
    published
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn publish_chunk_status(
    dataset_id: &DatasetId,
    image_id: &ImageId,
    level_index: u32,
    key: String,
    status: GeneratedChunkStatus,
    failure: Option<FailureDescriptor>,
    message: Option<String>,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    broadcasts: GeneratedDeltaBroadcaster,
) {
    publish_generated_delta_coalesced(
        dataset_id.clone(),
        GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: image_id.clone(),
                level_index,
                key,
                status,
                failure,
                message,
            }],
        },
        cache,
        session,
        broadcasts,
    )
    .await;
}

async fn publish_generated_delta_coalesced(
    dataset_id: DatasetId,
    delta: GeneratedAvailabilityDelta,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    broadcasts: GeneratedDeltaBroadcaster,
) {
    let retained = {
        let mut sess = session.lock().await;
        if !sess
            .server_bindings
            .get(&dataset_id)
            .is_some_and(|binding| Arc::ptr_eq(&binding.derived_chunks, &cache))
        {
            tracing::debug!(
                dataset_id = %dataset_id,
                "discarded generated delta from a superseded cache generation"
            );
            return;
        }
        let retained = cache.apply_delta(delta);
        if retained.levels.is_empty() && retained.chunks.is_empty() {
            return;
        }
        sess.apply_generated_availability_delta(dataset_id.clone(), retained.clone());
        retained
    };
    broadcasts.enqueue(dataset_id, retained).await;
}

async fn publish_generated_delta(
    dataset_id: DatasetId,
    delta: GeneratedAvailabilityDelta,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: BroadcastSender,
) {
    let retained = {
        let mut sess = session.lock().await;
        if !sess
            .server_bindings
            .get(&dataset_id)
            .is_some_and(|binding| Arc::ptr_eq(&binding.derived_chunks, &cache))
        {
            tracing::debug!(
                dataset_id = %dataset_id,
                "discarded generated delta from a superseded cache generation"
            );
            return;
        }
        let retained = cache.apply_delta(delta);
        if retained.levels.is_empty() && retained.chunks.is_empty() {
            return;
        }
        sess.apply_generated_availability_delta(dataset_id.clone(), retained.clone());
        retained
    };
    broadcast_generated_delta(&tx, dataset_id, retained);
}

#[cfg(test)]
pub(crate) async fn publish_generated_delta_for_test(
    dataset_id: DatasetId,
    delta: GeneratedAvailabilityDelta,
    cache: Arc<DerivedChunkCache>,
    session: Arc<AsyncMutex<Session>>,
    tx: BroadcastSender,
) {
    publish_generated_delta(dataset_id, delta, cache, session, tx).await;
}

#[cfg(test)]
pub(super) fn generated_status_for_source_error(error: &VolumeReadError) -> GeneratedChunkStatus {
    generated_status_for_failure(&error.failure())
}

fn generated_status_for_chunk_error(error: &GeneratedChunkBuildError) -> GeneratedChunkStatus {
    generated_status_for_failure(&error.failure())
}

fn generated_status_for_failure(failure: &FailureDescriptor) -> GeneratedChunkStatus {
    if failure.retryable {
        GeneratedChunkStatus::FailedTransient
    } else {
        GeneratedChunkStatus::FailedPermanent
    }
}

pub(super) fn expected_generated_chunk_bytes(plan: &GeneratedCoarsePlan) -> u64 {
    checked_product(&[
        plan.availability.level.chunk_shape[2],
        plan.availability.level.chunk_shape[3],
        plan.availability.level.chunk_shape[4],
        data_type_size(plan.output_data_type),
    ])
    .unwrap_or(0)
}
