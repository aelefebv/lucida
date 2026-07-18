//! Reusable admission validation for [`DatasetManifest`](crate::DatasetManifest).
//!
//! Serialization proves that a payload has the right Rust *shape*.  It does not
//! prove that identifiers are unique, references resolve, geometry is finite,
//! or chunk grids agree with their shapes.  This module owns those semantic
//! invariants so importers, persistence restores, native clients, and WASM all
//! make the same admission decision.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{
    AxisKind, DataType, DatasetManifest, EntityKind, ImageSpec, LABEL_BACKGROUND_ID,
    MultiscaleInfo, normalize::axis_index,
};

/// Stable category for a semantic validation failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationCategory {
    Missing,
    Duplicate,
    InvalidReference,
    InvalidValue,
    InconsistentShape,
    ResourceLimit,
    Unsupported,
}

/// One path-addressed semantic validation failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestValidationError {
    pub category: ValidationCategory,
    pub path: String,
    pub message: String,
}

impl ManifestValidationError {
    fn new(
        category: ValidationCategory,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ManifestValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} ({:?})", self.path, self.message, self.category)
    }
}

/// All semantic failures found in one bounded validation pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestValidationErrors(pub Vec<ManifestValidationError>);

impl ManifestValidationErrors {
    pub fn errors(&self) -> &[ManifestValidationError] {
        &self.0
    }
}

impl fmt::Display for ManifestValidationErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, error) in self.0.iter().enumerate() {
            if index > 0 {
                f.write_str("; ")?;
            }
            error.fmt(f)?;
        }
        Ok(())
    }
}

impl std::error::Error for ManifestValidationErrors {}

// These are admission limits, not product/UI limits.  They sit far above
// ordinary datasets but keep a tiny JSON payload from expanding into
// unbounded graph work or allocation.
pub const MAX_MANIFEST_ENTITIES: usize = 1_000_000;
pub const MAX_MANIFEST_IMAGES: usize = 1_000_000;
pub const MAX_LEVELS_PER_IMAGE: usize = 1024;
pub const MAX_IDENTIFIER_BYTES: usize = 4096;
pub const MAX_LABEL_COLORS: usize = 1 << 16;

