//! Collection layout construction functions.
//!
//! Builds [`LayoutSpec`] placements and [`TransformEdge`]s for collection-based
//! datasets, replacing the old mutate-in-place approach with declarative output.

use std::collections::HashMap;

use crate::entity::{Entity, EntityKind};
use crate::id::{EntityId, LayoutId};
use crate::layout::{EntityPlacement, LayoutSpec};
use crate::transform::{TransformEdge, VoxelTransform};

/// Gap between tiles within a group, as a fraction of tile width.
const TILE_GAP_FRACTION: f64 = 0.08;

/// Gap between groups, as a fraction of tile width.
const GROUP_GAP_FRACTION: f64 = 0.20;

/// Errors that can occur during collection layout construction.
#[derive(Debug, Clone)]
pub enum CollectionLayoutError {
    MissingTileIndex { entity_id: EntityId },
    DuplicateTileIndex { group_id: EntityId, tile_index: u32 },
}

impl std::fmt::Display for CollectionLayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CollectionLayoutError::MissingTileIndex { entity_id } => {
                write!(
                    f,
                    "tile entity {:?} is missing tile_index label",
                    entity_id.0
                )
            }
            CollectionLayoutError::DuplicateTileIndex {
                group_id,
                tile_index,
            } => {
                write!(
                    f,
                    "duplicate tile_index {} in group {:?}",
                    tile_index, group_id.0
                )
            }
        }
    }
}

impl std::error::Error for CollectionLayoutError {}

/// Build a source layout that places groups in a grid.
/// Tile positions within groups come from TransformEdges, not from this layout.
///
/// Only [`EntityKind::Group`] entities receive placements. Tile entities are
/// used solely to derive per-group tile counts for spacing calculations.
pub fn build_collection_layout(
    entities: &[Entity],
    _collection_rows: &[String],
    _collection_columns: &[String],
    tile_shape: [u64; 5], // [T, C, Z, Y, X]
) -> LayoutSpec {
    let groups: Vec<&Entity> = entities
        .iter()
        .filter(|e| e.kind == EntityKind::Group)
        .collect();

    let tiles: Vec<&Entity> = entities
        .iter()
        .filter(|e| e.kind == EntityKind::Tile)
        .collect();

    // Count tiles per group.
    let mut tiles_per_group: HashMap<&EntityId, usize> = HashMap::new();
    for tile in &tiles {
        if let Some(parent) = &tile.parent {
            *tiles_per_group.entry(parent).or_insert(0) += 1;
        }
    }

    // Max tile count across all groups.
    let max_tile_count = tiles_per_group.values().copied().max().unwrap_or(0).max(1);
    let tiles_per_side = (max_tile_count as f64).sqrt().ceil() as u32;

    let tile_x = tile_shape[4] as f64;
    let tile_y = tile_shape[3] as f64;

    let group_cell_w =
        tiles_per_side as f64 * tile_x * (1.0 + TILE_GAP_FRACTION) + tile_x * GROUP_GAP_FRACTION;
    let group_cell_h =
        tiles_per_side as f64 * tile_y * (1.0 + TILE_GAP_FRACTION) + tile_y * GROUP_GAP_FRACTION;

    let mut placements = Vec::with_capacity(groups.len());
    for group in &groups {
        let col_index = group.labels.column_index.unwrap_or(0) as f64;
        let row_index = group.labels.row_index.unwrap_or(0) as f64;
        placements.push(EntityPlacement {
            entity_id: group.id.clone(),
            position: [col_index * group_cell_w, row_index * group_cell_h],
        });
    }

    LayoutSpec {
        id: LayoutId("source".into()),
        name: "Source".into(),
        placements,
    }
}

