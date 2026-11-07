//! One declared geometry for every tile of a collection.
//!
//! The client sees one multiscale per collection, but OME-Zarr lets each tile
//! store its own level shapes and chunk shapes. The declared geometry covers
//! every tile, and each tile is bound to it: as stored where its chunk shape
//! is the declared one, and through a [`Regrid`] where it is not. What the
//! declared geometry hides about a tile is named by [`describe_mismatches`].

use lucida_content::PinnedAxis;

use crate::backend::StoreError;
use crate::import_types::{LevelBindingInfo, Regrid};
use crate::layout::{ChunkByteLayout, compute_chunk_byte_layout};

/// What one tile stores, level by level, in its raw axes order.
#[derive(Clone)]
pub(crate) struct StoredLevels {
    pub(crate) shapes: Vec<Vec<u64>>,
    pub(crate) bindings: Vec<LevelBindingInfo>,
}

/// One tile's stored levels and the scale its metadata declares for them.
#[derive(Clone)]
pub(crate) struct StoredTile {
    pub(crate) levels: StoredLevels,
    /// Level 0's scale, as `[t, c, z, y, x]`.
    pub(crate) scale: [f64; 5],
}

/// The geometry a collection declares for all of its tiles, in raw axes
/// order.
pub(crate) struct DeclaredLevels {
    pub(crate) shapes: Vec<Vec<u64>>,
    pub(crate) chunk_shapes: Vec<Vec<u64>>,
    chunk_byte_layouts: Vec<ChunkByteLayout>,
}

impl DeclaredLevels {
    /// The geometry that covers every tile in `tiles`, which must share one
    /// axes list: the levels every tile has, and on each, the largest shape
    /// and the largest chunk on each axis.
    ///
    /// The largest chunk keeps the common case unregridded. A writer that
    /// clips a coarse level's chunk to the level gives the largest tile the
    /// largest chunk, so a smaller tile is regridded into one chunk rather
    /// than the largest tile into several.
    pub(crate) fn covering<'a>(
        tiles: impl IntoIterator<Item = &'a StoredLevels>,
        axes_names: &[String],
        dtype_size: u8,
        pinned: &[PinnedAxis],
    ) -> Result<Self, StoreError> {
        let mut shapes: Vec<Vec<u64>> = Vec::new();
        let mut chunk_shapes: Vec<Vec<u64>> = Vec::new();
        let mut first = true;
        for tile in tiles {
            let tile_chunks = tile.bindings.iter().map(|binding| &binding.chunk_shape);
            if first {
                shapes = tile.shapes.clone();
                chunk_shapes = tile_chunks.cloned().collect();
                first = false;
                continue;
            }
            shapes.truncate(tile.shapes.len());
            chunk_shapes.truncate(tile.bindings.len());
            for (declared, stored) in shapes.iter_mut().zip(&tile.shapes) {
                widen(declared, stored);
            }
            for (declared, stored) in chunk_shapes.iter_mut().zip(tile_chunks) {
                widen(declared, stored);
            }
        }
        shapes.truncate(chunk_shapes.len());
        let chunk_byte_layouts = chunk_shapes
            .iter()
            .enumerate()
            .map(|(level, chunk_shape)| {
                compute_chunk_byte_layout(axes_names, chunk_shape, dtype_size, pinned)
                    .map_err(|e| e.in_context(format!("level {level}")))
            })
            .collect::<Result<_, _>>()?;
        Ok(DeclaredLevels {
            shapes,
            chunk_shapes,
            chunk_byte_layouts,
        })
    }

    /// One tile's binding at the declared levels.
    pub(crate) fn bind(&self, tile: &StoredLevels) -> Vec<LevelBindingInfo> {
        tile.bindings
            .iter()
            .zip(&tile.shapes)
            .zip(self.chunk_shapes.iter().zip(&self.chunk_byte_layouts))
            .map(
                |((stored, stored_shape), (chunk_shape, chunk_byte_layout))| {
                    if stored.chunk_shape == *chunk_shape {
                        // A key past a smaller tile's grid names a chunk that was
                        // never written, so it reads as fill without a regrid.
                        return stored.clone();
                    }
                    LevelBindingInfo {
                        regrid: Some(Regrid {
                            chunk_shape: chunk_shape.clone(),
                            chunk_byte_layout: *chunk_byte_layout,
                            stored_shape: stored_shape.clone(),
                        }),
                        ..stored.clone()
                    }
                },
            )
            .collect()
    }
}