impl DatasetManifest {
    /// Validate graph, layout, image, label, and numeric invariants.
    ///
    /// The pass is read-only and bounded by the declared admission limits.  It
    /// intentionally reports multiple independent errors so an invalid source
    /// can be repaired in one iteration rather than one field at a time.
    pub fn validate(&self) -> Result<(), ManifestValidationErrors> {
        let mut errors = Vec::new();

        validate_text(&mut errors, "dataset_id", &self.dataset_id.0, false);
        validate_text(&mut errors, "name", &self.name, true);

        if self.entities().len() > MAX_MANIFEST_ENTITIES {
            errors.push(ManifestValidationError::new(
                ValidationCategory::ResourceLimit,
                "entities",
                format!(
                    "declares {} entities; limit is {MAX_MANIFEST_ENTITIES}",
                    self.entities().len()
                ),
            ));
        }
        if self.images().len() > MAX_MANIFEST_IMAGES {
            errors.push(ManifestValidationError::new(
                ValidationCategory::ResourceLimit,
                "images",
                format!(
                    "declares {} images; limit is {MAX_MANIFEST_IMAGES}",
                    self.images().len()
                ),
            ));
        }

        let mut entities = HashMap::with_capacity(self.entities().len());
        for (index, entity) in self.entities().iter().enumerate() {
            let path = format!("entities[{index}]");
            validate_text(&mut errors, &format!("{path}.id"), &entity.id.0, false);
            if entities
                .insert(entity.id.0.as_str(), entity.kind.clone())
                .is_some()
            {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Duplicate,
                    format!("{path}.id"),
                    format!("duplicate entity id '{}'", entity.id.0),
                ));
            }
        }
        for (index, entity) in self.entities().iter().enumerate() {
            let path = format!("entities[{index}].parent");
            match (&entity.kind, &entity.parent) {
                (EntityKind::Tile, Some(parent)) => match entities.get(parent.0.as_str()) {
                    Some(EntityKind::Group) => {}
                    Some(_) => errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        path,
                        format!("tile parent '{}' is not a group", parent.0),
                    )),
                    None => errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        path,
                        format!("unknown parent entity '{}'", parent.0),
                    )),
                },
                (EntityKind::Tile, None) => errors.push(ManifestValidationError::new(
                    ValidationCategory::Missing,
                    path,
                    "tile entity requires a group parent",
                )),
                (_, Some(parent)) if parent == &entity.id => {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        path,
                        "entity cannot parent itself",
                    ));
                }
                (_, Some(parent)) if !entities.contains_key(parent.0.as_str()) => {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        path,
                        format!("unknown parent entity '{}'", parent.0),
                    ));
                }
                _ => {}
            }
        }

        let mut image_ids = HashSet::with_capacity(self.images().len());
        let mut image_owner_by_id = HashMap::with_capacity(self.images().len());
        for (index, image) in self.images().iter().enumerate() {
            let path = format!("images[{index}]");
            validate_image(&mut errors, &path, image, &entities, &mut image_ids);
            if entities.contains_key(image.image_id.0.as_str()) && image.image_id.0 != image.owner.0
            {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Duplicate,
                    format!("{path}.image_id"),
                    format!(
                        "image id '{}' collides with a different member's entity id",
                        image.image_id.0
                    ),
                ));
            }
            image_owner_by_id.insert(image.image_id.0.as_str(), image.owner.0.as_str());
        }

        let mut transform_pairs = HashSet::with_capacity(self.transforms().len());
        for (index, edge) in self.transforms().iter().enumerate() {
            let path = format!("transforms[{index}]");
            for (field, id) in [("from", &edge.from), ("to", &edge.to)] {
                if !entities.contains_key(id.0.as_str()) {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        format!("{path}.{field}"),
                        format!("unknown entity '{}'", id.0),
                    ));
                }
            }
            if !transform_pairs.insert((edge.from.0.as_str(), edge.to.0.as_str())) {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Duplicate,
                    path.clone(),
                    format!("duplicate transform {} -> {}", edge.from, edge.to),
                ));
            }
            for (component, value) in edge.transform.matrix().iter().copied().enumerate() {
                if !value.is_finite() {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidValue,
                        format!("{path}.transform.matrix[{component}]"),
                        "transform component must be finite",
                    ));
                }
            }
        }

        let mut layout_ids = HashSet::with_capacity(self.source_layouts().len());
        for (layout_index, layout) in self.source_layouts().iter().enumerate() {
            let path = format!("source_layouts[{layout_index}]");
            validate_text(&mut errors, &format!("{path}.id"), &layout.id.0, false);
            validate_text(&mut errors, &format!("{path}.name"), &layout.name, true);
            if !layout_ids.insert(layout.id.0.as_str()) {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Duplicate,
                    format!("{path}.id"),
                    format!("duplicate layout id '{}'", layout.id.0),
                ));
            }
            let mut placed = HashSet::with_capacity(layout.placements.len());
            for (placement_index, placement) in layout.placements.iter().enumerate() {
                let placement_path = format!("{path}.placements[{placement_index}]");
                if !entities.contains_key(placement.entity_id.0.as_str()) {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        format!("{placement_path}.entity_id"),
                        format!("unknown entity '{}'", placement.entity_id.0),
                    ));
                }
                if !placed.insert(placement.entity_id.0.as_str()) {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::Duplicate,
                        format!("{placement_path}.entity_id"),
                        format!(
                            "entity '{}' is placed more than once",
                            placement.entity_id.0
                        ),
                    ));
                }
                for (axis, value) in placement.position.iter().copied().enumerate() {
                    if !value.is_finite() {
                        errors.push(ManifestValidationError::new(
                            ValidationCategory::InvalidValue,
                            format!("{placement_path}.position[{axis}]"),
                            "layout position must be finite",
                        ));
                    }
                }
            }
        }
        if let Some(default) = &self.default_layout_id
            && !layout_ids.contains(default.0.as_str())
        {
            errors.push(ManifestValidationError::new(
                ValidationCategory::InvalidReference,
                "default_layout_id",
                format!("unknown source layout '{}'", default.0),
            ));
        }

        let mut label_image_ids = HashSet::new();
        let mut label_names = HashSet::new();
        for (index, label) in self.label_specs().iter().enumerate() {
            let path = format!("labels[{index}]");
            validate_text(&mut errors, &format!("{path}.name"), &label.name, false);
            let source_owner = image_owner_by_id.get(label.source_image_id.0.as_str());
            match source_owner {
                None => errors.push(ManifestValidationError::new(
                    ValidationCategory::InvalidReference,
                    format!("{path}.source_image_id"),
                    format!("unknown source image '{}'", label.source_image_id.0),
                )),
                Some(owner) if *owner != label.image.owner.0 => {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidReference,
                        format!("{path}.image.owner"),
                        "label image owner must match its source image owner",
                    ));
                }
                _ => {}
            }
            if !label_names.insert((label.source_image_id.0.as_str(), label.name.as_str())) {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Duplicate,
                    format!("{path}.name"),
                    "duplicate label name for source image",
                ));
            }
            if image_ids.contains(label.image.image_id.0.as_str())
                || !label_image_ids.insert(label.image.image_id.0.as_str())
            {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Duplicate,
                    format!("{path}.image.image_id"),
                    format!("duplicate image id '{}'", label.image.image_id.0),
                ));
            }
            validate_image(
                &mut errors,
                &format!("{path}.image"),
                &label.image,
                &entities,
                &mut HashSet::new(),
            );
            if !matches!(
                label.image.multiscale.data_type,
                DataType::Uint8 | DataType::Uint16 | DataType::Uint32
            ) {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::Unsupported,
                    format!("{path}.image.multiscale.data_type"),
                    "label images require an unsigned integer data type",
                ));
            }
            if label.colors.len() > MAX_LABEL_COLORS {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::ResourceLimit,
                    format!("{path}.colors"),
                    format!(
                        "declares {} colors; limit is {MAX_LABEL_COLORS}",
                        label.colors.len()
                    ),
                ));
            }
            let mut values = HashSet::with_capacity(label.colors.len());
            for (color_index, color) in label.colors.iter().enumerate() {
                if !(0..=u32::MAX as i64).contains(&color.value) {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidValue,
                        format!("{path}.colors[{color_index}].value"),
                        "label value must fit the renderer's unsigned 32-bit domain",
                    ));
                }
                if color.value == LABEL_BACKGROUND_ID {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::InvalidValue,
                        format!("{path}.colors[{color_index}].value"),
                        "label value 0 is reserved for transparent background",
                    ));
                }
                if !values.insert(color.value) {
                    errors.push(ManifestValidationError::new(
                        ValidationCategory::Duplicate,
                        format!("{path}.colors[{color_index}].value"),
                        format!("duplicate label value {}", color.value),
                    ));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(ManifestValidationErrors(errors))
        }
    }
}

