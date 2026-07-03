//! Dataset import pipeline.
//!
//! Reads OME-Zarr metadata and produces a three-part [`ImportResult`] containing
//! a [`DatasetManifest`], [`FetchSource`], and [`ServerBindingSeed`].

use std::sync::Arc;

use object_store::ObjectStore;
use object_store::path::Path;

use lucida_content::normalize::{classify_axes, normalize_to_5d};
use lucida_content::*;
use lucida_protocol::*;

use crate::backend::StoreError;
use crate::coarse::{SourceCoarseConfig, select_source_coarse_level};
use crate::codec::parse_codec_chain;
use crate::import_types::*;
use crate::layout::compute_chunk_byte_layout;
use crate::parse;

/// Import a dataset from an OME-Zarr store.
///
/// Detects whether the root describes a plate or a single image and
/// produces the appropriate [`ImportResult`].
pub async fn import_dataset(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
) -> Result<ImportResult, StoreError> {
    let root_json = parse::read_zarr_json(store, "zarr.json").await?;

    if root_json.pointer("/attributes/ome/plate").is_some() {
        import_plate(store, id, name, &root_json).await
    } else {
        import_single_image(store, id, name, &root_json).await
    }
}

async fn import_single_image(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
    root_json: &serde_json::Value,
) -> Result<ImportResult, StoreError> {
    let parsed = parse::parse_multiscales(root_json, "")?;
    let axes_names = parsed.axes_names;
    let level_entries = parsed.level_entries;

    // Channel display names from the OME omero block (generic; optional).
    let channel_infos = parse::parse_omero_channels(root_json);

    let level_metas = parse::read_level_metas(store, "", &level_entries).await?;

    let data_type = parse_data_type(&level_metas[0].data_type)?;
    let layout = classify_axes(&axes_names, &level_metas[0].shape);
    warn_pinned_axes(id, &layout.pinned);
    let axes = build_axes(&layout.canonical_names);
    let levels = build_level_geometries(&level_entries, &level_metas, &axes_names)?;
    let coarse_level_index =
        select_source_coarse_level(&levels, data_type, SourceCoarseConfig::default());
    let level_bindings = build_level_binding_infos(
        &axes_names,
        &level_metas,
        data_type_size(data_type),
        &layout.pinned,
    )?;

    let entity_id = EntityId(id.to_string());
    let image_id = ImageId(id.to_string());

    let entity = Entity {
        id: entity_id.clone(),
        kind: EntityKind::Image,
        parent: None,
        labels: EntityLabels {
            name: Some(name.to_string()),
            ..Default::default()
        },
    };

    let image = ImageSpec {
        image_id: image_id.clone(),
        owner: entity_id.clone(),
        multiscale: MultiscaleInfo {
            axes,
            levels,
            coarse_level_index,
            generated_levels: Vec::new(),
            data_type,
            pinned_axes: layout.pinned.clone(),
            channel_infos,
        },
    };

    // Look for a `labels/` child group and attach any label overlays to this
    // image. Absent labels (the common case) yield nothing; malformed ones
    // degrade gracefully without failing the import.
    let mut label_budget = LabelBudget::new();
    let labels =
        import_labels_for_image(&mut label_budget, store, id, "", &image_id, &entity_id).await;

    let default_layout_id = LayoutId("source".to_string());
    let source_layout = LayoutSpec {
        id: default_layout_id.clone(),
        name: "Source".to_string(),
        placements: vec![EntityPlacement {
            entity_id: entity_id.clone(),
            position: [0.0, 0.0],
        }],
    };

    let manifest = DatasetManifest::new(
        DatasetId(id.to_string()),
        name.to_string(),
        DatasetKind::Single,
        vec![entity],
        vec![],
        vec![image],
        vec![source_layout],
        Some(default_layout_id),
    )
    .with_labels(labels.specs);

    let mut fetch_images = vec![ProxiedImageSpec {
        image_id: image_id.clone(),
        wire_format: WireFormat::Raw { data_type },
    }];
    fetch_images.extend(labels.fetch);
    let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
        images: fetch_images,
    });

    let mut binding_images = vec![ImageBindingSeed {
        image_id,
        axes_names,
        store_prefix: None,
        levels: level_bindings,
    }];
    binding_images.extend(labels.bindings);
    let binding_seed = ServerBindingSeed {
        images: binding_images,
    };

    Ok(ImportResult {
        manifest,
        fetch,
        binding_seed,
    })
}

async fn import_plate(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
    root_json: &serde_json::Value,
) -> Result<ImportResult, StoreError> {
    let plate_json = root_json
        .pointer("/attributes/ome/plate")
        .ok_or_else(|| StoreError::Metadata("no ome.plate in root zarr.json".into()))?;

    // Parse rows and columns.
    let rows: Vec<String> = plate_json
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let columns: Vec<String> = plate_json
        .get("columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let wells_json = plate_json
        .get("wells")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata("plate has no wells array".into()))?;

    // Parse wells and FOVs.
    struct WellParsed {
        path: String,
        row_index: u32,
        column_index: u32,
        fovs: Vec<FovParsed>,
    }

    struct FovParsed {
        store_prefix: String,
        translation: Option<Vec<f64>>,
    }

    let mut parsed_wells: Vec<WellParsed> = Vec::new();
    let mut representative_fov_path: Option<String> = None;
    let mut has_stage_positions = false;

    for well_entry in wells_json {
        let well_path = well_entry
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StoreError::Metadata("well entry missing path".into()))?;
        let row_index = well_entry
            .get("rowIndex")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let column_index = well_entry
            .get("columnIndex")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        let well_meta_path = Path::from(format!("{well_path}/zarr.json"));
        let well_bytes = store.get(&well_meta_path).await?.bytes().await?;
        let well_json: serde_json::Value = serde_json::from_slice(&well_bytes)
            .map_err(|e| StoreError::Metadata(format!("{well_path}: {e}")))?;

        let images = well_json
            .pointer("/attributes/ome/well/images")
            .and_then(|v| v.as_array())
            .ok_or_else(|| StoreError::Metadata(format!("{well_path}: no ome.well.images")))?;

        let mut fovs: Vec<FovParsed> = Vec::new();
        for image_entry in images {
            let fov_path = image_entry
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            let store_prefix = format!("{well_path}/{fov_path}");

            let translation = image_entry
                .get("coordinateTransformations")
                .and_then(|v| v.as_array())
                .and_then(|transforms| {
                    transforms.iter().find_map(|ct| {
                        if ct.get("type").and_then(|v| v.as_str()) == Some("translation") {
                            ct.get("translation")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
                        } else {
                            None
                        }
                    })
                });

            if translation.is_some() {
                has_stage_positions = true;
            }

            if representative_fov_path.is_none() {
                representative_fov_path = Some(store_prefix.clone());
            }

            fovs.push(FovParsed {
                store_prefix,
                translation,
            });
        }

        parsed_wells.push(WellParsed {
            path: well_path.to_string(),
            row_index,
            column_index,
            fovs,
        });
    }

    // Read representative FOV multiscales.
    let rep_path =
        representative_fov_path.ok_or_else(|| StoreError::Metadata("plate has no FOVs".into()))?;

    let rep_json = parse::read_zarr_json(store, &format!("{rep_path}/zarr.json")).await?;
    let rep_parsed = parse::parse_multiscales(&rep_json, &format!("{rep_path}: "))?;
    let axes_names = rep_parsed.axes_names;
    let level_entries = rep_parsed.level_entries;

    // Channel display names from the representative FOV's omero block. OME-Zarr
    // plates require all FOVs to share one multiscale, so the representative
    // FOV's channels apply to every field (generic; optional).
    let channel_infos = parse::parse_omero_channels(&rep_json);

    let level_metas = parse::read_level_metas(store, &rep_path, &level_entries).await?;

    let (full_shape_5d, _full_chunk_5d) = parse::extract_full_res(&level_metas, &axes_names);

    let data_type = parse_data_type(&level_metas[0].data_type)?;
    let layout = classify_axes(&axes_names, &level_metas[0].shape);
    warn_pinned_axes(id, &layout.pinned);
    let axes = build_axes(&layout.canonical_names);
    let levels = build_level_geometries(&level_entries, &level_metas, &axes_names)?;
    let level_bindings = build_level_binding_infos(
        &axes_names,
        &level_metas,
        data_type_size(data_type),
        &layout.pinned,
    )?;

    let positioning_mode = if has_stage_positions {
        PositioningMode::Stage
    } else {
        PositioningMode::Grid
    };

    // For stage-positioned plates, OME-Zarr translations are in physical units
    // (e.g., microns), but the rest of lucida composes them with voxel-unit
    // well placements. Convert translations to voxel units here using the
    // level-0 scale. Defensive: a missing or invalid scale falls back to 1.0
    // (pass-through) and emits a single warning per dataset.
    let (scale_x, scale_y) = {
        let raw_x = levels[0].scale[4];
        let raw_y = levels[0].scale[3];
        let valid = |s: f64| s.is_finite() && s != 0.0;
        let sx = if valid(raw_x) { raw_x } else { 1.0 };
        let sy = if valid(raw_y) { raw_y } else { 1.0 };
        if has_stage_positions && (!valid(raw_x) || !valid(raw_y)) {
            eprintln!(
                "[lucida-store] dataset {id:?} has missing or invalid voxel \
                 scale (scale_x={raw_x}, scale_y={raw_y}); stage translations \
                 are passed through unchanged",
            );
        }
        (sx, sy)
    };

    // Determine row/column labels for each well from row_index/column_index.
    let find_row_label = |ri: u32| -> String {
        rows.get(ri as usize)
            .cloned()
            .unwrap_or_else(|| format!("{ri}"))
    };
    let find_col_label = |ci: u32| -> String {
        columns
            .get(ci as usize)
            .cloned()
            .unwrap_or_else(|| format!("{ci}"))
    };

    // Build entities, images, transforms, and binding seeds.
    let mut entities: Vec<Entity> = Vec::new();
    let mut images: Vec<ImageSpec> = Vec::new();
    let mut transforms: Vec<TransformEdge> = Vec::new();
    let mut fetch_images: Vec<ProxiedImageSpec> = Vec::new();
    let mut binding_images: Vec<ImageBindingSeed> = Vec::new();
    // Label overlays discovered per-field, flattened across the whole plate.
    // The budget is shared across fields so aggregate label/color memory is
    // bounded no matter how many fields carry labels.
    let mut label_specs: Vec<LabelSpec> = Vec::new();
    let mut label_budget = LabelBudget::new();

    for well in &parsed_wells {
        let well_entity_id = EntityId(format!("{id}:well:{}", well.path));

        entities.push(Entity {
            id: well_entity_id.clone(),
            kind: EntityKind::Well,
            parent: None,
            labels: EntityLabels {
                name: Some(format!(
                    "{}/{}",
                    find_row_label(well.row_index),
                    find_col_label(well.column_index),
                )),
                well_row: Some(find_row_label(well.row_index)),
                well_column: Some(find_col_label(well.column_index)),
                row_index: Some(well.row_index),
                column_index: Some(well.column_index),
                ..Default::default()
            },
        });

        // Collect stage translations for this well's FOVs to normalize them.
        // Translations are stored in OME-Zarr in physical units (e.g. microns);
        // convert to voxel units here so downstream consumers see consistent
        // units across grid- and stage-positioned plates.
        let stage_positions: Vec<Option<[f64; 2]>> = if has_stage_positions {
            well.fovs
                .iter()
                .map(|fov| {
                    fov.translation.as_ref().map(|t| {
                        let len = t.len();
                        if len >= 2 {
                            // Last value is X, second-to-last is Y
                            [t[len - 1] / scale_x, t[len - 2] / scale_y]
                        } else {
                            [0.0, 0.0]
                        }
                    })
                })
                .collect()
        } else {
            vec![None; well.fovs.len()]
        };

        // Find minimum for normalization within this well.
        let (min_x, min_y) = if has_stage_positions {
            let mut mx = f64::MAX;
            let mut my = f64::MAX;
            for [x, y] in stage_positions.iter().flatten() {
                mx = mx.min(*x);
                my = my.min(*y);
            }
            if mx == f64::MAX {
                mx = 0.0;
            }
            if my == f64::MAX {
                my = 0.0;
            }
            (mx, my)
        } else {
            (0.0, 0.0)
        };

        for (fi, fov) in well.fovs.iter().enumerate() {
            let field_entity_id = EntityId(format!("{id}:field:{}", fov.store_prefix));
            let image_id = ImageId(format!("{id}:image:{}", fov.store_prefix));

            entities.push(Entity {
                id: field_entity_id.clone(),
                kind: EntityKind::Field,
                parent: Some(well_entity_id.clone()),
                labels: EntityLabels {
                    name: Some(format!("Field {}", fi)),
                    field_index: Some(fi as u32),
                    ..Default::default()
                },
            });

            // Build field->well transform.
            if has_stage_positions {
                if let Some([x, y]) = stage_positions[fi] {
                    transforms.push(TransformEdge {
                        from: field_entity_id.clone(),
                        to: well_entity_id.clone(),
                        transform: VoxelTransform::from_voxel_translation_2d(x - min_x, y - min_y),
                    });
                } else {
                    transforms.push(TransformEdge {
                        from: field_entity_id.clone(),
                        to: well_entity_id.clone(),
                        transform: VoxelTransform::from_voxel_translation_2d(0.0, 0.0),
                    });
                }
            }
            // Grid transforms are built after all entities are created.

            // Read this field's `labels/` group before its ids are moved into
            // the image/binding vecs. Nested per-field, mirroring how the FOV
            // metadata itself is read.
            let fov_labels = import_labels_for_image(
                &mut label_budget,
                store,
                id,
                &fov.store_prefix,
                &image_id,
                &field_entity_id,
            )
            .await;

            images.push(ImageSpec {
                image_id: image_id.clone(),
                owner: field_entity_id,
                multiscale: MultiscaleInfo {
                    axes: axes.clone(),
                    levels: levels.clone(),
                    coarse_level_index: select_source_coarse_level(
                        &levels,
                        data_type,
                        SourceCoarseConfig::default(),
                    ),
                    generated_levels: Vec::new(),
                    data_type,
                    pinned_axes: layout.pinned.clone(),
                    channel_infos: channel_infos.clone(),
                },
            });

            fetch_images.push(ProxiedImageSpec {
                image_id: image_id.clone(),
                wire_format: WireFormat::Raw { data_type },
            });

            binding_images.push(ImageBindingSeed {
                image_id,
                axes_names: axes_names.clone(),
                store_prefix: Some(fov.store_prefix.clone()),
                levels: level_bindings.clone(),
            });

            // Append the field's labels after its own image entries.
            label_specs.extend(fov_labels.specs);
            fetch_images.extend(fov_labels.fetch);
            binding_images.extend(fov_labels.bindings);
        }
    }

    // Build grid field transforms if not stage-positioned.
    if !has_stage_positions {
        let well_entities: Vec<&Entity> = entities
            .iter()
            .filter(|e| e.kind == EntityKind::Well)
            .collect();
        let field_entities: Vec<Entity> = entities
            .iter()
            .filter(|e| e.kind == EntityKind::Field)
            .cloned()
            .collect();

        let grid_transforms = lucida_content::plate::build_grid_field_transforms(
            &well_entities
                .iter()
                .map(|e| (*e).clone())
                .collect::<Vec<_>>(),
            &field_entities,
            full_shape_5d,
        )
        .map_err(|e| StoreError::Metadata(e.to_string()))?;

        transforms = grid_transforms;
    }

    // Build plate layout (places wells, not fields).
    let source_layout =
        lucida_content::plate::build_plate_layout(&entities, &rows, &columns, full_shape_5d);

    let default_layout_id = source_layout.id.clone();

    let manifest = DatasetManifest::new(
        DatasetId(id.to_string()),
        name.to_string(),
        DatasetKind::Plate {
            rows,
            columns,
            positioning_mode,
            has_stage_positions,
        },
        entities,
        transforms,
        images,
        vec![source_layout],
        Some(default_layout_id),
    )
    .with_labels(label_specs);

    let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
        images: fetch_images,
    });

    let binding_seed = ServerBindingSeed {
        images: binding_images,
    };

    Ok(ImportResult {
        manifest,
        fetch,
        binding_seed,
    })
}

