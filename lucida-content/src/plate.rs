//! Plate layout construction functions.
//!
//! Builds [`LayoutSpec`] placements and [`TransformEdge`]s for plate-based
//! datasets, replacing the old mutate-in-place approach with declarative output.

use std::collections::HashMap;

use crate::entity::{Entity, EntityKind};
use crate::id::{EntityId, LayoutId};
use crate::layout::{EntityPlacement, LayoutSpec};
use crate::transform::{TransformEdge, VoxelTransform};

/// Gap between FOV fields within a well, as a fraction of FOV width.
const FIELD_GAP_FRACTION: f64 = 0.08;

/// Gap between wells, as a fraction of FOV width.
const WELL_GAP_FRACTION: f64 = 0.20;

/// Errors that can occur during plate layout construction.
#[derive(Debug, Clone)]
pub enum PlateLayoutError {
    MissingFieldIndex { entity_id: EntityId },
    DuplicateFieldIndex { well_id: EntityId, field_index: u32 },
}

impl std::fmt::Display for PlateLayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlateLayoutError::MissingFieldIndex { entity_id } => {
                write!(
                    f,
                    "field entity {:?} is missing field_index label",
                    entity_id.0
                )
            }
            PlateLayoutError::DuplicateFieldIndex {
                well_id,
                field_index,
            } => {
                write!(
                    f,
                    "duplicate field_index {} in well {:?}",
                    field_index, well_id.0
                )
            }
        }
    }
}

impl std::error::Error for PlateLayoutError {}

/// Build a source layout that places wells in a grid.
/// Field positions within wells come from TransformEdges, not from this layout.
///
/// Only [`EntityKind::Well`] entities receive placements. Field entities are
/// used solely to derive per-well field counts for spacing calculations.
pub fn build_plate_layout(
    entities: &[Entity],
    _plate_rows: &[String],
    _plate_columns: &[String],
    fov_shape: [u64; 5], // [T, C, Z, Y, X]
) -> LayoutSpec {
    let wells: Vec<&Entity> = entities
        .iter()
        .filter(|e| e.kind == EntityKind::Well)
        .collect();

    let fields: Vec<&Entity> = entities
        .iter()
        .filter(|e| e.kind == EntityKind::Field)
        .collect();

    // Count fields per well.
    let mut fields_per_well: HashMap<&EntityId, usize> = HashMap::new();
    for field in &fields {
        if let Some(parent) = &field.parent {
            *fields_per_well.entry(parent).or_insert(0) += 1;
        }
    }

    // Max FOV count across all wells.
    let max_fov_count = fields_per_well.values().copied().max().unwrap_or(0).max(1);
    let fields_per_side = (max_fov_count as f64).sqrt().ceil() as u32;

    let fov_x = fov_shape[4] as f64;
    let fov_y = fov_shape[3] as f64;

    let well_cell_w =
        fields_per_side as f64 * fov_x * (1.0 + FIELD_GAP_FRACTION) + fov_x * WELL_GAP_FRACTION;
    let well_cell_h =
        fields_per_side as f64 * fov_y * (1.0 + FIELD_GAP_FRACTION) + fov_y * WELL_GAP_FRACTION;

    let mut placements = Vec::with_capacity(wells.len());
    for well in &wells {
        let col_index = well.labels.column_index.unwrap_or(0) as f64;
        let row_index = well.labels.row_index.unwrap_or(0) as f64;
        placements.push(EntityPlacement {
            entity_id: well.id.clone(),
            position: [col_index * well_cell_w, row_index * well_cell_h],
        });
    }

    LayoutSpec {
        id: LayoutId("source".into()),
        name: "Source".into(),
        placements,
    }
}