/// Build tile->group [`TransformEdge`]s for grid-positioned collections.
///
/// Returns an error if any tile is missing `tile_index` or has duplicate
/// `tile_index` within its group.
pub fn build_grid_tile_transforms(
    _group_entities: &[Entity],
    tile_entities: &[Entity],
    tile_shape: [u64; 5],
) -> Result<Vec<TransformEdge>, CollectionLayoutError> {
    // Group tiles by parent group.
    let mut tiles_by_group: HashMap<&EntityId, Vec<&Entity>> = HashMap::new();
    for tile in tile_entities {
        if let Some(parent) = &tile.parent {
            tiles_by_group.entry(parent).or_default().push(tile);
        }
    }

    let tile_x = tile_shape[4] as f64;
    let tile_y = tile_shape[3] as f64;
    let gap_x = TILE_GAP_FRACTION * tile_x;
    let gap_y = TILE_GAP_FRACTION * tile_y;

    let mut transforms = Vec::new();

    for (group_id, group_tiles) in &tiles_by_group {
        // Validate: each tile must have a tile_index.
        let mut indexed: Vec<(u32, &Entity)> = Vec::with_capacity(group_tiles.len());
        for tile in group_tiles {
            let fi =
                tile.labels
                    .tile_index
                    .ok_or_else(|| CollectionLayoutError::MissingTileIndex {
                        entity_id: tile.id.clone(),
                    })?;
            indexed.push((fi, tile));
        }

        // Sort by tile_index.
        indexed.sort_by_key(|(fi, _)| *fi);

        // Check for duplicates.
        for window in indexed.windows(2) {
            if window[0].0 == window[1].0 {
                return Err(CollectionLayoutError::DuplicateTileIndex {
                    group_id: (*group_id).clone(),
                    tile_index: window[0].0,
                });
            }
        }

        let n_tiles = indexed.len();
        let cols = (n_tiles as f64).sqrt().ceil() as usize;

        for (i, (_, tile)) in indexed.iter().enumerate() {
            let col = i % cols;
            let row = i / cols;
            let tx = col as f64 * (tile_x + gap_x);
            let ty = row as f64 * (tile_y + gap_y);

            transforms.push(TransformEdge {
                from: tile.id.clone(),
                to: (*group_id).clone(),
                transform: VoxelTransform::from_voxel_translation_2d(tx, ty),
            });
        }
    }

    Ok(transforms)
}