fn parse_data_type(s: &str) -> Result<DataType, StoreError> {
    match s {
        "uint8" => Ok(DataType::Uint8),
        "uint16" => Ok(DataType::Uint16),
        "uint32" => Ok(DataType::Uint32),
        "float32" => Ok(DataType::Float32),
        "float64" => Ok(DataType::Float64),
        other => Err(StoreError::Metadata(format!(
            "unsupported data type: {other}"
        ))),
    }
}

fn data_type_size(dt: DataType) -> u8 {
    match dt {
        DataType::Uint8 => 1,
        DataType::Uint16 => 2,
        DataType::Uint32 | DataType::Float32 => 4,
        DataType::Float64 => 8,
    }
}

/// Build per-level [`LevelBindingInfo`] for a single image (or for the
/// representative FOV of a plate, since OME-Zarr plates require all FOVs to
/// share the same multiscale shape and codec chain).
///
/// Each level is validated independently with [`parse_codec_chain`] and
/// [`compute_chunk_byte_layout`]; any error is wrapped with the offending
/// level index so the user can locate it in their dataset (e.g.
/// `"level 0: unsupported codec 'gzip' in storage chain"`). The first
/// failing level short-circuits — we don't accumulate all failures.
fn build_level_binding_infos(
    axes_names: &[String],
    level_metas: &[parse::ArrayMeta],
    dtype_size: u8,
    pinned: &[PinnedAxis],
) -> Result<Vec<LevelBindingInfo>, StoreError> {
    level_metas
        .iter()
        .enumerate()
        .map(|(i, meta)| {
            let compression = parse_codec_chain(&meta.codecs).map_err(|e| match e {
                StoreError::Metadata(msg) => StoreError::Metadata(format!("level {i}: {msg}")),
                other => other,
            })?;
            let chunk_byte_layout = compute_chunk_byte_layout(
                axes_names,
                &meta.chunk_grid.configuration.chunk_shape,
                dtype_size,
                pinned,
            )
            .map_err(|e| match e {
                StoreError::Metadata(msg) => StoreError::Metadata(format!("level {i}: {msg}")),
                other => other,
            })?;
            Ok(LevelBindingInfo {
                level_index: i as u32,
                compression,
                chunk_shape: meta.chunk_grid.configuration.chunk_shape.clone(),
                chunk_byte_layout,
            })
        })
        .collect()
}

fn warn_pinned_axes(dataset_id: &str, pinned: &[PinnedAxis]) {
    for axis in pinned {
        eprintln!(
            "[lucida-store] dataset {dataset_id:?}: axis '{}' (size {}) is non-canonical \
             and was pinned to index {}; only that slice will be visible",
            axis.name, axis.size, axis.pinned_index,
        );
    }
}

fn build_axes(axes_names: &[String]) -> Vec<Axis> {
    axes_names
        .iter()
        .map(|name| {
            let kind = match name.to_lowercase().as_str() {
                "t" => AxisKind::Time,
                "c" => AxisKind::Channel,
                _ => AxisKind::Space,
            };
            Axis {
                name: name.clone(),
                kind,
            }
        })
        .collect()
}

/// Build per-level [`LevelGeometry`], normalizing shapes to canonical 5D.
///
/// A zero chunk dimension on ANY axis is rejected with a [`StoreError`] naming
/// the level and the offending axis — by name when the axes metadata
/// identifies it unambiguously, by position otherwise (Zarr v3 forbids a zero
/// either way). The raw `chunk_shape` is checked before normalization because
/// [`normalize_to_5d`] drops non-canonical
/// (pinned) axes — a zero on e.g. a CZI `m` axis would otherwise slip through
/// and admit a level whose on-disk chunks hold zero bytes, corrupting every
/// later fetch of them. The normalized shape is checked as well, guarding the
/// `shape / chunk` grid computation (div_ceil) directly. Together these keep
/// untrusted array metadata — a label's or an image's `chunk_shape` — from
/// aborting the process: a bad label surfaces as an `Err` the caller skips,
/// and a bad source array fails the import loudly.
fn build_level_geometries(
    level_entries: &[parse::LevelEntry],
    level_metas: &[parse::ArrayMeta],
    axes_names: &[String],
) -> Result<Vec<LevelGeometry>, StoreError> {
    level_entries
        .iter()
        .zip(level_metas.iter())
        .enumerate()
        .map(|(i, (entry, meta))| {
            let raw_chunk = &meta.chunk_grid.configuration.chunk_shape;
            if let Some(d) = raw_chunk.iter().position(|&v| v == 0) {
                // Name the offending axis only when `axes_names` aligns
                // positionally with the raw chunk_shape (equal lengths).
                // `parse_multiscales` drops axes entries that lack a "name",
                // so a shorter names list is shifted relative to the chunk
                // dimensions and looking up index `d` in it would blame an
                // innocent neighboring axis. Otherwise identify the dimension
                // by position, which is always correct.
                let axis = if axes_names.len() == raw_chunk.len() {
                    format!("axis '{}'", axes_names[d])
                } else {
                    format!("dimension {d}")
                };
                return Err(StoreError::Metadata(format!(
                    "level {i}: {axis} has a zero chunk dimension \
                     (chunk_shape {raw_chunk:?}); Zarr v3 requires every chunk \
                     dimension to be at least 1"
                )));
            }
            let shape = normalize_to_5d(&meta.shape, axes_names, 1);
            let chunk_shape = normalize_to_5d(raw_chunk, axes_names, 1);
            if chunk_shape.contains(&0) {
                return Err(StoreError::Metadata(format!(
                    "level {i}: chunk_shape {chunk_shape:?} has a zero dimension"
                )));
            }
            let grid_shape = std::array::from_fn(|d| shape[d].div_ceil(chunk_shape[d]));
            Ok(LevelGeometry {
                level_index: i as u32,
                shape,
                chunk_shape,
                grid_shape,
                scale: entry.scale,
            })
        })
        .collect()
}

/// Dataset-wide ceiling on retained labels. The per-group name cap bounds one
/// `labels` list; this bounds the total kept across every field of a plate so
/// an adversarial dataset can't accumulate unbounded label specs in memory.
const MAX_LABELS_PER_DATASET: usize = 1 << 16;

/// Dataset-wide ceiling on retained color-table entries, summed across all
/// labels. Complements the per-label color cap in `parse` so the total color
/// memory across a whole plate stays bounded.
const MAX_LABEL_COLORS_PER_DATASET: usize = 1 << 20;