fn validate_text(
    errors: &mut Vec<ManifestValidationError>,
    path: &str,
    value: &str,
    allow_empty: bool,
) {
    if !allow_empty && value.is_empty() {
        errors.push(ManifestValidationError::new(
            ValidationCategory::Missing,
            path,
            "value must not be empty",
        ));
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        errors.push(ManifestValidationError::new(
            ValidationCategory::ResourceLimit,
            path,
            format!(
                "value is {} bytes; limit is {MAX_IDENTIFIER_BYTES}",
                value.len()
            ),
        ));
    }
    if value.contains('\0') {
        errors.push(ManifestValidationError::new(
            ValidationCategory::InvalidValue,
            path,
            "value contains a NUL byte",
        ));
    }
}

fn validate_image<'a>(
    errors: &mut Vec<ManifestValidationError>,
    path: &str,
    image: &'a ImageSpec,
    entities: &HashMap<&str, EntityKind>,
    image_ids: &mut HashSet<&'a str>,
) {
    validate_text(
        errors,
        &format!("{path}.image_id"),
        &image.image_id.0,
        false,
    );
    if !image_ids.insert(image.image_id.0.as_str()) {
        errors.push(ManifestValidationError::new(
            ValidationCategory::Duplicate,
            format!("{path}.image_id"),
            format!("duplicate image id '{}'", image.image_id.0),
        ));
    }
    match entities.get(image.owner.0.as_str()) {
        Some(EntityKind::Image | EntityKind::Tile) => {}
        Some(EntityKind::Group) => errors.push(ManifestValidationError::new(
            ValidationCategory::InvalidReference,
            format!("{path}.owner"),
            "image owner cannot be a group",
        )),
        None => errors.push(ManifestValidationError::new(
            ValidationCategory::InvalidReference,
            format!("{path}.owner"),
            format!("unknown entity '{}'", image.owner.0),
        )),
    }
    validate_multiscale(errors, &format!("{path}.multiscale"), &image.multiscale);
}

