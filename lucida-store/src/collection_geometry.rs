//! One declared geometry for every tile of a collection.
//!
//! The client sees one multiscale per collection, but OME-Zarr lets each tile
//! store its own level shapes and chunk shapes. The declared geometry covers
//! every tile, and each tile is bound to it: as stored where its chunk shape
//! is the declared one, and through a [`Regrid`] where it is not.

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
}