/// Build field->well [`TransformEdge`]s for grid-positioned plates.
///
/// Returns an error if any field is missing `field_index` or has duplicate
/// `field_index` within its well.
pub fn build_grid_field_transforms(
    _well_entities: &[Entity],
    field_entities: &[Entity],
    fov_shape: [u64; 5],
) -> Result<Vec<TransformEdge>, PlateLayoutError> {
    // Group fields by parent well.
    let mut fields_by_well: HashMap<&EntityId, Vec<&Entity>> = HashMap::new();
    for field in field_entities {
        if let Some(parent) = &field.parent {
            fields_by_well.entry(parent).or_default().push(field);
        }
    }

    let fov_x = fov_shape[4] as f64;
    let fov_y = fov_shape[3] as f64;
    let gap_x = FIELD_GAP_FRACTION * fov_x;
    let gap_y = FIELD_GAP_FRACTION * fov_y;

    let mut transforms = Vec::new();

    for (well_id, well_fields) in &fields_by_well {
        // Validate: each field must have a field_index.
        let mut indexed: Vec<(u32, &Entity)> = Vec::with_capacity(well_fields.len());
        for field in well_fields {
            let fi =
                field
                    .labels
                    .field_index
                    .ok_or_else(|| PlateLayoutError::MissingFieldIndex {
                        entity_id: field.id.clone(),
                    })?;
            indexed.push((fi, field));
        }

        // Sort by field_index.
        indexed.sort_by_key(|(fi, _)| *fi);

        // Check for duplicates.
        for window in indexed.windows(2) {
            if window[0].0 == window[1].0 {
                return Err(PlateLayoutError::DuplicateFieldIndex {
                    well_id: (*well_id).clone(),
                    field_index: window[0].0,
                });
            }
        }

        let n_fields = indexed.len();
        let cols = (n_fields as f64).sqrt().ceil() as usize;

        for (i, (_, field)) in indexed.iter().enumerate() {
            let col = i % cols;
            let row = i / cols;
            let tx = col as f64 * (fov_x + gap_x);
            let ty = row as f64 * (fov_y + gap_y);

            transforms.push(TransformEdge {
                from: field.id.clone(),
                to: (*well_id).clone(),
                transform: VoxelTransform::from_voxel_translation_2d(tx, ty),
            });
        }
    }

    Ok(transforms)
}