fn widen(declared: &mut [u64], stored: &[u64]) {
    for (d, s) in declared.iter_mut().zip(stored) {
        *d = (*d).max(*s);
    }
}

/// Tiles named in one mismatch sentence before the rest are counted.
const MISMATCH_EXAMPLES: usize = 5;

/// Relative difference under which two scales are the same. Writers derive
/// scale in floating point, so equal pixel sizes rarely compare bit-equal.
const SCALE_TOLERANCE: f64 = 1e-6;

/// What the declared geometry hides about `tiles`, one sentence per kind of
/// difference (shape, level count, pixel size), each naming the tiles.
/// Empty when every tile matches.
///
/// Pixel size is level 0's scale on the spatial axes, compared against the
/// representative's because every tile is shown at it. Shape is level 0's,
/// since coarser levels differ wherever level 0 does.
pub(crate) fn describe_mismatches(
    tiles: &[(&str, &StoredTile)],
    declared: &DeclaredLevels,
    representative: (&str, &StoredTile),
    axes_names: &[String],
) -> Vec<String> {
    let total = tiles.len();
    let mut sentences = Vec::new();

    if let Some(declared_shape) = declared.shapes.first() {
        let smaller: Vec<String> = tiles
            .iter()
            .filter_map(|(prefix, tile)| {
                let shape = tile.levels.shapes.first()?;
                (shape != declared_shape).then(|| format!("{prefix:?} is {}", dims(shape)))
            })
            .collect();
        if !smaller.is_empty() {
            sentences.push(format!(
                "tiles differ in shape, and smaller tiles are padded with fill to {} ({}), \
                 the largest on each axis. Smaller ({} of {total}): {}",
                dims(declared_shape),
                axes_names.join("×"),
                smaller.len(),
                examples(&smaller),
            ));
        }
    }

    let counts = tiles.iter().map(|(_, tile)| tile.levels.shapes.len());
    if let (Some(fewest), Some(most)) = (counts.clone().min(), counts.max())
        && fewest != most
    {
        let short: Vec<String> = tiles
            .iter()
            .filter(|(_, tile)| tile.levels.shapes.len() < most)
            .map(|(prefix, tile)| format!("{prefix:?} has {}", tile.levels.shapes.len()))
            .collect();
        sentences.push(format!(
            "tiles differ in level count, and every tile shows only the levels all of them \
             have ({fewest}). Fewer than {most} ({} of {total}): {}",
            short.len(),
            examples(&short),
        ));
    }

    let spatial: Vec<(usize, &str)> = [(2, "z"), (3, "y"), (4, "x")]
        .into_iter()
        .filter(|(_, name)| {
            axes_names
                .iter()
                .any(|axis| axis.eq_ignore_ascii_case(name))
        })
        .collect();
    let pixel_size = |scale: &[f64; 5]| {
        spatial
            .iter()
            .map(|(index, _)| scale[*index].to_string())
            .collect::<Vec<_>>()
            .join("×")
    };
    let (representative_prefix, representative_tile) = representative;
    let resized: Vec<String> = tiles
        .iter()
        .filter(|(_, tile)| {
            spatial.iter().any(|(index, _)| {
                !same_scale(tile.scale[*index], representative_tile.scale[*index])
            })
        })
        .map(|(prefix, tile)| format!("{prefix:?} is {}", pixel_size(&tile.scale)))
        .collect();
    if !resized.is_empty() {
        sentences.push(format!(
            "tiles differ in pixel size, and every tile is shown at {representative_prefix:?}'s \
             {} ({}). Different ({} of {total}): {}",
            pixel_size(&representative_tile.scale),
            spatial
                .iter()
                .map(|(_, name)| *name)
                .collect::<Vec<_>>()
                .join("×"),
            resized.len(),
            examples(&resized),
        ));
    }

    sentences
}