/// Remaining dataset-wide budget for retained labels and color entries, carried
/// across every source image / plate field so aggregate memory is bounded even
/// when per-label caps are individually satisfied.
struct LabelBudget {
    labels_remaining: usize,
    colors_remaining: usize,
}

impl LabelBudget {
    fn new() -> Self {
        Self {
            labels_remaining: MAX_LABELS_PER_DATASET,
            colors_remaining: MAX_LABEL_COLORS_PER_DATASET,
        }
    }
}

/// Label overlays imported for one source image: the manifest specs plus the
/// fetch/binding entries the server needs to stream each label's chunks.
#[derive(Default)]
struct ImportedLabels {
    specs: Vec<LabelSpec>,
    fetch: Vec<ProxiedImageSpec>,
    bindings: Vec<ImageBindingSeed>,
}

/// Detect an OME-NGFF `labels/` child group on a source image group and import
/// every well-formed label it lists.
///
/// `base_prefix` is the source image group's store prefix (`""` for a
/// standalone image, `"{well}/{fov}"` for a plate field); labels live under
/// `{base_prefix}/labels`. A missing `labels/` group — the common case —
/// returns empty. Each label is built through the same multiscale pipeline as
/// an ordinary image and attached to `source_image_id`; a label that fails to
/// parse is skipped with a warning so one bad label never fails the import.
/// `budget` is shared across all calls for a dataset and bounds the aggregate
/// number of retained labels and colors.
async fn import_labels_for_image(
    budget: &mut LabelBudget,
    store: &Arc<dyn ObjectStore>,
    dataset_id: &str,
    base_prefix: &str,
    source_image_id: &ImageId,
    source_owner: &EntityId,
) -> ImportedLabels {
    let labels_prefix = if base_prefix.is_empty() {
        "labels".to_string()
    } else {
        format!("{base_prefix}/labels")
    };

    let Some(labels_json) =
        parse::read_optional_zarr_json(store, &format!("{labels_prefix}/zarr.json")).await
    else {
        return ImportedLabels::default();
    };

    let names = parse::parse_labels_names(&labels_json);
    let mut imported = ImportedLabels::default();
    for name in names {
        if budget.labels_remaining == 0 {
            eprintln!(
                "[lucida-store] dataset {dataset_id:?}: dataset label budget reached; \
                 skipping remaining labels under {labels_prefix:?}",
            );
            break;
        }
        match build_label(store, &labels_prefix, &name, source_image_id, source_owner).await {
            Ok(mut built) => {
                // Clamp this label's colors to the remaining dataset-wide budget
                // before retaining them, then charge both budgets.
                if built.spec.colors.len() > budget.colors_remaining {
                    built.spec.colors.truncate(budget.colors_remaining);
                }
                budget.colors_remaining -= built.spec.colors.len();
                budget.labels_remaining -= 1;
                imported.specs.push(built.spec);
                imported.fetch.push(built.fetch);
                imported.bindings.push(built.binding);
            }
            Err(e) => {
                eprintln!(
                    "[lucida-store] dataset {dataset_id:?}: skipping malformed label \
                     {name:?} under {labels_prefix:?}: {e}",
                );
            }
        }
    }
    imported
}

/// A single fully-built label: its manifest spec plus the fetch/binding entries
/// keyed by the label's own image id.
struct BuiltLabel {
    spec: LabelSpec,
    fetch: ProxiedImageSpec,
    binding: ImageBindingSeed,
}