/// Compute the bounding box of a plate from well placements and
/// field extents within each well. Returns `[width, height]`.
pub fn plate_extent(
    layout: &LayoutSpec,
    field_transforms: &[TransformEdge],
    fov_shape: [u64; 5],
) -> [f64; 2] {
    let fov_x = fov_shape[4] as f64;
    let fov_y = fov_shape[3] as f64;

    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;

    for placement in &layout.placements {
        // Find field transforms targeting this well.
        let well_field_transforms: Vec<&TransformEdge> = field_transforms
            .iter()
            .filter(|t| t.to == placement.entity_id)
            .collect();

        if well_field_transforms.is_empty() {
            // Well with no fields: extent is well position + fov size.
            max_x = max_x.max(placement.position[0] + fov_x);
            max_y = max_y.max(placement.position[1] + fov_y);
        } else {
            for t in &well_field_transforms {
                let field_tx = t.transform.matrix()[12];
                let field_ty = t.transform.matrix()[13];
                max_x = max_x.max(placement.position[0] + field_tx + fov_x);
                max_y = max_y.max(placement.position[1] + field_ty + fov_y);
            }
        }
    }

    [max_x, max_y]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::EntityLabels;

    fn make_well(id: &str, row: u32, col: u32) -> Entity {
        Entity {
            id: EntityId(id.to_string()),
            kind: EntityKind::Well,
            parent: None,
            labels: EntityLabels {
                name: Some(format!("{}/{}", (b'A' + row as u8) as char, col + 1)),
                row_index: Some(row),
                column_index: Some(col),
                ..Default::default()
            },
        }
    }

    fn make_field(id: &str, well_id: &str, field_index: Option<u32>) -> Entity {
        Entity {
            id: EntityId(id.to_string()),
            kind: EntityKind::Field,
            parent: Some(EntityId(well_id.to_string())),
            labels: EntityLabels {
                field_index,
                ..Default::default()
            },
        }
    }

    // ---- Positive tests ----

    #[test]
    fn two_by_three_plate_single_fov() {
        // 2 rows x 3 columns, 1 FOV per well.
        let wells = vec![
            make_well("w-00", 0, 0),
            make_well("w-01", 0, 1),
            make_well("w-02", 0, 2),
            make_well("w-10", 1, 0),
            make_well("w-11", 1, 1),
            make_well("w-12", 1, 2),
        ];
        let fields: Vec<Entity> = wells
            .iter()
            .enumerate()
            .map(|(i, w)| make_field(&format!("f-{i}"), &w.id.0, Some(0)))
            .collect();

        let mut entities: Vec<Entity> = wells.clone();
        entities.extend(fields.clone());

        let fov_shape: [u64; 5] = [1, 1, 10, 512, 512];
        let rows = vec!["A".into(), "B".into()];
        let cols = vec!["1".into(), "2".into(), "3".into()];

        let layout = build_plate_layout(&entities, &rows, &cols, fov_shape);
        assert_eq!(layout.placements.len(), 6);

        let fov_x = 512.0;
        let fov_y = 512.0;
        // 1 field per well => fields_per_side = 1
        let well_cell_w = 1.0 * fov_x * (1.0 + FIELD_GAP_FRACTION) + fov_x * WELL_GAP_FRACTION;
        let well_cell_h = 1.0 * fov_y * (1.0 + FIELD_GAP_FRACTION) + fov_y * WELL_GAP_FRACTION;

        // Well (0,0) at origin.
        let p00 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-00")
            .unwrap();
        assert!((p00.position[0]).abs() < 1e-9);
        assert!((p00.position[1]).abs() < 1e-9);

        // Well (0,1) at (well_cell_w, 0).
        let p01 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-01")
            .unwrap();
        assert!((p01.position[0] - well_cell_w).abs() < 1e-9);
        assert!((p01.position[1]).abs() < 1e-9);

        // Well (0,2) at (2*well_cell_w, 0).
        let p02 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-02")
            .unwrap();
        assert!((p02.position[0] - 2.0 * well_cell_w).abs() < 1e-9);
        assert!((p02.position[1]).abs() < 1e-9);

        // Well (1,0) at (0, well_cell_h).
        let p10 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-10")
            .unwrap();
        assert!((p10.position[0]).abs() < 1e-9);
        assert!((p10.position[1] - well_cell_h).abs() < 1e-9);

        // Well (1,1) at (well_cell_w, well_cell_h).
        let p11 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-11")
            .unwrap();
        assert!((p11.position[0] - well_cell_w).abs() < 1e-9);
        assert!((p11.position[1] - well_cell_h).abs() < 1e-9);

        // Well (1,2) at (2*well_cell_w, well_cell_h).
        let p12 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-12")
            .unwrap();
        assert!((p12.position[0] - 2.0 * well_cell_w).abs() < 1e-9);
        assert!((p12.position[1] - well_cell_h).abs() < 1e-9);

        // Field transforms: single field per well => all at origin.
        let well_ents: Vec<Entity> = wells.clone();
        let transforms = build_grid_field_transforms(&well_ents, &fields, fov_shape).unwrap();
        assert_eq!(transforms.len(), 6);

        for t in &transforms {
            assert!((t.transform.matrix()[12]).abs() < 1e-9, "tx should be 0");
            assert!((t.transform.matrix()[13]).abs() < 1e-9, "ty should be 0");
        }
    }

    #[test]
    fn two_by_two_plate_four_fovs() {
        // 2x2 plate, 4 FOVs per well.
        let wells = vec![
            make_well("w-00", 0, 0),
            make_well("w-01", 0, 1),
            make_well("w-10", 1, 0),
            make_well("w-11", 1, 1),
        ];

        let mut fields = Vec::new();
        for well in &wells {
            for fi in 0..4u32 {
                fields.push(make_field(
                    &format!("f-{}-{fi}", well.id.0),
                    &well.id.0,
                    Some(fi),
                ));
            }
        }

        let mut entities: Vec<Entity> = wells.clone();
        entities.extend(fields.clone());

        let fov_shape: [u64; 5] = [1, 1, 10, 256, 256];
        let rows = vec!["A".into(), "B".into()];
        let cols = vec!["1".into(), "2".into()];

        let layout = build_plate_layout(&entities, &rows, &cols, fov_shape);
        assert_eq!(layout.placements.len(), 4);

        let fov_x = 256.0;
        let fov_y = 256.0;
        // 4 fields => fields_per_side = ceil(sqrt(4)) = 2
        let well_cell_w = 2.0 * fov_x * (1.0 + FIELD_GAP_FRACTION) + fov_x * WELL_GAP_FRACTION;
        let well_cell_h = 2.0 * fov_y * (1.0 + FIELD_GAP_FRACTION) + fov_y * WELL_GAP_FRACTION;

        let p01 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-01")
            .unwrap();
        assert!((p01.position[0] - well_cell_w).abs() < 1e-9);
        assert!((p01.position[1]).abs() < 1e-9);

        let p10 = layout
            .placements
            .iter()
            .find(|p| p.entity_id.0 == "w-10")
            .unwrap();
        assert!((p10.position[0]).abs() < 1e-9);
        assert!((p10.position[1] - well_cell_h).abs() < 1e-9);

        // Field transforms: 2x2 grid per well.
        let transforms = build_grid_field_transforms(&wells, &fields, fov_shape).unwrap();
        assert_eq!(transforms.len(), 16);

        let gap_x = FIELD_GAP_FRACTION * fov_x;
        let gap_y = FIELD_GAP_FRACTION * fov_y;

        // Check one well's fields in detail (w-00).
        let mut w00_transforms: Vec<&TransformEdge> =
            transforms.iter().filter(|t| t.to.0 == "w-00").collect();
        w00_transforms.sort_by(|a, b| a.from.0.cmp(&b.from.0));
        assert_eq!(w00_transforms.len(), 4);

        // field 0 at (0, 0)
        assert!((w00_transforms[0].transform.matrix()[12]).abs() < 1e-9);
        assert!((w00_transforms[0].transform.matrix()[13]).abs() < 1e-9);
        // field 1 at (fov_x + gap_x, 0)
        assert!((w00_transforms[1].transform.matrix()[12] - (fov_x + gap_x)).abs() < 1e-9);
        assert!((w00_transforms[1].transform.matrix()[13]).abs() < 1e-9);
        // field 2 at (0, fov_y + gap_y)
        assert!((w00_transforms[2].transform.matrix()[12]).abs() < 1e-9);
        assert!((w00_transforms[2].transform.matrix()[13] - (fov_y + gap_y)).abs() < 1e-9);
        // field 3 at (fov_x + gap_x, fov_y + gap_y)
        assert!((w00_transforms[3].transform.matrix()[12] - (fov_x + gap_x)).abs() < 1e-9);
        assert!((w00_transforms[3].transform.matrix()[13] - (fov_y + gap_y)).abs() < 1e-9);
    }

    #[test]
    fn plate_extent_two_by_three() {
        // Same 2x3 plate from test 1.
        let wells = vec![
            make_well("w-00", 0, 0),
            make_well("w-01", 0, 1),
            make_well("w-02", 0, 2),
            make_well("w-10", 1, 0),
            make_well("w-11", 1, 1),
            make_well("w-12", 1, 2),
        ];
        let fields: Vec<Entity> = wells
            .iter()
            .enumerate()
            .map(|(i, w)| make_field(&format!("f-{i}"), &w.id.0, Some(0)))
            .collect();

        let mut entities: Vec<Entity> = wells.clone();
        entities.extend(fields.clone());

        let fov_shape: [u64; 5] = [1, 1, 10, 512, 512];
        let rows = vec!["A".into(), "B".into()];
        let cols = vec!["1".into(), "2".into(), "3".into()];

        let layout = build_plate_layout(&entities, &rows, &cols, fov_shape);
        let transforms = build_grid_field_transforms(&wells, &fields, fov_shape).unwrap();

        let extent = plate_extent(&layout, &transforms, fov_shape);

        let fov_x = 512.0;
        let fov_y = 512.0;
        let well_cell_w = 1.0 * fov_x * (1.0 + FIELD_GAP_FRACTION) + fov_x * WELL_GAP_FRACTION;
        let well_cell_h = 1.0 * fov_y * (1.0 + FIELD_GAP_FRACTION) + fov_y * WELL_GAP_FRACTION;

        // Rightmost well at col 2: x = 2 * well_cell_w, field at tx=0 => extent_x = 2*well_cell_w + fov_x
        let expected_x = 2.0 * well_cell_w + fov_x;
        // Bottom well at row 1: y = well_cell_h, field at ty=0 => extent_y = well_cell_h + fov_y
        let expected_y = 1.0 * well_cell_h + fov_y;

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

    // ---- Negative tests ----

    #[test]
    fn missing_field_index_error() {
        let wells = vec![make_well("w-00", 0, 0)];
        let fields = vec![make_field("f-0", "w-00", None)]; // no field_index

        let result = build_grid_field_transforms(&wells, &fields, [1, 1, 1, 256, 256]);
        assert!(result.is_err());
        match result.unwrap_err() {
            PlateLayoutError::MissingFieldIndex { entity_id } => {
                assert_eq!(entity_id.0, "f-0");
            }
            other => panic!("expected MissingFieldIndex, got {:?}", other),
        }
    }

    #[test]
    fn duplicate_field_index_error() {
        let wells = vec![make_well("w-00", 0, 0)];
        let fields = vec![
            make_field("f-0", "w-00", Some(0)),
            make_field("f-1", "w-00", Some(0)), // duplicate
        ];

        let result = build_grid_field_transforms(&wells, &fields, [1, 1, 1, 256, 256]);
        assert!(result.is_err());
        match result.unwrap_err() {
            PlateLayoutError::DuplicateFieldIndex {
                well_id,
                field_index,
            } => {
                assert_eq!(well_id.0, "w-00");
                assert_eq!(field_index, 0);
            }
            other => panic!("expected DuplicateFieldIndex, got {:?}", other),
        }
    }
}