/// Compute the bounding box of a collection from group placements and
/// tile extents within each group. Returns `[width, height]`.
pub fn collection_extent(
    layout: &LayoutSpec,
    tile_transforms: &[TransformEdge],
    tile_shape: [u64; 5],
) -> [f64; 2] {
    let tile_x = tile_shape[4] as f64;
    let tile_y = tile_shape[3] as f64;

    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;

    for placement in &layout.placements {
        // Find tile transforms targeting this group.
        let group_tile_transforms: Vec<&TransformEdge> = tile_transforms
            .iter()
            .filter(|t| t.to == placement.entity_id)
            .collect();

        if group_tile_transforms.is_empty() {
            // Group with no tiles: extent is group position + tile size.
            max_x = max_x.max(placement.position[0] + tile_x);
            max_y = max_y.max(placement.position[1] + tile_y);
        } else {
            for t in &group_tile_transforms {
                let tile_tx = t.transform.matrix()[12];
                let tile_ty = t.transform.matrix()[13];
                max_x = max_x.max(placement.position[0] + tile_tx + tile_x);
                max_y = max_y.max(placement.position[1] + tile_ty + tile_y);
            }
        }
    }

    [max_x, max_y]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::EntityLabels;

    fn make_group(id: &str, row: u32, col: u32) -> Entity {
        Entity {
            id: EntityId(id.to_string()),
            kind: EntityKind::Group,
            parent: None,
            labels: EntityLabels {
                name: Some(format!("{}/{}", (b'A' + row as u8) as char, col + 1)),
                row_index: Some(row),
                column_index: Some(col),
                ..Default::default()
            },
        }
    }

    fn make_tile(id: &str, group_id: &str, tile_index: Option<u32>) -> Entity {
        Entity {
            id: EntityId(id.to_string()),
            kind: EntityKind::Tile,
            parent: Some(EntityId(group_id.to_string())),
            labels: EntityLabels {
                tile_index,
                ..Default::default()
            },
        }
    }

    #[test]
    fn two_by_three_collection_single_tile() {
        // 2 rows x 3 columns, 1 tile per group.
        let groups = vec![
            make_group("w-00", 0, 0),
            make_group("w-01", 0, 1),
            make_group("w-02", 0, 2),
            make_group("w-10", 1, 0),
            make_group("w-11", 1, 1),
            make_group("w-12", 1, 2),
        ];
        let tiles: Vec<Entity> = groups
            .iter()
            .enumerate()
            .map(|(i, w)| make_tile(&format!("f-{i}"), &w.id.0, Some(0)))
            .collect();

        let mut entities: Vec<Entity> = groups.clone();
        entities.extend(tiles.clone());

        let tile_shape: [u64; 5] = [1, 1, 10, 512, 512];
        let rows = vec!["A".into(), "B".into()];
        let cols = vec!["1".into(), "2".into(), "3".into()];

        let layout = build_collection_layout(&entities, &rows, &cols, tile_shape);
        assert_eq!(layout.placements.len(), 6);

        let tile_x = 512.0;
        let tile_y = 512.0;
        // 1 tile per group => tiles_per_side = 1
        let group_cell_w = 1.0 * tile_x * (1.0 + TILE_GAP_FRACTION) + tile_x * GROUP_GAP_FRACTION;
        let group_cell_h = 1.0 * tile_y * (1.0 + TILE_GAP_FRACTION) + tile_y * GROUP_GAP_FRACTION;

        // Group (0,0) at origin.
        let p00 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-00")
            .unwrap();
        assert!((p00.position[0]).abs() < 1e-9);
        assert!((p00.position[1]).abs() < 1e-9);

        // Group (0,1) at (group_cell_w, 0).
        let p01 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-01")
            .unwrap();
        assert!((p01.position[0] - group_cell_w).abs() < 1e-9);
        assert!((p01.position[1]).abs() < 1e-9);

        // Group (0,2) at (2*group_cell_w, 0).
        let p02 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-02")
            .unwrap();
        assert!((p02.position[0] - 2.0 * group_cell_w).abs() < 1e-9);
        assert!((p02.position[1]).abs() < 1e-9);

        // Group (1,0) at (0, group_cell_h).
        let p10 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-10")
            .unwrap();
        assert!((p10.position[0]).abs() < 1e-9);
        assert!((p10.position[1] - group_cell_h).abs() < 1e-9);

        // Group (1,1) at (group_cell_w, group_cell_h).
        let p11 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-11")
            .unwrap();
        assert!((p11.position[0] - group_cell_w).abs() < 1e-9);
        assert!((p11.position[1] - group_cell_h).abs() < 1e-9);

        // Group (1,2) at (2*group_cell_w, group_cell_h).
        let p12 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-12")
            .unwrap();
        assert!((p12.position[0] - 2.0 * group_cell_w).abs() < 1e-9);
        assert!((p12.position[1] - group_cell_h).abs() < 1e-9);

        // Tile transforms: single tile per group => all at origin.
        let group_ents: Vec<Entity> = groups.clone();
        let transforms = build_grid_tile_transforms(&group_ents, &tiles, tile_shape).unwrap();
        assert_eq!(transforms.len(), 6);

        for t in &transforms {
            assert!((t.transform.matrix()[12]).abs() < 1e-9, "tx should be 0");
            assert!((t.transform.matrix()[13]).abs() < 1e-9, "ty should be 0");
        }
    }

    #[test]
    fn two_by_two_collection_four_tiles() {
        // 2x2 collection, 4 tiles per group.
        let groups = vec![
            make_group("w-00", 0, 0),
            make_group("w-01", 0, 1),
            make_group("w-10", 1, 0),
            make_group("w-11", 1, 1),
        ];

        let mut tiles = Vec::new();
        for group in &groups {
            for fi in 0..4u32 {
                tiles.push(make_tile(
                    &format!("f-{}-{fi}", group.id.0),
                    &group.id.0,
                    Some(fi),
                ));
            }
        }

        let mut entities: Vec<Entity> = groups.clone();
        entities.extend(tiles.clone());

        let tile_shape: [u64; 5] = [1, 1, 10, 256, 256];
        let rows = vec!["A".into(), "B".into()];
        let cols = vec!["1".into(), "2".into()];

        let layout = build_collection_layout(&entities, &rows, &cols, tile_shape);
        assert_eq!(layout.placements.len(), 4);

        let tile_x = 256.0;
        let tile_y = 256.0;
        // 4 tiles => tiles_per_side = ceil(sqrt(4)) = 2
        let group_cell_w = 2.0 * tile_x * (1.0 + TILE_GAP_FRACTION) + tile_x * GROUP_GAP_FRACTION;
        let group_cell_h = 2.0 * tile_y * (1.0 + TILE_GAP_FRACTION) + tile_y * GROUP_GAP_FRACTION;

        let p01 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-01")
            .unwrap();
        assert!((p01.position[0] - group_cell_w).abs() < 1e-9);
        assert!((p01.position[1]).abs() < 1e-9);

        let p10 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-10")
            .unwrap();
        assert!((p10.position[0]).abs() < 1e-9);
        assert!((p10.position[1] - group_cell_h).abs() < 1e-9);

        // Tile transforms: 2x2 grid per group.
        let transforms = build_grid_tile_transforms(&groups, &tiles, tile_shape).unwrap();
        assert_eq!(transforms.len(), 16);

        let gap_x = TILE_GAP_FRACTION * tile_x;
        let gap_y = TILE_GAP_FRACTION * tile_y;

        // Check one group's tiles in detail (w-00).
        let mut w00_transforms: Vec<&TransformEdge> =
            transforms.iter().filter(|t| t.to.0 == "w-00").collect();
        w00_transforms.sort_by(|a, b| a.from.0.cmp(&b.from.0));
        assert_eq!(w00_transforms.len(), 4);

        // tile 0 at (0, 0)
        assert!((w00_transforms[0].transform.matrix()[12]).abs() < 1e-9);
        assert!((w00_transforms[0].transform.matrix()[13]).abs() < 1e-9);
        // tile 1 at (tile_x + gap_x, 0)
        assert!((w00_transforms[1].transform.matrix()[12] - (tile_x + gap_x)).abs() < 1e-9);
        assert!((w00_transforms[1].transform.matrix()[13]).abs() < 1e-9);
        // tile 2 at (0, tile_y + gap_y)
        assert!((w00_transforms[2].transform.matrix()[12]).abs() < 1e-9);
        assert!((w00_transforms[2].transform.matrix()[13] - (tile_y + gap_y)).abs() < 1e-9);
        // tile 3 at (tile_x + gap_x, tile_y + gap_y)
        assert!((w00_transforms[3].transform.matrix()[12] - (tile_x + gap_x)).abs() < 1e-9);
        assert!((w00_transforms[3].transform.matrix()[13] - (tile_y + gap_y)).abs() < 1e-9);
    }

    #[test]
    fn collection_extent_two_by_three() {
        // Same 2x3 collection from test 1.
        let groups = vec![
            make_group("w-00", 0, 0),
            make_group("w-01", 0, 1),
            make_group("w-02", 0, 2),
            make_group("w-10", 1, 0),
            make_group("w-11", 1, 1),
            make_group("w-12", 1, 2),
        ];
        let tiles: Vec<Entity> = groups
            .iter()
            .enumerate()
            .map(|(i, w)| make_tile(&format!("f-{i}"), &w.id.0, Some(0)))
            .collect();

        let mut entities: Vec<Entity> = groups.clone();
        entities.extend(tiles.clone());

        let tile_shape: [u64; 5] = [1, 1, 10, 512, 512];
        let rows = vec!["A".into(), "B".into()];
        let cols = vec!["1".into(), "2".into(), "3".into()];

        let layout = build_collection_layout(&entities, &rows, &cols, tile_shape);
        let transforms = build_grid_tile_transforms(&groups, &tiles, tile_shape).unwrap();

        let extent = collection_extent(&layout, &transforms, tile_shape);

        let tile_x = 512.0;
        let tile_y = 512.0;
        let group_cell_w = 1.0 * tile_x * (1.0 + TILE_GAP_FRACTION) + tile_x * GROUP_GAP_FRACTION;
        let group_cell_h = 1.0 * tile_y * (1.0 + TILE_GAP_FRACTION) + tile_y * GROUP_GAP_FRACTION;

        // Rightmost group at col 2: x = 2 * group_cell_w, tile at tx=0 => extent_x = 2*group_cell_w + tile_x
        let expected_x = 2.0 * group_cell_w + tile_x;
        // Bottom group at row 1: y = group_cell_h, tile at ty=0 => extent_y = group_cell_h + tile_y
        let expected_y = 1.0 * group_cell_h + tile_y;

        assert!(
            (extent[0] - expected_x).abs() < 1e-9,
            "extent_x: got {} expected {}",
            extent[0],
            expected_x
        );
        assert!(
            (extent[1] - expected_y).abs() < 1e-9,
            "extent_y: got {} expected {}",
            extent[1],
            expected_y
        );
    }

    #[test]
    fn missing_tile_index_error() {
        let groups = vec![make_group("w-00", 0, 0)];
        let tiles = vec![make_tile("f-0", "w-00", None)]; // no tile_index

        let result = build_grid_tile_transforms(&groups, &tiles, [1, 1, 1, 256, 256]);
        assert!(result.is_err());
        match result.unwrap_err() {
            CollectionLayoutError::MissingTileIndex { entity_id } => {
                assert_eq!(entity_id.0, "f-0");
            }
            other => panic!("expected MissingTileIndex, got {:?}", other),
        }
    }

    #[test]
    fn duplicate_tile_index_error() {
        let groups = vec![make_group("w-00", 0, 0)];
        let tiles = vec![
            make_tile("f-0", "w-00", Some(0)),
            make_tile("f-1", "w-00", Some(0)), // duplicate
        ];

        let result = build_grid_tile_transforms(&groups, &tiles, [1, 1, 1, 256, 256]);
        assert!(result.is_err());
        match result.unwrap_err() {
            CollectionLayoutError::DuplicateTileIndex {
                group_id,
                tile_index,
            } => {
                assert_eq!(group_id.0, "w-00");
                assert_eq!(tile_index, 0);
            }
            other => panic!("expected DuplicateTileIndex, got {:?}", other),
        }
    }
}