/// Build one label from its group prefix, reusing the ordinary multiscale
/// pipeline so the label becomes a first-class multiscale image with its own
/// axes, per-level geometry, integer dtype, and coarse-level selection — kept
/// distinct from the source image's geometry, which is the spatial-alignment
/// foundation for later rendering.
async fn build_label(
    store: &Arc<dyn ObjectStore>,
    labels_prefix: &str,
    name: &str,
    source_image_id: &ImageId,
    source_owner: &EntityId,
) -> Result<BuiltLabel, StoreError> {
    let group_prefix = format!("{labels_prefix}/{name}");
    let group_json = parse::read_zarr_json(store, &format!("{group_prefix}/zarr.json")).await?;

    let error_prefix = format!("label {name:?}: ");
    let parsed = parse::parse_multiscales(&group_json, &error_prefix)?;
    let axes_names = parsed.axes_names;
    let level_entries = parsed.level_entries;

    let level_metas = parse::read_level_metas(store, &group_prefix, &level_entries).await?;

    // Preserve the label's integer dtype exactly (uint8/16/32) — a uint32 mask
    // whose ids exceed 65535 must never be narrowed.
    let data_type = parse_data_type(&level_metas[0].data_type)?;
    let layout = classify_axes(&axes_names, &level_metas[0].shape);
    warn_pinned_axes(&group_prefix, &layout.pinned);
    let axes = build_axes(&layout.canonical_names);
    // A zero chunk dimension on any axis (canonical or pinned) here returns
    // Err, so the label is skipped by the caller rather than panicking the
    // whole import or attaching with an empty chunk byte layout.
    let levels = build_level_geometries(&level_entries, &level_metas, &axes_names)?;
    let coarse_level_index =
        select_source_coarse_level(&levels, data_type, SourceCoarseConfig::default());
    let level_bindings = build_level_binding_infos(
        &axes_names,
        &level_metas,
        data_type_size(data_type),
        &layout.pinned,
    )?;

    let image_label = parse::parse_image_label(&group_json);

    let label_image_id = ImageId(format!("{source_image_id}:label:{name}"));

    let image = ImageSpec {
        image_id: label_image_id.clone(),
        // The label shares the source image's owning entity so a render pass can
        // resolve its placement from the same entity that positions the source.
        owner: source_owner.clone(),
        multiscale: MultiscaleInfo {
            axes,
            levels,
            coarse_level_index,
            generated_levels: Vec::new(),
            data_type,
            pinned_axes: layout.pinned,
            channel_infos: Vec::new(),
        },
    };

    let spec = LabelSpec {
        name: name.to_string(),
        source_image_id: source_image_id.clone(),
        image,
        colors: image_label.colors,
        source_declared: image_label.source_declared,
    };

    let fetch = ProxiedImageSpec {
        image_id: label_image_id.clone(),
        wire_format: WireFormat::Raw { data_type },
    };

    let binding = ImageBindingSeed {
        image_id: label_image_id,
        axes_names,
        store_prefix: Some(group_prefix),
        levels: level_bindings,
    };

    Ok(BuiltLabel {
        spec,
        fetch,
        binding,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_import_test_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// Create a minimal OME-Zarr plate fixture.
    // Test helper; args mirror plate-layout shape parameters.
    #[allow(clippy::too_many_arguments)]
    fn create_plate_fixture(
        dir: &std::path::Path,
        plate_name: &str,
        rows: &[&str],
        columns: &[&str],
        wells: &[(
            /*row*/ &str,
            /*col*/ &str,
            /*row_idx*/ u32,
            /*col_idx*/ u32,
            /*num_fovs*/ u32,
        )],
        fov_shape: [u64; 5],
        fov_chunk: [u64; 5],
        num_levels: usize,
    ) {
        fs::create_dir_all(dir).unwrap();

        let rows_json: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| serde_json::json!({"name": r}))
            .collect();
        let cols_json: Vec<serde_json::Value> = columns
            .iter()
            .map(|c| serde_json::json!({"name": c}))
            .collect();
        let wells_json: Vec<serde_json::Value> = wells
            .iter()
            .map(|(row, col, ri, ci, _)| {
                serde_json::json!({
                    "path": format!("{row}/{col}"),
                    "rowIndex": ri,
                    "columnIndex": ci,
                })
            })
            .collect();

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "plate": {
                        "version": "0.5",
                        "name": plate_name,
                        "rows": rows_json,
                        "columns": cols_json,
                        "wells": wells_json,
                        "field_count": wells.iter().map(|w| w.4).max().unwrap_or(1),
                    }
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        for (row, col, _ri, _ci, num_fovs) in wells {
            let well_dir = dir.join(row).join(col);
            fs::create_dir_all(&well_dir).unwrap();

            let row_dir = dir.join(row);
            let row_meta = serde_json::json!({"zarr_format": 3, "node_type": "group"});
            fs::write(
                row_dir.join("zarr.json"),
                serde_json::to_string_pretty(&row_meta).unwrap(),
            )
            .unwrap();

            let images: Vec<serde_json::Value> = (0..*num_fovs)
                .map(|i| serde_json::json!({"path": i.to_string()}))
                .collect();

            let well_meta = serde_json::json!({
                "zarr_format": 3,
                "node_type": "group",
                "attributes": {
                    "ome": {
                        "version": "0.5",
                        "well": { "images": images }
                    }
                }
            });
            fs::write(
                well_dir.join("zarr.json"),
                serde_json::to_string_pretty(&well_meta).unwrap(),
            )
            .unwrap();

            for i in 0..*num_fovs {
                let fov_dir = well_dir.join(i.to_string());
                fs::create_dir_all(&fov_dir).unwrap();

                // Build multiscale datasets for each level.
                let mut datasets = Vec::new();
                for lvl in 0..num_levels {
                    let scale_factor = (1u64 << lvl) as f64;
                    datasets.push(serde_json::json!({
                        "path": lvl.to_string(),
                        "coordinateTransformations": [{
                            "type": "scale",
                            "scale": [1.0, 1.0, 1.0, scale_factor, scale_factor]
                        }]
                    }));
                }

                let fov_root = serde_json::json!({
                    "zarr_format": 3,
                    "node_type": "group",
                    "attributes": {
                        "ome": {
                            "version": "0.5",
                            "multiscales": [{
                                "version": "0.5",
                                "name": "image",
                                "axes": [
                                    {"name": "t", "type": "time"},
                                    {"name": "c", "type": "channel"},
                                    {"name": "z", "type": "space"},
                                    {"name": "y", "type": "space"},
                                    {"name": "x", "type": "space"}
                                ],
                                "datasets": datasets
                            }]
                        }
                    }
                });
                fs::write(
                    fov_dir.join("zarr.json"),
                    serde_json::to_string_pretty(&fov_root).unwrap(),
                )
                .unwrap();

                for lvl in 0..num_levels {
                    let level_dir = fov_dir.join(lvl.to_string());
                    fs::create_dir_all(&level_dir).unwrap();
                    let scale = 1u64 << lvl;
                    let level_shape = [
                        fov_shape[0],
                        fov_shape[1],
                        fov_shape[2],
                        fov_shape[3].div_ceil(scale),
                        fov_shape[4].div_ceil(scale),
                    ];
                    let arr = serde_json::json!({
                        "zarr_format": 3,
                        "node_type": "array",
                        "shape": level_shape,
                        "data_type": "uint16",
                        "chunk_grid": {
                            "name": "regular",
                            "configuration": { "chunk_shape": fov_chunk }
                        },
                        "codecs": [
                            {"name": "bytes", "configuration": {"endian": "little"}},
                            {"name": "numcodecs/lz4", "configuration": {"acceleration": 1}}
                        ],
                        "fill_value": 0
                    });
                    fs::write(
                        level_dir.join("zarr.json"),
                        serde_json::to_string_pretty(&arr).unwrap(),
                    )
                    .unwrap();
                }
            }
        }
    }

    #[test]
    fn unsupported_data_type() {
        assert!(parse_data_type("complex128").is_err());
    }

    #[test]
    fn supported_data_types() {
        assert_eq!(parse_data_type("uint8").unwrap(), DataType::Uint8);
        assert_eq!(parse_data_type("uint16").unwrap(), DataType::Uint16);
        assert_eq!(parse_data_type("uint32").unwrap(), DataType::Uint32);
        assert_eq!(parse_data_type("float32").unwrap(), DataType::Float32);
        assert_eq!(parse_data_type("float64").unwrap(), DataType::Float64);
    }

    #[test]
    fn axes_classification() {
        let axes = build_axes(
            &["t", "c", "z", "y", "x"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
        );
        assert_eq!(axes.len(), 5);
        assert_eq!(axes[0].kind, AxisKind::Time);
        assert_eq!(axes[1].kind, AxisKind::Channel);
        assert_eq!(axes[2].kind, AxisKind::Space);
        assert_eq!(axes[3].kind, AxisKind::Space);
        assert_eq!(axes[4].kind, AxisKind::Space);
    }

    // Reads a real OME-Zarr fixture from `example_files/` which isn't checked in.
    // Run locally with `cargo test -- --ignored` when you have the fixture present;
    // skipped on CI (no fixture) per `.github/workflows/ci.yml`.
    #[tokio::test]
    #[ignore = "depends on example_files/yeast_3d_mitochondria.ome.zarr (not in repo)"]
    async fn import_single_image() {
        let store = crate::backend::open(&format!(
            "{}/example_files/yeast_3d_mitochondria.ome.zarr",
            env!("CARGO_MANIFEST_DIR").trim_end_matches("/lucida-store"),
        ))
        .unwrap();
        let result = import_dataset(&store, "test-id", "Test Dataset")
            .await
            .unwrap();

        // Verify content graph.
        assert_eq!(result.manifest.dataset_id, DatasetId("test-id".into()));
        assert_eq!(result.manifest.name, "Test Dataset");
        assert!(matches!(result.manifest.kind, DatasetKind::Single));
        assert_eq!(result.manifest.entities().len(), 1);
        assert_eq!(result.manifest.entities()[0].kind, EntityKind::Image);
        assert_eq!(result.manifest.images().len(), 1);
        assert_eq!(result.manifest.source_layouts().len(), 1);

        // Verify multiscale.
        let image = &result.manifest.images()[0];
        assert!(
            image.multiscale.levels.len() >= 2,
            "expected at least 2 levels, got {}",
            image.multiscale.levels.len(),
        );
        let level0 = &image.multiscale.levels[0];
        assert!(level0.shape[3] > 0, "Y should be > 0");
        assert!(level0.shape[4] > 0, "X should be > 0");
        // Verify grid_shape is correctly computed.
        for d in 0..5 {
            assert_eq!(
                level0.grid_shape[d],
                level0.shape[d].div_ceil(level0.chunk_shape[d]),
            );
        }

        // Verify fetch is Proxied.
        assert!(matches!(result.fetch, FetchSource::Proxied(_)));

        // Verify binding seed.
        assert_eq!(result.binding_seed.images.len(), 1);
        assert!(result.binding_seed.images[0].store_prefix.is_none());

        // Pretty-print for visual inspection.
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    }

    #[tokio::test]
    async fn import_plate() {
        let dir = temp_dir("import_plate");
        create_plate_fixture(
            &dir,
            "test_plate",
            &["A", "B"],
            &["1", "2"],
            &[
                ("A", "1", 0, 0, 2),
                ("A", "2", 0, 1, 1),
                ("B", "1", 1, 0, 1),
            ],
            [1, 1, 10, 256, 256],
            [1, 1, 1, 128, 128],
            2,
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "plate-id", "Test Plate")
            .await
            .unwrap();

        // Verify content graph.
        assert!(matches!(result.manifest.kind, DatasetKind::Plate { .. }));

        // Should have well entities and field entities.
        let wells: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Well)
            .collect();
        let fields: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Field)
            .collect();
        assert_eq!(wells.len(), 3, "expected 3 wells");
        assert_eq!(fields.len(), 4, "expected 4 fields total (2+1+1)");

        // Every field should have a parent that is a well.
        for field in &fields {
            assert!(field.parent.is_some());
            let parent_id = field.parent.as_ref().unwrap();
            assert!(
                wells.iter().any(|w| &w.id == parent_id),
                "field parent {:?} should be a well",
                parent_id,
            );
        }

        // Should have transforms (field->well).
        assert!(!result.manifest.transforms().is_empty());

        // Should have one image per field.
        assert_eq!(result.manifest.images().len(), fields.len());

        // Fetch should be Proxied with one spec per image.
        if let FetchSource::Proxied(ref proxied) = result.fetch {
            assert_eq!(proxied.images.len(), fields.len());
        } else {
            panic!("Expected Proxied fetch descriptor");
        }

        // Binding seed should have one entry per image, each with store_prefix.
        assert_eq!(result.binding_seed.images.len(), fields.len());
        for img in &result.binding_seed.images {
            assert!(img.store_prefix.is_some());
        }

        // Verify source layout places wells, not fields.
        let layout = &result.manifest.source_layouts()[0];
        for placement in &layout.placements {
            assert!(
                wells.iter().any(|w| w.id == placement.entity_id),
                "Layout should only place wells, not fields",
            );
        }

        // Verify multiscale levels on images.
        for image in result.manifest.images() {
            assert_eq!(image.multiscale.levels.len(), 2, "expected 2 levels");
            let l0 = &image.multiscale.levels[0];
            assert_eq!(l0.shape, [1, 1, 10, 256, 256]);
            assert_eq!(l0.chunk_shape, [1, 1, 1, 128, 128]);
            for d in 0..5 {
                assert_eq!(l0.grid_shape[d], l0.shape[d].div_ceil(l0.chunk_shape[d]),);
            }
        }

        // DatasetKind::Plate should carry correct metadata.
        match &result.manifest.kind {
            DatasetKind::Plate {
                rows,
                columns,
                positioning_mode,
                has_stage_positions,
            } => {
                assert_eq!(rows, &["A", "B"]);
                assert_eq!(columns, &["1", "2"]);
                assert_eq!(*positioning_mode, PositioningMode::Grid);
                assert!(!has_stage_positions);
            }
            _ => panic!("expected Plate kind"),
        }

        // Pretty-print for visual inspection.
        println!("{}", serde_json::to_string_pretty(&result).unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_plate_with_stage_positions() {
        let dir = temp_dir("import_plate_stage");
        fs::create_dir_all(&dir).unwrap();

        // Build plate root with stage translations on the FOVs.
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "plate": {
                        "version": "0.5",
                        "name": "stage_plate",
                        "rows": [{"name": "A"}],
                        "columns": [{"name": "1"}],
                        "wells": [{"path": "A/1", "rowIndex": 0, "columnIndex": 0}]
                    }
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        // Well with stage-positioned FOVs.
        let well_dir = dir.join("A").join("1");
        fs::create_dir_all(&well_dir).unwrap();
        let well_meta = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "well": {
                        "images": [
                            {
                                "path": "0",
                                "coordinateTransformations": [{
                                    "type": "translation",
                                    "translation": [0.0, 0.0, 0.0, 100.0, 200.0]
                                }]
                            },
                            {
                                "path": "1",
                                "coordinateTransformations": [{
                                    "type": "translation",
                                    "translation": [0.0, 0.0, 0.0, 300.0, 600.0]
                                }]
                            }
                        ]
                    }
                }
            }
        });
        fs::write(
            well_dir.join("zarr.json"),
            serde_json::to_string_pretty(&well_meta).unwrap(),
        )
        .unwrap();

        // Write FOV multiscale metadata.
        for i in 0..2u32 {
            let fov_dir = well_dir.join(i.to_string());
            fs::create_dir_all(&fov_dir).unwrap();
            let fov_root = serde_json::json!({
                "zarr_format": 3,
                "node_type": "group",
                "attributes": {
                    "ome": {
                        "version": "0.5",
                        "multiscales": [{
                            "version": "0.5",
                            "name": "image",
                            "axes": [
                                {"name": "t", "type": "time"},
                                {"name": "c", "type": "channel"},
                                {"name": "z", "type": "space"},
                                {"name": "y", "type": "space"},
                                {"name": "x", "type": "space"}
                            ],
                            "datasets": [{
                                "path": "0",
                                "coordinateTransformations": [{
                                    "type": "scale",
                                    "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                                }]
                            }]
                        }]
                    }
                }
            });
            fs::write(
                fov_dir.join("zarr.json"),
                serde_json::to_string_pretty(&fov_root).unwrap(),
            )
            .unwrap();

            let level_dir = fov_dir.join("0");
            fs::create_dir_all(&level_dir).unwrap();
            let arr = serde_json::json!({
                "zarr_format": 3,
                "node_type": "array",
                "shape": [1, 1, 1, 128, 128],
                "data_type": "uint16",
                "chunk_grid": {
                    "name": "regular",
                    "configuration": { "chunk_shape": [1, 1, 1, 64, 64] }
                },
                "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
                "fill_value": 0
            });
            fs::write(
                level_dir.join("zarr.json"),
                serde_json::to_string_pretty(&arr).unwrap(),
            )
            .unwrap();
        }

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "stage-id", "Stage Plate")
            .await
            .unwrap();

        // Should be a stage-positioned plate.
        if let DatasetKind::Plate {
            positioning_mode,
            has_stage_positions,
            ..
        } = &result.manifest.kind
        {
            assert_eq!(*positioning_mode, PositioningMode::Stage);
            assert!(*has_stage_positions);
        } else {
            panic!("expected Plate kind");
        }

        // Transforms should reflect normalized stage positions.
        assert_eq!(result.manifest.transforms().len(), 2);
        // FOV 0 translation [y=100, x=200] => position [x=200, y=100], normalized min.
        // FOV 1 translation [y=300, x=600] => position [x=600, y=300].
        // min_x=200, min_y=100 => FOV 0 at (0,0), FOV 1 at (400,200).
        let t0 = &result.manifest.transforms()[0];
        let t1 = &result.manifest.transforms()[1];
        assert!(
            (t0.transform.matrix()[12]).abs() < 1e-9,
            "FOV 0 tx should be 0"
        );
        assert!(
            (t0.transform.matrix()[13]).abs() < 1e-9,
            "FOV 0 ty should be 0"
        );
        assert!(
            (t1.transform.matrix()[12] - 400.0).abs() < 1e-9,
            "FOV 1 tx should be 400, got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 200.0).abs() < 1e-9,
            "FOV 1 ty should be 200, got {}",
            t1.transform.matrix()[13],
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Build a single-well stage-positioned plate fixture.
    ///
    /// `translations[i]` is written verbatim as the FOV's
    /// `coordinateTransformations.translation` (5-element TCZYX). Pass `None`
    /// to omit the entry, producing a grid-positioned well.
    /// `scale` is the level-0 [T, C, Z, Y, X] scale; pass `None` to omit the
    /// `scale` coordinate transform entirely (so default scale of 1.0 applies).
    fn create_stage_plate_fixture(
        dir: &std::path::Path,
        translations: &[Option<[f64; 5]>],
        scale: Option<[f64; 5]>,
    ) {
        fs::create_dir_all(dir).unwrap();

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "plate": {
                        "version": "0.5",
                        "name": "test_plate",
                        "rows": [{"name": "A"}],
                        "columns": [{"name": "1"}],
                        "wells": [{"path": "A/1", "rowIndex": 0, "columnIndex": 0}]
                    }
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        let well_dir = dir.join("A").join("1");
        fs::create_dir_all(&well_dir).unwrap();

        let row_dir = dir.join("A");
        let row_meta = serde_json::json!({"zarr_format": 3, "node_type": "group"});
        fs::write(
            row_dir.join("zarr.json"),
            serde_json::to_string_pretty(&row_meta).unwrap(),
        )
        .unwrap();

        let images: Vec<serde_json::Value> = translations
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut entry = serde_json::json!({"path": i.to_string()});
                if let Some(translation) = t {
                    entry["coordinateTransformations"] = serde_json::json!([{
                        "type": "translation",
                        "translation": translation,
                    }]);
                }
                entry
            })
            .collect();

        let well_meta = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "well": { "images": images }
                }
            }
        });
        fs::write(
            well_dir.join("zarr.json"),
            serde_json::to_string_pretty(&well_meta).unwrap(),
        )
        .unwrap();

        for i in 0..translations.len() {
            let fov_dir = well_dir.join(i.to_string());
            fs::create_dir_all(&fov_dir).unwrap();

            // Optionally include the scale coordinate transform.
            let mut dataset = serde_json::json!({"path": "0"});
            if let Some(s) = scale {
                dataset["coordinateTransformations"] = serde_json::json!([{
                    "type": "scale",
                    "scale": s,
                }]);
            }

            let fov_root = serde_json::json!({
                "zarr_format": 3,
                "node_type": "group",
                "attributes": {
                    "ome": {
                        "version": "0.5",
                        "multiscales": [{
                            "version": "0.5",
                            "name": "image",
                            "axes": [
                                {"name": "t", "type": "time"},
                                {"name": "c", "type": "channel"},
                                {"name": "z", "type": "space"},
                                {"name": "y", "type": "space"},
                                {"name": "x", "type": "space"}
                            ],
                            "datasets": [dataset]
                        }]
                    }
                }
            });
            fs::write(
                fov_dir.join("zarr.json"),
                serde_json::to_string_pretty(&fov_root).unwrap(),
            )
            .unwrap();

            let level_dir = fov_dir.join("0");
            fs::create_dir_all(&level_dir).unwrap();
            let arr = serde_json::json!({
                "zarr_format": 3,
                "node_type": "array",
                "shape": [1, 1, 1, 128, 128],
                "data_type": "uint16",
                "chunk_grid": {
                    "name": "regular",
                    "configuration": { "chunk_shape": [1, 1, 1, 64, 64] }
                },
                "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
                "fill_value": 0
            });
            fs::write(
                level_dir.join("zarr.json"),
                serde_json::to_string_pretty(&arr).unwrap(),
            )
            .unwrap();
        }
    }

    /// Find the field->well TransformEdge for a given field index. Field IDs
    /// follow the pattern `{dataset}:field:A/1/{i}` per the import code.
    fn find_field_transform<'a>(
        result: &'a ImportResult,
        dataset_id: &str,
        fov_index: usize,
    ) -> &'a TransformEdge {
        let target = format!("{dataset_id}:field:A/1/{fov_index}");
        result
            .manifest
            .transforms()
            .iter()
            .find(|t| t.from.0 == target)
            .unwrap_or_else(|| {
                panic!(
                    "no transform from {target}; available: {:?}",
                    result
                        .manifest
                        .transforms()
                        .iter()
                        .map(|t| t.from.0.clone())
                        .collect::<Vec<_>>(),
                )
            })
    }

    /// Stage translations stored in microns must be converted to voxel
    /// units before forming the field->well transform.
    /// FOV 0 at (0, 0); FOV 1 at (100 µm, 200 µm). With Y/X scale of
    /// 0.5 µm/voxel the second FOV ends up at (200, 400) voxels.
    #[tokio::test]
    async fn stage_translations_normalized_to_voxel_units() {
        let dir = temp_dir("stage_translations_voxel_units");
        // Translations are TCZYX. The test puts X=100 µm, Y=200 µm on FOV 1.
        let translations = vec![
            Some([0.0, 0.0, 0.0, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0, 200.0, 100.0]),
        ];
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.5]);
        create_stage_plate_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "stage-vox", "Stage Voxel")
            .await
            .unwrap();

        // Sanity: should be Stage-positioned.
        if let DatasetKind::Plate {
            positioning_mode,
            has_stage_positions,
            ..
        } = &result.manifest.kind
        {
            assert_eq!(*positioning_mode, PositioningMode::Stage);
            assert!(*has_stage_positions);
        } else {
            panic!("expected Plate kind");
        }

        // FOV 0 is the per-well origin.
        let t0 = find_field_transform(&result, "stage-vox", 0);
        assert!(
            (t0.transform.matrix()[12]).abs() < 1e-9,
            "FOV 0 tx should be 0"
        );
        assert!(
            (t0.transform.matrix()[13]).abs() < 1e-9,
            "FOV 0 ty should be 0"
        );

        // FOV 1: 100 µm / 0.5 = 200 voxels in X, 200 µm / 0.5 = 400 voxels in Y.
        let t1 = find_field_transform(&result, "stage-vox", 1);
        assert!(
            (t1.transform.matrix()[12] - 200.0).abs() < 1e-9,
            "FOV 1 tx should be 200 voxels, got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 400.0).abs() < 1e-9,
            "FOV 1 ty should be 400 voxels, got {}",
            t1.transform.matrix()[13],
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Grid-positioned plates (no translations) must be unaffected by the
    /// scale-conversion code path.
    #[tokio::test]
    async fn grid_plates_unaffected() {
        let dir = temp_dir("grid_plates_unaffected");
        // Two FOVs, neither with a translation -> grid-positioned plate.
        let translations = vec![None, None];
        // Choose a non-trivial scale so the wrong code path would be visible.
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.5]);
        create_stage_plate_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "grid-plate", "Grid Plate")
            .await
            .unwrap();

        // Sanity: should be Grid-positioned.
        if let DatasetKind::Plate {
            positioning_mode,
            has_stage_positions,
            ..
        } = &result.manifest.kind
        {
            assert_eq!(*positioning_mode, PositioningMode::Grid);
            assert!(!*has_stage_positions);
        } else {
            panic!("expected Plate kind");
        }

        // The grid formula: for n=2 fields, cols = ceil(sqrt(2)) = 2,
        // gap = 0.08 * 128 = 10.24, so field 0 at (0, 0), field 1 at
        // (128 + 10.24, 0). FOV size is 128x128 (level 0 shape).
        let fov_x = 128.0_f64;
        let gap_x = 0.08 * fov_x;

        let t0 = find_field_transform(&result, "grid-plate", 0);
        assert!((t0.transform.matrix()[12]).abs() < 1e-9, "field 0 tx");
        assert!((t0.transform.matrix()[13]).abs() < 1e-9, "field 0 ty");

        let t1 = find_field_transform(&result, "grid-plate", 1);
        assert!(
            (t1.transform.matrix()[12] - (fov_x + gap_x)).abs() < 1e-9,
            "field 1 tx should be {} voxels, got {}",
            fov_x + gap_x,
            t1.transform.matrix()[12],
        );
        assert!((t1.transform.matrix()[13]).abs() < 1e-9, "field 1 ty");

        let _ = fs::remove_dir_all(&dir);
    }

    /// When the multiscales `scale` coordinate transform is omitted, the
    /// default scale is 1.0 (per parse.rs), so stage translations should pass
    /// through to voxel units unchanged.
    #[tokio::test]
    async fn missing_voxel_scale_falls_back_to_unit_scale() {
        let dir = temp_dir("missing_voxel_scale");
        // FOV 1 at translation (100 µm, 200 µm) — but with scale=1.0 (the
        // default), the conversion is a no-op and the voxel translation
        // matches the raw value.
        let translations = vec![
            Some([0.0, 0.0, 0.0, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0, 200.0, 100.0]),
        ];
        // No explicit scale entry -> default of 1.0 in parse.rs.
        create_stage_plate_fixture(&dir, &translations, None);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "missing-scale", "Missing Scale")
            .await
            .unwrap();

        // FOV 0 at origin.
        let t0 = find_field_transform(&result, "missing-scale", 0);
        assert!((t0.transform.matrix()[12]).abs() < 1e-9);
        assert!((t0.transform.matrix()[13]).abs() < 1e-9);

        // FOV 1: pass-through (raw 100 -> 100 voxels in X, 200 -> 200 in Y).
        let t1 = find_field_transform(&result, "missing-scale", 1);
        assert!(
            (t1.transform.matrix()[12] - 100.0).abs() < 1e-9,
            "FOV 1 tx should be 100 voxels (pass-through), got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 200.0).abs() < 1e-9,
            "FOV 1 ty should be 200 voxels (pass-through), got {}",
            t1.transform.matrix()[13],
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A zero (or non-finite) voxel scale is malformed metadata. We must not
    /// panic or divide by zero — the import falls back to a unit scale and
    /// translations are passed through unchanged.
    #[tokio::test]
    async fn zero_voxel_scale_falls_back_with_warning() {
        let dir = temp_dir("zero_voxel_scale");
        let translations = vec![
            Some([0.0, 0.0, 0.0, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0, 200.0, 100.0]),
        ];
        // X scale (last value) is zero — invalid. Y scale is fine.
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.0]);
        create_stage_plate_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "zero-scale", "Zero Scale")
            .await
            .unwrap();

        // FOV 0 at origin.
        let t0 = find_field_transform(&result, "zero-scale", 0);
        assert!((t0.transform.matrix()[12]).abs() < 1e-9);
        assert!((t0.transform.matrix()[13]).abs() < 1e-9);

        // FOV 1: X falls back to scale=1 (raw 100 -> 100). Y uses real
        // scale=0.5 (raw 200 -> 400). Verify no NaN/Inf.
        let t1 = find_field_transform(&result, "zero-scale", 1);
        assert!(
            t1.transform.matrix()[12].is_finite(),
            "FOV 1 tx must be finite (no division by zero), got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[12] - 100.0).abs() < 1e-9,
            "FOV 1 tx should be 100 (X scale fell back to 1.0), got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 400.0).abs() < 1e-9,
            "FOV 1 ty should be 400 (Y scale 0.5 still applied), got {}",
            t1.transform.matrix()[13],
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Create a minimal single-image OME-Zarr fixture with a non-canonical `m`
    /// axis between `z` and `y` (mimics CZI mosaic exports). Only metadata —
    /// no chunk bytes (the import path is metadata-only).
    fn create_6d_with_m_fixture(dir: &std::path::Path) {
        fs::create_dir_all(dir).unwrap();

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "version": "0.5",
                        "name": "ScanRegion0",
                        "axes": [
                            {"name": "t", "type": "time"},
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space"},
                            {"name": "m", "type": "space"},
                            {"name": "y", "type": "space"},
                            {"name": "x", "type": "space"}
                        ],
                        "datasets": [{
                            "path": "0",
                            "coordinateTransformations": [{
                                "type": "scale",
                                "scale": [1.0, 1.0, 0.75, 1.0, 0.34, 0.34]
                            }]
                        }]
                    }]
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        let level_dir = dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [1, 4, 1, 6, 2048, 1504],
            "data_type": "uint16",
            "chunk_grid": {
                "name": "regular",
                "configuration": { "chunk_shape": [1, 1, 1, 2, 2048, 1504] }
            },
            "codecs": [
                {"name": "bytes", "configuration": {"endian": "little"}}
            ],
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// End-to-end: a 6D OME-Zarr with a non-canonical `m` axis ingests
    /// without error. The canonical `axes` list is filtered to length 5,
    /// `pinned_axes` captures the dropped `m`, and the binding seed
    /// preserves the raw 6-axis list so the chunk-path resolver can inject
    /// `0` at the m position.
    #[tokio::test]
    async fn import_6d_with_non_canonical_m_axis() {
        let dir = temp_dir("import_6d_m");
        create_6d_with_m_fixture(&dir);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "czi-test", "CZI Test")
            .await
            .unwrap();

        assert!(matches!(result.manifest.kind, DatasetKind::Single));
        assert_eq!(result.manifest.images().len(), 1);

        let multiscale = &result.manifest.images()[0].multiscale;

        // axes is canonical-only, length 5, no `m`.
        assert_eq!(multiscale.axes.len(), 5);
        let names: Vec<&str> = multiscale.axes.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["t", "c", "z", "y", "x"]);

        // pinned_axes captures the dropped `m`.
        assert_eq!(
            multiscale.pinned_axes,
            vec![PinnedAxis {
                name: "m".to_string(),
                size: 6,
                pinned_index: 0,
            }]
        );

        // Level shape is canonical 5D, m's size 6 is dropped.
        assert_eq!(multiscale.levels.len(), 1);
        assert_eq!(multiscale.levels[0].shape, [1, 4, 1, 2048, 1504]);
        assert_eq!(multiscale.levels[0].chunk_shape, [1, 1, 1, 2048, 1504]);

        // Binding seed retains the raw 6-axis list so the on-disk path
        // resolver can inject 0 at the m position.
        assert_eq!(result.binding_seed.images.len(), 1);
        assert_eq!(
            result.binding_seed.images[0].axes_names,
            vec!["t", "c", "z", "m", "y", "x"],
        );

        // levels[0].chunk_byte_layout captures the m=2 chunk requiring
        // prefix slicing — canonical chunk is 2048*1504*2 = 6160384
        // bytes; on-disk chunk is twice that.
        assert_eq!(result.binding_seed.images[0].levels.len(), 1);
        let level0 = &result.binding_seed.images[0].levels[0];
        assert_eq!(level0.level_index, 0);
        let layout = level0.chunk_byte_layout;
        assert_ne!(layout.canonical_byte_size, layout.on_disk_byte_size);
        assert_eq!(layout.canonical_byte_size, 2048 * 1504 * 2);
        assert_eq!(layout.on_disk_byte_size, 2 * 2048 * 1504 * 2);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Synthesize a 6D OME-Zarr fixture with custom axes order and
    /// chunk shape so we can exercise the non-prefix rejection path.
    fn create_6d_fixture_with_axes(
        dir: &std::path::Path,
        axes: &[&str],
        shape: &[u64],
        chunk: &[u64],
        codec_after_bytes: Option<serde_json::Value>,
    ) {
        let axes_json: Vec<serde_json::Value> = axes
            .iter()
            .map(|name| {
                let kind = match name.to_lowercase().as_str() {
                    "t" => "time",
                    "c" => "channel",
                    _ => "space",
                };
                serde_json::json!({"name": name, "type": kind})
            })
            .collect();
        create_fixture_with_axes_json(dir, &axes_json, shape, chunk, codec_after_bytes);
    }

    /// Like [`create_6d_fixture_with_axes`] but takes the raw axes JSON
    /// entries, so tests can exercise metadata edge cases such as an axes
    /// entry without a `"name"` key.
    fn create_fixture_with_axes_json(
        dir: &std::path::Path,
        axes_json: &[serde_json::Value],
        shape: &[u64],
        chunk: &[u64],
        codec_after_bytes: Option<serde_json::Value>,
    ) {
        fs::create_dir_all(dir).unwrap();

        let scale: Vec<f64> = vec![1.0; axes_json.len()];
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "version": "0.5",
                        "name": "img",
                        "axes": axes_json,
                        "datasets": [{
                            "path": "0",
                            "coordinateTransformations": [{"type": "scale", "scale": scale}]
                        }]
                    }]
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        let level_dir = dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();

        let mut codecs =
            vec![serde_json::json!({"name": "bytes", "configuration": {"endian": "little"}})];
        if let Some(c) = codec_after_bytes {
            codecs.push(c);
        }

        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": shape,
            "data_type": "uint16",
            "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": chunk } },
            "codecs": codecs,
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// 6D-with-m + lz4 codec + m chunk_size=2 → import succeeds;
    /// the binding seed records [`StorageCompression::Lz4`] and the
    /// per-level layout reflects pinned-axis prefix slicing
    /// (canonical_byte_size != on_disk_byte_size).
    #[tokio::test]
    async fn import_6d_with_m_and_lz4_compresses_and_slices() {
        let dir = temp_dir("import_6d_m_lz4");
        create_6d_fixture_with_axes(
            &dir,
            &["t", "c", "z", "m", "y", "x"],
            &[1, 1, 1, 4, 64, 64],
            &[1, 1, 1, 2, 64, 64],
            Some(serde_json::json!({"name": "numcodecs/lz4", "configuration": {}})),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "lz4-6d", "lz4 6D").await.unwrap();

        assert_eq!(result.binding_seed.images[0].levels.len(), 1);
        let level0 = &result.binding_seed.images[0].levels[0];
        let layout = level0.chunk_byte_layout;
        assert_ne!(
            layout.canonical_byte_size, layout.on_disk_byte_size,
            "chunk_size=2 on m axis should require slicing",
        );
        assert_eq!(layout.canonical_byte_size, 64 * 64 * 2);
        assert_eq!(layout.on_disk_byte_size, 2 * 64 * 64 * 2);

        // The lz4 codec should be recognized at parse time, before the
        // binding ever reaches the chunk-fetch path.
        assert_eq!(level0.compression, crate::codec::StorageCompression::Lz4);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 6D-with-m + blosc-zstd-bitshuffle → import succeeds and records
    /// the validated [`BloscConfig`] in level info.
    #[tokio::test]
    async fn import_6d_with_m_and_blosc() {
        let dir = temp_dir("import_6d_m_blosc");
        create_6d_fixture_with_axes(
            &dir,
            &["t", "c", "z", "m", "y", "x"],
            &[1, 1, 1, 4, 64, 64],
            &[1, 1, 1, 2, 64, 64],
            Some(serde_json::json!({
                "name": "blosc",
                "configuration": {
                    "typesize": 2,
                    "cname": "zstd",
                    "shuffle": "bitshuffle",
                    "blocksize": 0,
                    "clevel": 3
                }
            })),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "blosc-6d", "blosc 6D")
            .await
            .unwrap();

        let level0 = &result.binding_seed.images[0].levels[0];
        match level0.compression {
            crate::codec::StorageCompression::Blosc(cfg) => {
                assert_eq!(cfg.cname, crate::codec::BloscCompressor::Zstd);
                assert_eq!(cfg.shuffle, crate::codec::BloscShuffle::Bit);
                assert_eq!(cfg.typesize, 2);
            }
            other => panic!("expected Blosc compression, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// Non-prefix axis layout (e.g. `[t,c,z,y,m,x]` with y_chunk > 1)
    /// is rejected at import with an error that names the offending
    /// axis and the phrase "non-prefix".
    #[tokio::test]
    async fn import_rejects_non_prefix_pinned_axis_layout() {
        let dir = temp_dir("import_6d_m_nonprefix");
        create_6d_fixture_with_axes(
            &dir,
            &["t", "c", "z", "y", "m", "x"],
            &[1, 1, 1, 64, 4, 64],
            &[1, 1, 1, 64, 2, 64],
            None,
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "bad-6d", "Bad 6D")
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('m'), "error should name 'm': {msg}");
        assert!(
            msg.contains("non-prefix"),
            "error should say 'non-prefix': {msg}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Synthesize a single-image 5D OME-Zarr with one or more pyramid
    /// levels and a custom codec chain per level, used by the codec
    /// rejection tests. Each level shares the same shape/chunk; only
    /// the codec chain varies. The fixture is metadata-only (no chunk
    /// bytes).
    fn create_5d_fixture_with_per_level_codecs(
        dir: &std::path::Path,
        per_level_codecs: &[Vec<serde_json::Value>],
    ) {
        fs::create_dir_all(dir).unwrap();

        let datasets: Vec<serde_json::Value> = (0..per_level_codecs.len())
            .map(|i| {
                serde_json::json!({
                    "path": i.to_string(),
                    "coordinateTransformations": [{
                        "type": "scale",
                        "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                    }]
                })
            })
            .collect();

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "version": "0.5",
                        "name": "img",
                        "axes": [
                            {"name": "t", "type": "time"},
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space"},
                            {"name": "y", "type": "space"},
                            {"name": "x", "type": "space"}
                        ],
                        "datasets": datasets
                    }]
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        for (i, codecs) in per_level_codecs.iter().enumerate() {
            let level_dir = dir.join(i.to_string());
            fs::create_dir_all(&level_dir).unwrap();
            let arr = serde_json::json!({
                "zarr_format": 3,
                "node_type": "array",
                "shape": [1, 1, 1, 64, 64],
                "data_type": "uint16",
                "chunk_grid": {
                    "name": "regular",
                    "configuration": { "chunk_shape": [1, 1, 1, 64, 64] }
                },
                "codecs": codecs,
                "fill_value": 0
            });
            fs::write(
                level_dir.join("zarr.json"),
                serde_json::to_string_pretty(&arr).unwrap(),
            )
            .unwrap();
        }
    }

    /// An unknown codec name (`gzip`) at level 0 fails import with a
    /// message that names both the offending codec and the level index.
    #[tokio::test]
    async fn import_rejects_unknown_codec_with_level_and_name() {
        let dir = temp_dir("import_reject_gzip_l0");
        create_5d_fixture_with_per_level_codecs(
            &dir,
            &[vec![
                serde_json::json!({"name": "bytes", "configuration": {"endian": "little"}}),
                serde_json::json!({"name": "gzip"}),
            ]],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "gzip-bad", "gzip bad")
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(msg.contains("gzip"), "error should name 'gzip': {msg}");
        assert!(
            msg.contains("level 0"),
            "error should mention 'level 0': {msg}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A `bytes` codec with `endian: "big"` fails import with a
    /// message that names the offending value.
    #[tokio::test]
    async fn import_rejects_big_endian_bytes_codec() {
        let dir = temp_dir("import_reject_big_endian");
        create_5d_fixture_with_per_level_codecs(
            &dir,
            &[vec![
                serde_json::json!({"name": "bytes", "configuration": {"endian": "big"}}),
            ]],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "big-endian-bad", "big endian bad")
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(msg.contains("big"), "error should mention 'big': {msg}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A mid-pyramid codec change (level 0 lz4, level 1 `gzip`) fails
    /// import with a message that pinpoints level 1.
    #[tokio::test]
    async fn import_rejects_mid_pyramid_unknown_codec() {
        let dir = temp_dir("import_reject_mid_pyramid");
        create_5d_fixture_with_per_level_codecs(
            &dir,
            &[
                vec![
                    serde_json::json!({"name": "bytes", "configuration": {"endian": "little"}}),
                    serde_json::json!({"name": "lz4"}),
                ],
                vec![
                    serde_json::json!({"name": "bytes", "configuration": {"endian": "little"}}),
                    serde_json::json!({"name": "gzip"}),
                ],
            ],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "mid-pyramid-bad", "mid-pyramid bad")
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(
            msg.contains("level 1"),
            "error should mention 'level 1': {msg}"
        );
        assert!(msg.contains("gzip"), "error should name 'gzip': {msg}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Blosc with an unsupported `cname` (`blosclz`) fails import with
    /// a message that names the offending value verbatim.
    #[tokio::test]
    async fn import_rejects_blosc_with_unsupported_cname() {
        let dir = temp_dir("import_reject_blosc_blosclz");
        create_5d_fixture_with_per_level_codecs(
            &dir,
            &[vec![
                serde_json::json!({"name": "bytes", "configuration": {"endian": "little"}}),
                serde_json::json!({
                    "name": "blosc",
                    "configuration": {
                        "cname": "blosclz",
                        "shuffle": "bitshuffle",
                        "typesize": 2
                    }
                }),
            ]],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "blosc-blosclz", "blosc blosclz")
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(
            msg.contains("blosclz"),
            "error should name 'blosclz': {msg}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Minimal single-image 5D OME-Zarr fixture (metadata only). When
    /// `omero` is `Some`, it is spliced verbatim into `attributes.ome.omero`
    /// so tests can supply well-formed *or* malformed omero blocks.
    fn create_single_image_fixture(dir: &std::path::Path, omero: Option<serde_json::Value>) {
        fs::create_dir_all(dir).unwrap();

        let mut ome = serde_json::json!({
            "version": "0.5",
            "multiscales": [{
                "version": "0.5",
                "name": "image",
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "c", "type": "channel"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"}
                ],
                "datasets": [{
                    "path": "0",
                    "coordinateTransformations": [{
                        "type": "scale",
                        "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                    }]
                }]
            }]
        });
        if let Some(o) = omero {
            ome["omero"] = o;
        }

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": ome }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        let level_dir = dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [1, 2, 1, 64, 64],
            "data_type": "uint16",
            "chunk_grid": {
                "name": "regular",
                "configuration": { "chunk_shape": [1, 1, 1, 64, 64] }
            },
            "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// A single image whose omero block carries channel labels yields a
    /// manifest exposing those labels (and colors) in order.
    #[tokio::test]
    async fn import_single_image_with_omero_channels() {
        let dir = temp_dir("import_omero_channels");
        create_single_image_fixture(
            &dir,
            Some(serde_json::json!({
                "channels": [
                    {"label": "DAPI", "color": "0000FF"},
                    {"label": "GFP", "color": "00FF00"}
                ]
            })),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "omero-id", "Omero").await.unwrap();

        let ci = &result.manifest.images()[0].multiscale.channel_infos;
        assert_eq!(ci.len(), 2);
        assert_eq!(ci[0].label, "DAPI");
        assert_eq!(ci[0].color.as_deref(), Some("0000FF"));
        assert_eq!(ci[1].label, "GFP");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A single image with NO omero block imports cleanly with empty
    /// channel_infos (back-compat: pre-omero datasets are unaffected).
    #[tokio::test]
    async fn import_single_image_without_omero_has_empty_channel_infos() {
        let dir = temp_dir("import_no_omero");
        create_single_image_fixture(&dir, None);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "no-omero-id", "No Omero")
            .await
            .unwrap();

        assert!(
            result.manifest.images()[0]
                .multiscale
                .channel_infos
                .is_empty(),
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A malformed omero block (channels not an array) must not fail import;
    /// it degrades to empty channel_infos.
    #[tokio::test]
    async fn import_single_image_with_malformed_omero_degrades() {
        let dir = temp_dir("import_malformed_omero");
        create_single_image_fixture(
            &dir,
            Some(serde_json::json!({ "channels": "not-an-array" })),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "bad-omero-id", "Bad Omero")
            .await
            .expect("malformed omero must not fail import");

        assert!(
            result.manifest.images()[0]
                .multiscale
                .channel_infos
                .is_empty(),
        );

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Label import fixtures ---

    /// Write a `labels/` group listing `names` into an existing image or FOV
    /// directory (`group_dir/labels/zarr.json`).
    fn write_labels_index(group_dir: &std::path::Path, names: &[&str]) {
        let labels_dir = group_dir.join("labels");
        fs::create_dir_all(&labels_dir).unwrap();
        let json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {"version": "0.5", "labels": names}}
        });
        fs::write(
            labels_dir.join("zarr.json"),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
    }

    /// Write a single-level label multiscale group at
    /// `group_dir/labels/{name}`. `image_label` is spliced verbatim as
    /// `ome.image-label`; pass `Value::Null` to omit the block entirely.
    #[allow(clippy::too_many_arguments)]
    fn write_label_multiscale(
        group_dir: &std::path::Path,
        name: &str,
        axes: &[&str],
        shape: &[u64],
        chunk: &[u64],
        scale: &[f64],
        dtype: &str,
        image_label: serde_json::Value,
    ) {
        let label_dir = group_dir.join("labels").join(name);
        fs::create_dir_all(&label_dir).unwrap();

        let axes_json: Vec<serde_json::Value> = axes
            .iter()
            .map(|n| {
                let kind = match n.to_lowercase().as_str() {
                    "t" => "time",
                    "c" => "channel",
                    _ => "space",
                };
                serde_json::json!({"name": n, "type": kind})
            })
            .collect();

        let mut ome = serde_json::json!({
            "version": "0.5",
            "multiscales": [{
                "version": "0.5",
                "name": name,
                "axes": axes_json,
                "datasets": [{
                    "path": "0",
                    "coordinateTransformations": [{"type": "scale", "scale": scale}]
                }]
            }]
        });
        if !image_label.is_null() {
            ome["image-label"] = image_label;
        }

        let group = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": ome}
        });
        fs::write(
            label_dir.join("zarr.json"),
            serde_json::to_string_pretty(&group).unwrap(),
        )
        .unwrap();

        let level_dir = label_dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": shape,
            "data_type": dtype,
            "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": chunk}},
            "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// Write a label group whose zarr.json is present but has no multiscales,
    /// so building it fails and the label must be skipped.
    fn write_broken_label_group(group_dir: &std::path::Path, name: &str) {
        let label_dir = group_dir.join("labels").join(name);
        fs::create_dir_all(&label_dir).unwrap();
        let group = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {"version": "0.5"}}
        });
        fs::write(
            label_dir.join("zarr.json"),
            serde_json::to_string_pretty(&group).unwrap(),
        )
        .unwrap();
    }

    /// A standalone image with a `labels/` group attaches the label with its
    /// OWN axes, dtype, and scale preserved distinct from the source image, and
    /// exposes it as a streamable image (fetch + binding) that is not part of
    /// `manifest.images()`.
    #[tokio::test]
    async fn import_single_image_with_label_overlay() {
        let dir = temp_dir("import_single_label");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["mitochondria"]);
        write_label_multiscale(
            &dir,
            "mitochondria",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 4.0, 4.0], // 4x coarser in y/x than the source
            "uint32",
            serde_json::json!({
                "version": "0.5",
                "colors": [
                    {"label-value": 2, "rgba": [230, 25, 75, 255]},
                    {"label-value": 92801, "rgba": [0, 0, 128, 255]}
                ],
                "source": {"image": "../../"}
            }),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "lbl-id", "Labeled").await.unwrap();

        // The base image import is unchanged.
        assert!(matches!(result.manifest.kind, DatasetKind::Single));
        assert_eq!(result.manifest.images().len(), 1);
        let source_image_id = result.manifest.images()[0].image_id.clone();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1);
        let label = &labels[0];
        assert_eq!(label.name, "mitochondria");
        assert_eq!(label.source_image_id, source_image_id);
        // dtype preserved end to end (uint32), never narrowed.
        assert_eq!(label.data_type, DataType::Uint32);
        // The label's own axes (no channel), distinct from the source's TCZYX.
        assert_eq!(label.axis_names, vec!["t", "z", "y", "x"]);
        // The label's own level-0 scale, normalized to 5D with c filled to 1.
        assert_eq!(label.level0_scale, [1.0, 1.0, 1.0, 4.0, 4.0]);
        // Colors, including a value well beyond u16::MAX.
        assert_eq!(label.colors.len(), 2);
        assert_eq!(label.colors[0].rgba, [230, 25, 75, 255]);
        assert_eq!(label.colors[1].value, 92801);
        assert!(label.source_declared);

        // The label image is streamable and distinct from the source image, and
        // is deliberately absent from manifest.images().
        let label_image_id = label.label_image_id.clone();
        assert_ne!(label_image_id, source_image_id);
        assert!(
            !result
                .manifest
                .images()
                .iter()
                .any(|i| i.image_id == label_image_id),
            "label must not appear among ordinary images",
        );

        if let FetchSource::Proxied(ref p) = result.fetch {
            assert_eq!(p.images.len(), 2, "source image + label image");
            assert!(p.images.iter().any(|i| i.image_id == label_image_id));
        } else {
            panic!("expected Proxied fetch");
        }

        let binding = result
            .binding_seed
            .images
            .iter()
            .find(|b| b.image_id == label_image_id)
            .expect("label has a binding seed");
        assert_eq!(binding.store_prefix.as_deref(), Some("labels/mitochondria"));
        assert_eq!(binding.axes_names, vec!["t", "z", "y", "x"]);
        assert!(!binding.levels.is_empty());

        // The stored spec exposes the label's full multiscale for streaming.
        let spec = result
            .manifest
            .label_specs()
            .iter()
            .find(|s| s.name == "mitochondria")
            .unwrap();
        assert_eq!(spec.image.multiscale.data_type, DataType::Uint32);
        assert_eq!(spec.image.multiscale.levels[0].shape, [1, 1, 1, 16, 16]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A standalone image with no `labels/` group imports exactly as before:
    /// no labels, and the fetch/binding carry only the source image.
    #[tokio::test]
    async fn import_single_image_without_labels_has_no_labels() {
        let dir = temp_dir("import_no_labels");
        create_single_image_fixture(&dir, None);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "no-lbl", "No Labels").await.unwrap();

        assert!(result.manifest.labels().is_empty());
        if let FetchSource::Proxied(ref p) = result.fetch {
            assert_eq!(p.images.len(), 1);
        }
        assert_eq!(result.binding_seed.images.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A malformed label is skipped without failing the import; well-formed
    /// labels alongside it still attach, and a label whose `image-label` is
    /// malformed degrades to empty colors.
    #[tokio::test]
    async fn malformed_label_is_skipped_without_failing_import() {
        let dir = temp_dir("import_label_degrade");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["good", "broken", "nocolors"]);
        write_label_multiscale(
            &dir,
            "good",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint16",
            serde_json::json!({
                "colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}],
                "source": {"image": "../../"}
            }),
        );
        write_broken_label_group(&dir, "broken");
        write_label_multiscale(
            &dir,
            "nocolors",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint8",
            serde_json::json!({"colors": "not-an-array"}),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "degrade", "Degrade")
            .await
            .expect("a malformed label must not fail the whole import");

        // The source image still imported.
        assert_eq!(result.manifest.images().len(), 1);

        let labels = result.manifest.labels();
        let names: Vec<&str> = labels.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(labels.len(), 2, "broken label skipped, other two kept");
        assert!(names.contains(&"good"));
        assert!(names.contains(&"nocolors"));
        assert!(!names.contains(&"broken"));

        // The malformed image-label degraded gracefully.
        let nc = labels.iter().find(|l| l.name == "nocolors").unwrap();
        assert!(nc.colors.is_empty());
        assert!(!nc.source_declared);
        assert_eq!(nc.data_type, DataType::Uint8);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Labels nested under a single plate field attach to that field's image,
    /// with a field-nested store prefix, and leave DatasetKind and the field
    /// image set unchanged.
    #[tokio::test]
    async fn import_plate_with_labels_on_field() {
        let dir = temp_dir("import_plate_labels");
        create_plate_fixture(
            &dir,
            "p",
            &["A", "B"],
            &["1", "2"],
            &[
                ("A", "1", 0, 0, 2),
                ("A", "2", 0, 1, 1),
                ("B", "1", 1, 0, 1),
            ],
            [1, 1, 10, 256, 256],
            [1, 1, 1, 128, 128],
            2,
        );

        // Attach a "cells" label to field A/1/0 only.
        let fov_dir = dir.join("A").join("1").join("0");
        write_labels_index(&fov_dir, &["cells"]);
        write_label_multiscale(
            &fov_dir,
            "cells",
            &["t", "z", "y", "x"],
            &[1, 10, 256, 256],
            &[1, 1, 128, 128],
            &[1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({
                "colors": [{"label-value": 1, "rgba": [230, 25, 75, 128]}],
                "source": {"image": "../../"}
            }),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "plate-lbl", "Plate Labeled")
            .await
            .unwrap();

        // DatasetKind and field image set are unchanged (4 fields: 2+1+1).
        assert!(matches!(result.manifest.kind, DatasetKind::Plate { .. }));
        assert_eq!(result.manifest.images().len(), 4);

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1);
        let label = &labels[0];
        assert_eq!(label.name, "cells");
        assert_eq!(label.data_type, DataType::Uint32);
        assert_eq!(label.axis_names, vec!["t", "z", "y", "x"]);
        // Attached to the A/1/0 field image specifically.
        let expected_source = ImageId("plate-lbl:image:A/1/0".to_string());
        assert_eq!(label.source_image_id, expected_source);
        // That source image really exists in the manifest.
        assert!(
            result
                .manifest
                .images()
                .iter()
                .any(|i| i.image_id == expected_source),
        );

        // Streamable with a field-nested store prefix.
        let binding = result
            .binding_seed
            .images
            .iter()
            .find(|b| b.image_id == label.label_image_id)
            .expect("label binding present");
        assert_eq!(binding.store_prefix.as_deref(), Some("A/1/0/labels/cells"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Write a minimal single-image OME-Zarr fixture with a caller-chosen level-0
    /// shape and chunk shape (5D TCZYX). Metadata only.
    fn create_single_image_with_chunk(dir: &std::path::Path, shape: [u64; 5], chunk: [u64; 5]) {
        fs::create_dir_all(dir).unwrap();
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {
                "version": "0.5",
                "multiscales": [{
                    "version": "0.5",
                    "name": "image",
                    "axes": [
                        {"name": "t", "type": "time"},
                        {"name": "c", "type": "channel"},
                        {"name": "z", "type": "space"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [{"type": "scale", "scale": [1.0, 1.0, 1.0, 1.0, 1.0]}]
                    }]
                }]
            }}
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        let level_dir = dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": shape,
            "data_type": "uint16",
            "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": chunk}},
            "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// A label whose level-0 array has a zero chunk dimension (which would
    /// divide by zero when computing its grid) is skipped without panicking or
    /// failing the import; the source image and well-formed sibling labels still
    /// import.
    #[tokio::test]
    async fn label_with_zero_chunk_dimension_is_skipped() {
        let dir = temp_dir("import_label_zero_chunk");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["good", "zerochunk"]);
        write_label_multiscale(
            &dir,
            "good",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint16",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );
        // Zero in the Y chunk dimension.
        write_label_multiscale(
            &dir,
            "zerochunk",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 0, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({"colors": []}),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "zc", "Zero Chunk")
            .await
            .expect("a zero-chunk label must not panic or fail the whole import");

        // Source image still imported.
        assert_eq!(result.manifest.images().len(), 1);
        // Only the well-formed label survives; the zero-chunk one is skipped.
        let labels = result.manifest.labels();
        let names: Vec<&str> = labels.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(labels.len(), 1);
        assert!(names.contains(&"good"));
        assert!(!names.contains(&"zerochunk"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// A SOURCE image whose level-0 array has a zero chunk dimension must fail
    /// the import loudly with a clear `StoreError`, never a divide-by-zero panic.
    #[tokio::test]
    async fn source_image_with_zero_chunk_fails_without_panic() {
        let dir = temp_dir("import_source_zero_chunk");
        create_single_image_with_chunk(&dir, [1, 1, 1, 64, 64], [1, 1, 1, 0, 64]);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "szc", "Src Zero Chunk")
            .await
            .expect_err("a zero-chunk source array must fail the import");
        assert!(matches!(err, StoreError::Metadata(_)));
        assert!(
            err.to_string().contains("zero"),
            "error should name the zero dimension: {err}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The same guard applies on the plate path: a zero chunk dimension in the
    /// representative field's array fails loudly rather than panicking.
    #[tokio::test]
    async fn plate_source_with_zero_chunk_fails_without_panic() {
        let dir = temp_dir("import_plate_zero_chunk");
        create_plate_fixture(
            &dir,
            "p",
            &["A"],
            &["1"],
            &[("A", "1", 0, 0, 1)],
            [1, 1, 10, 256, 256],
            [1, 1, 1, 0, 128], // zero Y chunk
            1,
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "pzc", "Plate Zero Chunk")
            .await
            .expect_err("a zero-chunk plate field array must fail the import");
        assert!(matches!(err, StoreError::Metadata(_)));
        assert!(
            err.to_string().contains("zero"),
            "error should name the zero dimension: {err}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A SOURCE image with a zero chunk dimension on a non-canonical (pinned)
    /// axis must fail the import loudly. Normalizing to 5D drops the `m` axis,
    /// so only a check on the raw chunk_shape can catch this — admitting the
    /// level would leave it with an empty on-disk chunk byte layout that turns
    /// into corruption once a fetch path streams its chunks.
    #[tokio::test]
    async fn source_image_with_zero_chunk_on_pinned_axis_fails() {
        let dir = temp_dir("import_source_zero_chunk_pinned");
        create_6d_fixture_with_axes(
            &dir,
            &["t", "c", "z", "m", "y", "x"],
            &[1, 1, 1, 6, 64, 64],
            &[1, 1, 1, 0, 64, 64],
            None,
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "szc-m", "Src Zero Chunk M")
            .await
            .expect_err("a zero chunk dim on a pinned axis must fail the import");
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(
            msg.contains("level 0"),
            "error should name the level: {msg}"
        );
        assert!(msg.contains("'m'"), "error should name the m axis: {msg}");
        assert!(
            msg.contains("zero"),
            "error should call out the zero: {msg}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A zero chunk dimension sitting beyond the axes list's coverage (the
    /// axes and chunk_shape lengths disagree — doubly malformed metadata)
    /// still fails loudly, identifying the dimension by position instead of
    /// panicking on an out-of-bounds axis lookup.
    #[tokio::test]
    async fn source_image_with_zero_chunk_beyond_axes_fails() {
        let dir = temp_dir("import_source_zero_chunk_beyond_axes");
        create_6d_fixture_with_axes(&dir, &["y", "x"], &[16, 16, 4], &[16, 16, 0], None);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "szc-b", "Src Zero Chunk Beyond")
            .await
            .expect_err("a zero chunk dim must fail even with mismatched axes");
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(
            msg.contains("dimension 2"),
            "error should locate the zero by position: {msg}"
        );
        assert!(
            msg.contains("zero"),
            "error should call out the zero: {msg}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A zero chunk dimension on an axis whose metadata entry has no `"name"`
    /// must never be blamed on a named axis: `parse_multiscales` drops
    /// unnamed axes entries, so the names list (here t, z, y, x) is shifted
    /// relative to the raw chunk_shape, and a positional name lookup would
    /// pin the zero at index 1 on 'z' when it belongs to the anonymous second
    /// axis. The import still fails loudly, identifying the dimension by its
    /// position in chunk_shape instead.
    #[tokio::test]
    async fn source_image_with_zero_chunk_on_unnamed_axis_fails() {
        let dir = temp_dir("import_source_zero_chunk_unnamed_axis");
        create_fixture_with_axes_json(
            &dir,
            &[
                serde_json::json!({"name": "t", "type": "time"}),
                serde_json::json!({"type": "space"}), // no "name" key
                serde_json::json!({"name": "z", "type": "space"}),
                serde_json::json!({"name": "y", "type": "space"}),
                serde_json::json!({"name": "x", "type": "space"}),
            ],
            &[1, 4, 1, 64, 64],
            &[1, 0, 1, 64, 64],
            None,
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "szc-u", "Src Zero Chunk Unnamed")
            .await
            .expect_err("a zero chunk dim on an unnamed axis must fail the import");
        assert!(matches!(err, StoreError::Metadata(_)));
        let msg = err.to_string();
        assert!(
            msg.contains("dimension 1"),
            "error should locate the zero by position: {msg}"
        );
        assert!(
            !msg.contains("axis '"),
            "error must not blame a named axis when the names list is \
             misaligned with chunk_shape: {msg}"
        );
        assert!(
            msg.contains("zero"),
            "error should call out the zero: {msg}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A LABEL with a zero chunk dimension on a non-canonical (pinned) axis is
    /// skipped — never attached with an empty on-disk chunk byte layout — while
    /// the source image and well-formed sibling labels still import.
    #[tokio::test]
    async fn label_with_zero_chunk_on_pinned_axis_is_skipped() {
        let dir = temp_dir("import_label_zero_chunk_pinned");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["good", "zeropinned"]);
        write_label_multiscale(
            &dir,
            "good",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint16",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );
        // Zero chunk on the pinned `m` axis; every canonical dim is valid, so
        // a normalized-5D view of this chunk_shape would look fine.
        write_label_multiscale(
            &dir,
            "zeropinned",
            &["t", "z", "m", "y", "x"],
            &[1, 1, 6, 16, 16],
            &[1, 1, 0, 16, 16],
            &[1.0, 1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({"colors": []}),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "zcp", "Zero Chunk Pinned")
            .await
            .expect("a zero-chunk label must not fail the whole import");

        // Source image still imported.
        assert_eq!(result.manifest.images().len(), 1);
        // Only the well-formed label survives.
        let labels = result.manifest.labels();
        let names: Vec<&str> = labels.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["good"]);

        // No fetch or binding entries exist for the skipped label, so nothing
        // downstream can ever stream its (empty) chunks.
        if let FetchSource::Proxied(ref p) = result.fetch {
            assert_eq!(p.images.len(), 2, "source image + good label only");
            assert!(
                !p.images.iter().any(|i| i.image_id.0.contains("zeropinned")),
                "skipped label must not be streamable",
            );
        } else {
            panic!("expected Proxied fetch");
        }
        assert_eq!(result.binding_seed.images.len(), 2);
        assert!(
            !result
                .binding_seed
                .images
                .iter()
                .any(|b| b.image_id.0.contains("zeropinned")),
            "skipped label must not have a binding seed",
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