fn validate_multiscale(
    errors: &mut Vec<ManifestValidationError>,
    path: &str,
    multiscale: &MultiscaleInfo,
) {
    let mut axes = HashSet::with_capacity(multiscale.axes.len());
    for (index, axis) in multiscale.axes.iter().enumerate() {
        let axis_path = format!("{path}.axes[{index}]");
        let lower = axis.name.to_ascii_lowercase();
        if axis_index(&lower).is_none() {
            errors.push(ManifestValidationError::new(
                ValidationCategory::Unsupported,
                format!("{axis_path}.name"),
                format!(
                    "non-canonical axis '{}' must be represented as pinned",
                    axis.name
                ),
            ));
        }
        if !axes.insert(lower.clone()) {
            errors.push(ManifestValidationError::new(
                ValidationCategory::Duplicate,
                format!("{axis_path}.name"),
                format!("duplicate axis '{}'", axis.name),
            ));
        }
        let expected_kind = match lower.as_str() {
            "t" => AxisKind::Time,
            "c" => AxisKind::Channel,
            _ => AxisKind::Space,
        };
        if axis.kind != expected_kind {
            errors.push(ManifestValidationError::new(
                ValidationCategory::InvalidValue,
                format!("{axis_path}.kind"),
                format!("axis '{}' has the wrong kind", axis.name),
            ));
        }
    }

    let mut pinned = HashSet::with_capacity(multiscale.pinned_axes.len());
    for (index, axis) in multiscale.pinned_axes.iter().enumerate() {
        let axis_path = format!("{path}.pinned_axes[{index}]");
        let lower = axis.name.to_ascii_lowercase();
        if axis_index(&lower).is_some() || axes.contains(&lower) || !pinned.insert(lower) {
            errors.push(ManifestValidationError::new(
                ValidationCategory::Duplicate,
                format!("{axis_path}.name"),
                format!("invalid or duplicate pinned axis '{}'", axis.name),
            ));
        }
        if axis.size == 0 || axis.pinned_index >= axis.size {
            errors.push(ManifestValidationError::new(
                ValidationCategory::InvalidValue,
                axis_path,
                format!(
                    "pinned index {} is outside axis '{}' of size {}",
                    axis.pinned_index, axis.name, axis.size
                ),
            ));
        }
    }

    if multiscale.levels.is_empty() {
        errors.push(ManifestValidationError::new(
            ValidationCategory::Missing,
            format!("{path}.levels"),
            "multiscale requires at least one level",
        ));
    }
    if multiscale.levels.len() > MAX_LEVELS_PER_IMAGE {
        errors.push(ManifestValidationError::new(
            ValidationCategory::ResourceLimit,
            format!("{path}.levels"),
            format!(
                "declares {} levels; limit is {MAX_LEVELS_PER_IMAGE}",
                multiscale.levels.len()
            ),
        ));
    }
    let mut levels = HashSet::with_capacity(multiscale.levels.len());
    for (index, level) in multiscale.levels.iter().enumerate() {
        let level_path = format!("{path}.levels[{index}]");
        if !levels.insert(level.level_index) {
            errors.push(ManifestValidationError::new(
                ValidationCategory::Duplicate,
                format!("{level_path}.level_index"),
                format!("duplicate level index {}", level.level_index),
            ));
        }
        for dimension in 0..5 {
            let shape = level.shape[dimension];
            let chunk = level.chunk_shape[dimension];
            if shape == 0 {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::InvalidValue,
                    format!("{level_path}.shape[{dimension}]"),
                    "shape dimension must be positive",
                ));
            }
            if chunk == 0 {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::InvalidValue,
                    format!("{level_path}.chunk_shape[{dimension}]"),
                    "chunk dimension must be positive",
                ));
                continue;
            }
            let expected_grid = shape.div_ceil(chunk);
            if level.grid_shape[dimension] != expected_grid {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::InconsistentShape,
                    format!("{level_path}.grid_shape[{dimension}]"),
                    format!(
                        "grid dimension {} does not equal ceil({shape}/{chunk}) = {expected_grid}",
                        level.grid_shape[dimension]
                    ),
                ));
            }
            let scale = level.scale[dimension];
            if !scale.is_finite() || scale <= 0.0 {
                errors.push(ManifestValidationError::new(
                    ValidationCategory::InvalidValue,
                    format!("{level_path}.scale[{dimension}]"),
                    "scale must be finite and positive",
                ));
            }
        }
    }
    if let Some(coarse) = multiscale.coarse_level_index
        && !levels.contains(&coarse)
    {
        errors.push(ManifestValidationError::new(
            ValidationCategory::InvalidReference,
            format!("{path}.coarse_level_index"),
            format!("unknown level index {coarse}"),
        ));
    }
    let mut generated = HashSet::with_capacity(multiscale.generated_levels.len());
    for (index, level) in multiscale.generated_levels.iter().enumerate() {
        if !levels.contains(&level.level_index) {
            errors.push(ManifestValidationError::new(
                ValidationCategory::InvalidReference,
                format!("{path}.generated_levels[{index}].level_index"),
                format!("unknown level index {}", level.level_index),
            ));
        }
        if !generated.insert(level.level_index) {
            errors.push(ManifestValidationError::new(
                ValidationCategory::Duplicate,
                format!("{path}.generated_levels[{index}].level_index"),
                format!("duplicate generated level index {}", level.level_index),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::*;

    fn valid_manifest() -> DatasetManifest {
        let entity = EntityId("entity".into());
        let image = ImageId("image".into());
        let layout = LayoutId("source".into());
        DatasetManifest::new(
            DatasetId("dataset".into()),
            "Dataset".into(),
            DatasetKind::Single,
            vec![Entity {
                id: entity.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels::default(),
            }],
            vec![],
            vec![ImageSpec {
                image_id: image,
                owner: entity.clone(),
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "y".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".into(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 1, 10, 10],
                        chunk_shape: [1, 1, 1, 4, 4],
                        grid_shape: [1, 1, 1, 3, 3],
                        scale: [1.0; 5],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            }],
            vec![LayoutSpec {
                id: layout.clone(),
                name: "Source".into(),
                placements: vec![EntityPlacement {
                    entity_id: entity,
                    position: [0.0, 0.0],
                }],
            }],
            Some(layout),
        )
    }

    #[test]
    fn valid_manifest_passes() {
        valid_manifest().validate().unwrap();
    }

    #[test]
    fn image_ids_cannot_alias_a_different_member_entity() {
        let original = valid_manifest();
        let mut entities = original.entities().to_vec();
        entities.push(Entity {
            id: EntityId("other-member".into()),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels::default(),
        });
        let mut manifest = DatasetManifest::new(
            original.dataset_id.clone(),
            original.name.clone(),
            original.kind.clone(),
            entities,
            original.transforms().to_vec(),
            original.images().to_vec(),
            original.source_layouts().to_vec(),
            original.default_layout_id.clone(),
        );
        manifest.images_mut()[0].image_id = ImageId("other-member".into());

        let errors = manifest.validate().unwrap_err();
        assert!(errors.errors().iter().any(|error| {
            error.category == ValidationCategory::Duplicate
                && error.path == "images[0].image_id"
                && error.message.contains("different member")
        }));

        // Single-image imports historically use the same string for an image
        // and its own owning entity. That alias is unambiguous and remains
        // compatible.
        let mut same_member = valid_manifest();
        let owner_id = same_member.images()[0].owner.0.clone();
        same_member.images_mut()[0].image_id = ImageId(owner_id);
        same_member.validate().unwrap();
    }

    #[test]
    fn reports_paths_for_independent_graph_and_geometry_failures() {
        let mut value = serde_json::to_value(valid_manifest()).unwrap();
        value["entities"][0]["id"] = serde_json::json!("missing-owner");
        value["images"][0]["multiscale"]["levels"][0]["grid_shape"][4] = serde_json::json!(99);
        let error = serde_json::from_value::<DatasetManifest>(value).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("images[0].owner"), "{message}");
        assert!(message.contains("grid_shape[4]"), "{message}");
    }

    #[test]
    fn rejects_non_finite_transform_and_out_of_domain_label() {
        let mut manifest = valid_manifest();
        let owner = manifest.entities()[0].id.clone();
        manifest = DatasetManifest::new(
            manifest.dataset_id.clone(),
            manifest.name.clone(),
            DatasetKind::Single,
            manifest.entities().to_vec(),
            vec![TransformEdge {
                from: owner.clone(),
                to: owner,
                transform: VoxelTransform::from_voxel_matrix([
                    f64::INFINITY,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                ]),
            }],
            manifest.images().to_vec(),
            manifest.source_layouts().to_vec(),
            manifest.default_layout_id.clone(),
        );
        let errors = manifest.validate().unwrap_err();
        assert!(
            errors
                .errors()
                .iter()
                .any(|e| e.path.contains("transform.matrix[0]"))
        );
    }

    #[test]
    fn label_palette_zero_is_explicitly_reserved_background() {
        let manifest = valid_manifest();
        let source = manifest.images()[0].clone();
        let mut label_image = source.clone();
        label_image.image_id = ImageId("label-image".into());
        label_image.multiscale.data_type = DataType::Uint8;
        let with_label = manifest.with_labels(vec![LabelSpec {
            name: "regions".into(),
            source_image_id: source.image_id,
            image: label_image,
            colors: vec![LabelColor {
                value: LABEL_BACKGROUND_ID,
                rgba: [255, 0, 0, 255],
            }],
            source_declared: true,
        }]);

        let errors = with_label.validate().unwrap_err();
        assert!(errors.errors().iter().any(|error| {
            error.category == ValidationCategory::InvalidValue
                && error.path == "labels[0].colors[0].value"
                && error.message.contains("transparent background")
        }));
    }

    #[test]
    fn generated_shape_chunk_grid_cases_obey_exact_ceil_property() {
        // Deterministic generative coverage keeps this runnable in every CI
        // job while spanning small, uneven, and large shape/chunk ratios.
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        for case in 0..2_048 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let shape = state % 1_000_000 + 1;
            state = state.rotate_left(17) ^ 0xa076_1d64_78bd_642f;
            let chunk = state % 65_536 + 1;
            let dimension = case % 5;

            let mut valid = valid_manifest();
            let level = &mut valid.images_mut()[0].multiscale.levels[0];
            level.shape[dimension] = shape;
            level.chunk_shape[dimension] = chunk;
            level.grid_shape[dimension] = shape.div_ceil(chunk);
            valid.validate().unwrap();

            let mut invalid = valid.clone();
            invalid.images_mut()[0].multiscale.levels[0].grid_shape[dimension] += 1;
            let errors = invalid.validate().unwrap_err();
            assert!(errors.errors().iter().any(|error| {
                error.category == ValidationCategory::InconsistentShape
                    && error.path
                        == format!("images[0].multiscale.levels[0].grid_shape[{dimension}]")
            }));
        }
    }

    #[test]
    fn identifier_boundary_corpus_is_path_addressed_and_bounded() {
        for (value, category) in [
            (String::new(), ValidationCategory::Missing),
            ("has\0nul".to_string(), ValidationCategory::InvalidValue),
            (
                "x".repeat(MAX_IDENTIFIER_BYTES + 1),
                ValidationCategory::ResourceLimit,
            ),
        ] {
            let mut manifest = valid_manifest();
            manifest.dataset_id = DatasetId(value);
            let errors = manifest.validate().unwrap_err();
            assert!(
                errors
                    .errors()
                    .iter()
                    .any(|error| { error.path == "dataset_id" && error.category == category })
            );
        }
    }
}
