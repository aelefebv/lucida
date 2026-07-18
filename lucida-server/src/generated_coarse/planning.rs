use super::*;

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

pub fn plan_generated_coarse_for_manifest(
    manifest: &DatasetManifest,
    config: GeneratedCoarseConfig,
) -> Vec<GeneratedCoarsePlan> {
    plan_generated_coarse(manifest, None, config)
}

/// Plan generated content for an admitted source generation. The revision is
/// part of every generated identity, so a same-locator mutation cannot recover
/// readiness or bytes derived from the prior generation.
pub fn plan_generated_coarse_for_source(
    manifest: &DatasetManifest,
    revision: SourceRevision,
    config: GeneratedCoarseConfig,
) -> Vec<GeneratedCoarsePlan> {
    plan_generated_coarse(manifest, Some(revision), config)
}

fn plan_generated_coarse(
    manifest: &DatasetManifest,
    revision: Option<SourceRevision>,
    config: GeneratedCoarseConfig,
) -> Vec<GeneratedCoarsePlan> {
    manifest
        .images()
        .iter()
        .filter_map(|image| {
            plan_generated_coarse_for_image(manifest, image, revision, config.clone())
        })
        .collect()
}

fn plan_generated_coarse_for_image(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    source_revision: Option<SourceRevision>,
    config: GeneratedCoarseConfig,
) -> Option<GeneratedCoarsePlan> {
    if image.multiscale.coarse_level_index.is_some() || image.multiscale.levels.is_empty() {
        return None;
    }

    let source_content_id = source_content_id_for_image(manifest, image, source_revision);
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

    /// Lazily enumerate canonical spatial keys. Callers that need only a
    /// bounded prefix must apply `take` before any allocation.
    pub fn chunk_keys_for_tc(&self, t: u32, c: u32) -> impl Iterator<Item = String> {
        let grid = self.availability.level.grid_shape;
        let level_index = self.level_index;
        (0..grid[2]).flat_map(move |gz| {
            (0..grid[3]).flat_map(move |gy| {
                (0..grid[4]).map(move |gx| chunk_key(level_index, t, c, gz, gy, gx))
            })
        })
    }
}

fn source_content_id_for_image(
    manifest: &DatasetManifest,
    image: &ImageSpec,
    source_revision: Option<SourceRevision>,
) -> String {
    let value = serde_json::json!({
        "dataset_id": &manifest.dataset_id.0,
        "image": image,
        "source_revision": source_revision.map(|revision| revision.as_hex()),
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

pub(super) fn grid_shape(shape: [u64; 5], chunk_shape: [u64; 5]) -> [u64; 5] {
    std::array::from_fn(|axis| shape[axis].div_ceil(chunk_shape[axis].max(1)).max(1))
}
