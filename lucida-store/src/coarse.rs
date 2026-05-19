use lucida_content::{DataType, LevelGeometry};

/// Source-level selection bounds for the `coarse` tier.
///
/// These defaults intentionally describe a whole image/field at one T/C. Among
/// the source levels that fit, the coarse tier uses the least-fine LOD. Later
/// generated-coarse work can make the bounds operator-configurable, but
/// import-time source selection needs a deterministic contract now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceCoarseConfig {
    pub max_long_axis: u64,
    pub max_decoded_bytes_per_tc: u64,
    pub max_chunk_count_per_tc: Option<u64>,
    pub max_chunk_bytes: u64,
}

impl Default for SourceCoarseConfig {
    fn default() -> Self {
        Self {
            max_long_axis: 2048,
            max_decoded_bytes_per_tc: 64 * 1024 * 1024,
            max_chunk_count_per_tc: Some(4096),
            max_chunk_bytes: 16 * 1024 * 1024,
        }
    }
}

pub(crate) fn select_source_coarse_level(
    levels: &[LevelGeometry],
    data_type: DataType,
    config: SourceCoarseConfig,
) -> Option<u32> {
    levels
        .iter()
        .filter(|level| source_level_fits(level, data_type, config))
        .map(|level| level.level_index)
        .max()
}

fn source_level_fits(
    level: &LevelGeometry,
    data_type: DataType,
    config: SourceCoarseConfig,
) -> bool {
    let [_t, _c, z, y, x] = level.shape;
    let [_ct, _cc, chunk_z, chunk_y, chunk_x] = level.chunk_shape;
    let [_gt, _gc, grid_z, grid_y, grid_x] = level.grid_shape;

    if y.max(x) > config.max_long_axis {
        return false;
    }

    let bytes_per_voxel = data_type_size(data_type);
    if checked_product(&[z, y, x, bytes_per_voxel])
        .is_none_or(|bytes| bytes > config.max_decoded_bytes_per_tc)
    {
        return false;
    }

    if checked_product(&[chunk_z, chunk_y, chunk_x, bytes_per_voxel])
        .is_none_or(|bytes| bytes > config.max_chunk_bytes)
    {
        return false;
    }

    if let Some(max_chunks) = config.max_chunk_count_per_tc
        && checked_product(&[grid_z, grid_y, grid_x]).is_none_or(|chunks| chunks > max_chunks)
    {
        return false;
    }

    true
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
mod tests {
    use super::*;

    fn level(level_index: u32, shape: [u64; 5], chunk_shape: [u64; 5]) -> LevelGeometry {
        let grid_shape = std::array::from_fn(|d| shape[d].div_ceil(chunk_shape[d]));
        LevelGeometry {
            level_index,
            shape,
            chunk_shape,
            grid_shape,
            scale: [1.0; 5],
        }
    }

    #[test]
    fn selects_least_fine_source_level_that_fits_bounds() {
        let levels = vec![
            level(0, [1, 1, 1, 8192, 8192], [1, 1, 1, 512, 512]),
            level(1, [1, 1, 1, 4096, 4096], [1, 1, 1, 512, 512]),
            level(2, [1, 1, 1, 2048, 2048], [1, 1, 1, 512, 512]),
            level(3, [1, 1, 1, 1024, 1024], [1, 1, 1, 512, 512]),
        ];

        assert_eq!(
            select_source_coarse_level(&levels, DataType::Uint16, SourceCoarseConfig::default()),
            Some(3),
        );
    }

    #[test]
    fn rejects_source_levels_that_do_not_fit() {
        let levels = vec![
            level(0, [1, 1, 1, 8192, 8192], [1, 1, 1, 8192, 8192]),
            level(1, [1, 1, 1, 4096, 4096], [1, 1, 1, 4096, 4096]),
        ];

        assert_eq!(
            select_source_coarse_level(&levels, DataType::Uint16, SourceCoarseConfig::default()),
            None,
        );
    }

    #[test]
    fn enforces_decoded_bytes_per_timepoint_channel() {
        let levels = vec![level(1, [5, 3, 128, 1024, 1024], [1, 1, 1, 256, 256])];
        let config = SourceCoarseConfig {
            max_long_axis: 2048,
            max_decoded_bytes_per_tc: 16 * 1024 * 1024,
            max_chunk_count_per_tc: None,
            max_chunk_bytes: 16 * 1024 * 1024,
        };

        assert_eq!(
            select_source_coarse_level(&levels, DataType::Uint16, config),
            None,
        );
    }
}