fn dims(shape: &[u64]) -> String {
    shape
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join("×")
}

fn examples(named: &[String]) -> String {
    let shown = named
        .iter()
        .take(MISMATCH_EXAMPLES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match named.len().saturating_sub(MISMATCH_EXAMPLES) {
        0 => shown,
        more => format!("{shown}, and {more} more"),
    }
}

fn same_scale(a: f64, b: f64) -> bool {
    (a - b).abs() <= SCALE_TOLERANCE * a.abs().max(b.abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::StorageCompression;

    fn axes() -> Vec<String> {
        ["c", "y", "x"].iter().map(|s| s.to_string()).collect()
    }

    fn binding(level: u32, chunk_shape: [u64; 3]) -> LevelBindingInfo {
        LevelBindingInfo {
            level_index: level,
            compression: StorageCompression::Zstd,
            chunk_shape: chunk_shape.to_vec(),
            chunk_byte_layout: compute_chunk_byte_layout(&axes(), &chunk_shape, 2, &[]).unwrap(),
            shard: None,
            regrid: None,
        }
    }

    fn tile(levels: &[([u64; 3], [u64; 3])]) -> StoredLevels {
        StoredLevels {
            shapes: levels.iter().map(|(shape, _)| shape.to_vec()).collect(),
            bindings: levels
                .iter()
                .enumerate()
                .map(|(level, (_, chunk))| binding(level as u32, *chunk))
                .collect(),
        }
    }

    fn declare(tiles: &[&StoredLevels]) -> DeclaredLevels {
        DeclaredLevels::covering(tiles.iter().copied(), &axes(), 2, &[]).unwrap()
    }

    #[test]
    fn the_declared_levels_cover_every_tile_on_every_axis() {
        let wide = tile(&[([2, 12, 16], [1, 8, 8]), ([2, 6, 8], [1, 6, 8])]);
        let tall = tile(&[([2, 16, 10], [1, 8, 8]), ([2, 8, 5], [1, 8, 5])]);

        let declared = declare(&[&wide, &tall]);

        assert_eq!(declared.shapes, vec![vec![2, 16, 16], vec![2, 8, 8]]);
        assert_eq!(declared.chunk_shapes, vec![vec![1, 8, 8], vec![1, 8, 8]]);
    }

    #[test]
    fn only_the_levels_every_tile_has_are_declared() {
        let deep = tile(&[([1, 16, 16], [1, 8, 8]), ([1, 8, 8], [1, 8, 8])]);
        let shallow = tile(&[([1, 12, 12], [1, 8, 8])]);

        let declared = declare(&[&deep, &shallow]);

        assert_eq!(declared.chunk_shapes, vec![vec![1, 8, 8]]);
        assert_eq!(declared.shapes, vec![vec![1, 16, 16]]);
        assert_eq!(declare(&[&deep]).bind(&shallow).len(), 1);
    }

    #[test]
    fn a_tile_stored_at_the_declared_chunk_is_bound_as_stored() {
        let large = tile(&[([1, 16, 16], [1, 8, 8])]);
        let small = tile(&[([1, 12, 10], [1, 8, 8])]);
        let declared = declare(&[&large, &small]);

        assert_eq!(declared.bind(&small), small.bindings);
    }

    #[test]
    fn a_tile_stored_at_another_chunk_is_regridded_to_the_declared_one() {
        let large = tile(&[([1, 8, 8], [1, 8, 8])]);
        let small = tile(&[([1, 6, 5], [1, 6, 5])]);
        let declared = declare(&[&small, &large]);

        let bound = declared.bind(&small);

        assert_eq!(
            bound[0].chunk_shape,
            vec![1, 6, 5],
            "the stored chunk stays described"
        );
        assert_eq!(
            bound[0].regrid,
            Some(Regrid {
                chunk_shape: vec![1, 8, 8],
                chunk_byte_layout: compute_chunk_byte_layout(&axes(), &[1, 8, 8], 2, &[]).unwrap(),
                stored_shape: vec![1, 6, 5],
            })
        );
        assert_eq!(declared.bind(&large), large.bindings);
    }

    fn stored(levels: StoredLevels, pixel: f64) -> StoredTile {
        StoredTile {
            levels,
            scale: [1.0, 1.0, 1.0, pixel, pixel],
        }
    }

    fn mismatches(tiles: &[(&str, &StoredTile)]) -> Vec<String> {
        let declared = declare(&tiles.iter().map(|(_, t)| &t.levels).collect::<Vec<_>>());
        describe_mismatches(tiles, &declared, tiles[0], &axes())
    }

    #[test]
    fn matching_tiles_have_nothing_to_name() {
        let a = stored(tile(&[([1, 16, 16], [1, 8, 8])]), 0.5);
        let b = stored(tile(&[([1, 16, 16], [1, 8, 8])]), 0.5 * (1.0 + 1e-9));

        assert!(mismatches(&[("A/1/0", &a), ("A/2/0", &b)]).is_empty());
    }

    #[test]
    fn each_kind_of_difference_names_the_tiles_it_hides() {
        let full = || tile(&[([1, 16, 16], [1, 8, 8]), ([1, 8, 8], [1, 8, 8])]);
        let rest = stored(full(), 0.5);
        let smaller = stored(
            tile(&[([1, 12, 10], [1, 8, 8]), ([1, 6, 5], [1, 6, 5])]),
            0.5,
        );
        let shallow = stored(tile(&[([1, 16, 16], [1, 8, 8])]), 0.5);
        let coarser = stored(full(), 1.0);

        let sentences = mismatches(&[
            ("A/1/0", &rest),
            ("A/2/0", &smaller),
            ("B/1/0", &shallow),
            ("B/2/0", &coarser),
        ]);

        assert_eq!(
            sentences,
            [
                "tiles differ in shape, and smaller tiles are padded with fill to 1×16×16 \
                 (c×y×x), the largest on each axis. Smaller (1 of 4): \"A/2/0\" is 1×12×10",
                "tiles differ in level count, and every tile shows only the levels all of \
                 them have (1). Fewer than 2 (1 of 4): \"B/1/0\" has 1",
                "tiles differ in pixel size, and every tile is shown at \"A/1/0\"'s 0.5×0.5 \
                 (y×x). Different (1 of 4): \"B/2/0\" is 1×1",
            ]
        );
    }

    #[test]
    fn a_long_list_of_tiles_is_counted_past_the_examples() {
        let large = stored(tile(&[([1, 16, 16], [1, 8, 8])]), 0.5);
        let small = stored(tile(&[([1, 8, 8], [1, 8, 8])]), 0.5);
        let names: Vec<String> = (0..7).map(|i| format!("B/{i}/0")).collect();
        let mut tiles = vec![("A/1/0", &large)];
        tiles.extend(names.iter().map(|name| (name.as_str(), &small)));

        let sentences = mismatches(&tiles);

        assert!(
            sentences[0].ends_with("\"B/4/0\" is 1×8×8, and 2 more"),
            "{}",
            sentences[0]
        );
        assert!(
            sentences[0].contains("Smaller (7 of 8)"),
            "{}",
            sentences[0]
        );
    }
}
