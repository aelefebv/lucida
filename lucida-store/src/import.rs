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
    let levels = build_level_geometries(&level_entries, &level_metas, &axes_names);
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
        role: ImageRole::Intensity,
    };

    // Detect + parse any sibling `labels/` group. Label images share the base
    // image's owner and are appended AFTER it, in `labels` list order. A bad
    // label group is skipped inside the helper — the base image still imports.
    let labels = import_labels(store, id, "", &entity_id, &format!("{id}:label:")).await;

    let mut images = vec![image];
    images.extend(labels.images);

    let mut fetch_images = vec![ProxiedImageSpec {
        image_id: image_id.clone(),
        wire_format: WireFormat::Raw { data_type },
    }];
    fetch_images.extend(labels.fetch_images);

    let mut binding_images = vec![ImageBindingSeed {
        image_id,
        axes_names,
        store_prefix: None,
        levels: level_bindings,
    }];
    binding_images.extend(labels.binding_images);

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
        images,
        vec![source_layout],
        Some(default_layout_id),
    );

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
    let levels = build_level_geometries(&level_entries, &level_metas, &axes_names);
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

            images.push(ImageSpec {
                image_id: image_id.clone(),
                owner: field_entity_id.clone(),
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
                role: ImageRole::Intensity,
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

            // Per-FOV labels: `<well>/<field>/labels/...`. Only some FOVs may
            // have them. Label images share this FOV's field entity as owner and
            // are appended right after the FOV's intensity image. A bad label
            // group is skipped inside the helper without failing the plate.
            let fov_labels = import_labels(
                store,
                id,
                &fov.store_prefix,
                &field_entity_id,
                &format!("{id}:label:{}/", fov.store_prefix),
            )
            .await;
            images.extend(fov_labels.images);
            fetch_images.extend(fov_labels.fetch_images);
            binding_images.extend(fov_labels.binding_images);
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
    );

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

/// What the label-import helper appends to the manifest for one dataset (or one
/// FOV of a plate). Kept as three parallel `Vec`s so callers can extend their
/// existing image / fetch / binding lists in place, mirroring intensity images.
struct LabelImports {
    images: Vec<ImageSpec>,
    fetch_images: Vec<ProxiedImageSpec>,
    binding_images: Vec<ImageBindingSeed>,
}

/// Detect and parse the OME-NGFF `labels/` group that may sit beside an image
/// (a single image's root, or a plate FOV) and build a tagged label
/// [`ImageSpec`] + fetch + binding seed for each valid label group.
///
/// `base_prefix` is the store path of the owning image group: `""` for a single
/// image, `"<well>/<field>"` for a plate FOV. `owner` is the entity that owns
/// the source intensity image — label images share it so they live in the same
/// scene node. `id_prefix` is prepended to each label name to form the label
/// image id (`"<dataset>:label:"` single, `"<dataset>:label:<fov>/"` plate).
///
/// Failure isolation is total: a missing `labels/zarr.json` yields no labels;
/// a malformed *individual* group (no/!object `image-label`, empty/bad
/// multiscale, unsupported dtype/codec, oversized metadata) is skipped with an
/// `eprintln!` warning while the base image and every *other* valid group still
/// import. The open never fails because of a bad label group. This is
/// metadata-only — no label chunk bytes are ever fetched.
async fn import_labels(
    store: &Arc<dyn ObjectStore>,
    dataset_id: &str,
    base_prefix: &str,
    owner: &EntityId,
    id_prefix: &str,
) -> LabelImports {
    let mut out = LabelImports {
        images: Vec::new(),
        fetch_images: Vec::new(),
        binding_images: Vec::new(),
    };

    // `labels/` sits beside the image group. Compose paths without a leading
    // slash so single-image (`labels/...`) and plate (`<fov>/labels/...`) share
    // one code path.
    let labels_group_prefix = if base_prefix.is_empty() {
        "labels".to_string()
    } else {
        format!("{base_prefix}/labels")
    };
    let labels_json_path = format!("{labels_group_prefix}/zarr.json");

    // Absent `labels/zarr.json` → no labels (unchanged import). Any read/parse
    // error at the group level is also treated as "no labels" — we never fail
    // the dataset for a missing or unreadable labels group. The LIST group only
    // carries the array of names, so it stays TIGHTLY bounded (no truncation
    // retry): a pathological list is simply clipped.
    let labels_json =
        match parse::read_zarr_json_bounded(store, &labels_json_path, parse::MAX_LABEL_LIST_BYTES)
            .await
        {
            Ok(json) => json,
            Err(_) => return out,
        };

    // De-duplicate group names before building anything: two identical names
    // would mint two label `ImageSpec`s with the SAME `image_id` (and identical
    // fetch/binding), colliding downstream. Keep the first occurrence in list
    // order; drop later dups with a warning.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in parse::parse_labels_list(&labels_json) {
        if !seen.insert(name.clone()) {
            eprintln!(
                "[lucida-store] dataset {dataset_id:?}: duplicate label group name \
                 '{labels_group_prefix}/{name}' in labels list; keeping the first, \
                 skipping this one",
            );
            continue;
        }
        match import_one_label(
            store,
            dataset_id,
            &labels_group_prefix,
            &name,
            owner,
            id_prefix,
        )
        .await
        {
            Ok(built) => {
                out.images.push(built.image);
                out.fetch_images.push(built.fetch);
                out.binding_images.push(built.binding);
            }
            Err(msg) => {
                eprintln!(
                    "[lucida-store] dataset {dataset_id:?}: skipping label group \
                     '{labels_group_prefix}/{name}': {msg}",
                );
            }
        }
    }

    out
}

/// The three parallel artifacts for one successfully-parsed label group.
struct BuiltLabel {
    image: ImageSpec,
    fetch: ProxiedImageSpec,
    binding: ImageBindingSeed,
}

/// Parse a single label group at `<labels_group_prefix>/<name>` into a tagged
/// label [`ImageSpec`] plus its fetch/binding artifacts. Returns `Err(reason)`
/// for any malformed group so the caller can skip just this group; the reason
/// is surfaced in the warning. Reuses the exact intensity-image helpers so a
/// label's multiscale/codec/level handling is identical to an intensity image.
async fn import_one_label(
    store: &Arc<dyn ObjectStore>,
    dataset_id: &str,
    labels_group_prefix: &str,
    name: &str,
    owner: &EntityId,
    id_prefix: &str,
) -> Result<BuiltLabel, String> {
    let group_prefix = format!("{labels_group_prefix}/{name}");
    let group_json_path = format!("{group_prefix}/zarr.json");

    // Group metadata read is capped but truncation-aware: a legitimate large
    // segmentation (tens of thousands of per-value colors/properties) is KEPT
    // by retrying up to the hard ceiling; only genuinely oversized or malformed
    // metadata errors out and is skipped.
    let root_json = parse::read_zarr_json_capped(
        store,
        &group_json_path,
        parse::LABEL_METADATA_INITIAL_BYTES,
        parse::MAX_LABEL_METADATA_BYTES,
    )
    .await
    .map_err(|e| e.to_string())?;

    // A group under `labels/` is only a label if it carries `image-label`.
    // Absent/!object → not a label; skip. Everything inside is untrusted. The
    // group name rides onto `LabelMeta.name`.
    let label_meta = parse::parse_image_label(&root_json, name)
        .ok_or("missing or non-object image-label block")?;

    // Multiscale is parsed with the SAME helper as intensity images. A label
    // typically has no channel axis (t,z,y,x) — classify_axes/normalize handle
    // that identically to any other axis set.
    let parsed = parse::parse_multiscales(&root_json, &format!("{group_prefix}: "))
        .map_err(|e| e.to_string())?;
    let axes_names = parsed.axes_names;
    let level_entries = parsed.level_entries;

    // Level metadata is on the untrusted label path, so read each level's
    // `zarr.json` with the same capped/truncation-aware helper as the group.
    let level_metas = read_label_level_metas(store, &group_prefix, &level_entries)
        .await
        .map_err(|e| e.to_string())?;

    // Guard silent geometry corruption: `normalize_to_5d` maps on-disk dims to
    // canonical positions by axis NAME/order and ignores any extra/missing
    // dims, so a `shape` whose rank disagrees with the declared `axes` would be
    // attached with mis-mapped geometry. `chunk_shape` rank is already checked
    // (in `compute_chunk_byte_layout`); apply the SAME check to `shape` and
    // skip the whole group on mismatch rather than attach wrong geometry.
    for (i, meta) in level_metas.iter().enumerate() {
        if meta.shape.len() != axes_names.len() {
            return Err(format!(
                "level {i}: shape rank {} != axes rank {} (axes: {:?})",
                meta.shape.len(),
                axes_names.len(),
                axes_names,
            ));
        }
    }

    // Validate the dtype against the shared allow-list; unsupported → skip.
    let data_type = parse_data_type(&level_metas[0].data_type).map_err(|e| e.to_string())?;
    let layout = classify_axes(&axes_names, &level_metas[0].shape);
    warn_pinned_axes(dataset_id, &layout.pinned);
    let axes = build_axes(&layout.canonical_names);
    let levels = build_level_geometries(&level_entries, &level_metas, &axes_names);
    let coarse_level_index =
        select_source_coarse_level(&levels, data_type, SourceCoarseConfig::default());
    // Validates the codec chain against the shared allow-list; unsupported → skip.
    let level_bindings = build_level_binding_infos(
        &axes_names,
        &level_metas,
        data_type_size(data_type),
        &layout.pinned,
    )
    .map_err(|e| e.to_string())?;

    let image_id = ImageId(format!("{id_prefix}{name}"));

    let image = ImageSpec {
        image_id: image_id.clone(),
        owner: owner.clone(),
        multiscale: MultiscaleInfo {
            axes,
            levels,
            coarse_level_index,
            generated_levels: Vec::new(),
            data_type,
            pinned_axes: layout.pinned.clone(),
            // Labels are segmentation masks; they carry no omero channel display
            // metadata (and typically no channel axis at all).
            channel_infos: Vec::new(),
        },
        role: ImageRole::Label(label_meta),
    };

    let fetch = ProxiedImageSpec {
        image_id: image_id.clone(),
        wire_format: WireFormat::Raw { data_type },
    };

    let binding = ImageBindingSeed {
        image_id,
        axes_names,
        store_prefix: Some(group_prefix),
        levels: level_bindings,
    };

    Ok(BuiltLabel {
        image,
        fetch,
        binding,
    })
}

/// Read the per-level [`parse::ArrayMeta`] for a label group, capping each
/// level's `zarr.json` read the same truncation-aware way as the group read.
///
/// This is the untrusted-path analogue of [`parse::read_level_metas`] (which
/// reads unbounded and is used only for trusted intensity images). A legitimate
/// large array `zarr.json` is KEPT via the truncation retry; oversized or
/// malformed level metadata errors, and the caller skips the whole group.
async fn read_label_level_metas(
    store: &Arc<dyn ObjectStore>,
    base_prefix: &str,
    level_entries: &[parse::LevelEntry],
) -> Result<Vec<parse::ArrayMeta>, StoreError> {
    let mut level_metas: Vec<parse::ArrayMeta> = Vec::with_capacity(level_entries.len());
    for entry in level_entries {
        let level_path = if base_prefix.is_empty() {
            format!("{}/zarr.json", entry.path)
        } else {
            format!("{base_prefix}/{}/zarr.json", entry.path)
        };
        let value = parse::read_zarr_json_capped(
            store,
            &level_path,
            parse::LABEL_METADATA_INITIAL_BYTES,
            parse::MAX_LABEL_METADATA_BYTES,
        )
        .await?;
        let meta: parse::ArrayMeta = serde_json::from_value(value)
            .map_err(|e| StoreError::Metadata(format!("{level_path}: {e}")))?;
        level_metas.push(meta);
    }
    Ok(level_metas)
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

fn build_level_geometries(
    level_entries: &[parse::LevelEntry],
    level_metas: &[parse::ArrayMeta],
    axes_names: &[String],
) -> Vec<LevelGeometry> {
    level_entries
        .iter()
        .zip(level_metas.iter())
        .enumerate()
        .map(|(i, (entry, meta))| {
            let shape = normalize_to_5d(&meta.shape, axes_names, 1);
            let chunk_shape =
                normalize_to_5d(&meta.chunk_grid.configuration.chunk_shape, axes_names, 1);
            let grid_shape = std::array::from_fn(|d| shape[d].div_ceil(chunk_shape[d]));
            LevelGeometry {
                level_index: i as u32,
                shape,
                chunk_shape,
                grid_shape,
                scale: entry.scale,
            }
        })
        .collect()
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
        fs::create_dir_all(dir).unwrap();

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

        let scale: Vec<f64> = vec![1.0; axes.len()];
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

    // --- Label import (OME-NGFF v0.5 `labels/` group) -------------------

    /// Write a `labels/zarr.json` group listing `names` under `<base>/labels`.
    /// `base` is the image group dir (the fixture root for single images, or a
    /// FOV dir for plates).
    fn write_labels_index(base: &std::path::Path, names: &[&str]) {
        let labels_dir = base.join("labels");
        fs::create_dir_all(&labels_dir).unwrap();
        let names_json: Vec<serde_json::Value> =
            names.iter().map(|n| serde_json::json!(n)).collect();
        let group = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "labels": names_json } }
        });
        fs::write(
            labels_dir.join("zarr.json"),
            serde_json::to_string_pretty(&group).unwrap(),
        )
        .unwrap();
    }

    /// Write one label group `<base>/labels/<name>` with a single-level
    /// multiscale (axes t,z,y,x — no channel, as labels typically have) and a
    /// uint32 array. `image_label` is spliced verbatim into
    /// `attributes.ome.image-label` when `Some`; when `None`, NO `image-label`
    /// block is written (mimicking a non-label group under `labels/`).
    /// `data_type`/`codecs` default to a valid uint32 raw array unless
    /// overridden, so tests can exercise the unsupported-dtype / bad-codec
    /// skip paths.
    fn write_label_group(
        base: &std::path::Path,
        name: &str,
        image_label: Option<serde_json::Value>,
        data_type: &str,
        codecs: serde_json::Value,
    ) {
        let group_dir = base.join("labels").join(name);
        fs::create_dir_all(&group_dir).unwrap();

        let mut ome = serde_json::json!({
            "version": "0.5",
            "multiscales": [{
                "version": "0.5",
                "name": name,
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"}
                ],
                "datasets": [{
                    "path": "0",
                    "coordinateTransformations": [{
                        "type": "scale",
                        "scale": [1.0, 1.0, 1.0, 1.0]
                    }]
                }]
            }]
        });
        if let Some(il) = image_label {
            ome["image-label"] = il;
        }

        let group_root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": ome }
        });
        fs::write(
            group_dir.join("zarr.json"),
            serde_json::to_string_pretty(&group_root).unwrap(),
        )
        .unwrap();

        let level_dir = group_dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [1, 1, 64, 64],
            "data_type": data_type,
            "chunk_grid": {
                "name": "regular",
                "configuration": { "chunk_shape": [1, 1, 64, 64] }
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

    /// The default valid label array codec chain: raw little-endian bytes.
    fn raw_codecs() -> serde_json::Value {
        serde_json::json!([{"name": "bytes", "configuration": {"endian": "little"}}])
    }

    /// A well-formed `image-label` block with one color, one property, and a
    /// source image reference.
    fn sample_image_label() -> serde_json::Value {
        serde_json::json!({
            "version": "0.5",
            "colors": [{"label-value": 1, "rgba": [255, 0, 0, 255]}],
            "properties": [{"label-value": 1, "area": 512}],
            "source": {"image": "../../"}
        })
    }

    /// A single image with a `labels/` group attaches each label as a tagged
    /// label image: appended AFTER the base image, sharing its owner, carrying
    /// the parsed `LabelMeta`, with a matching fetch spec and a binding seed
    /// whose store_prefix points under `labels/<name>`.
    #[tokio::test]
    async fn import_single_image_attaches_labels() {
        let dir = temp_dir("import_labels_single");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["nuclei", "cells"]);
        write_label_group(
            &dir,
            "nuclei",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );
        write_label_group(
            &dir,
            "cells",
            Some(serde_json::json!({"version": "0.5"})),
            "uint32",
            raw_codecs(),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "lbl", "Labeled").await.unwrap();

        let images = result.manifest.images();
        // Base image first, then labels in list order.
        assert_eq!(images.len(), 3);
        assert!(!images[0].is_label(), "base image must stay intensity");
        assert!(images[1].is_label());
        assert!(images[2].is_label());
        assert_eq!(images[1].image_id, ImageId("lbl:label:nuclei".into()));
        assert_eq!(images[2].image_id, ImageId("lbl:label:cells".into()));

        // Labels share the base image's owner entity.
        assert_eq!(images[1].owner, images[0].owner);
        assert_eq!(images[2].owner, images[0].owner);

        // The parsed LabelMeta rides along on the role.
        match &images[1].role {
            ImageRole::Label(meta) => {
                assert_eq!(meta.colors.len(), 1);
                assert_eq!(meta.colors[0].value, 1);
                assert_eq!(meta.colors[0].rgba, [255, 0, 0, 255]);
                assert_eq!(meta.properties.len(), 1);
                assert_eq!(meta.properties[0].value, 1);
                assert_eq!(meta.source_image.as_deref(), Some("../../"));
            }
            ImageRole::Intensity => panic!("expected Label role on nuclei"),
        }

        // Label multiscale mirrors the on-disk t,z,y,x axes and uint32 dtype.
        assert_eq!(images[1].multiscale.data_type, DataType::Uint32);
        let axis_names: Vec<&str> = images[1]
            .multiscale
            .axes
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert_eq!(axis_names, vec!["t", "z", "y", "x"]);

        // Fetch + binding gained one entry per label, in the same order.
        if let FetchSource::Proxied(ref proxied) = result.fetch {
            assert_eq!(proxied.images.len(), 3);
            assert_eq!(
                proxied.images[1].image_id,
                ImageId("lbl:label:nuclei".into())
            );
            assert!(matches!(
                proxied.images[1].wire_format,
                WireFormat::Raw {
                    data_type: DataType::Uint32
                }
            ));
        } else {
            panic!("expected Proxied fetch");
        }

        assert_eq!(result.binding_seed.images.len(), 3);
        assert_eq!(
            result.binding_seed.images[1].store_prefix.as_deref(),
            Some("labels/nuclei"),
        );
        assert_eq!(
            result.binding_seed.images[2].store_prefix.as_deref(),
            Some("labels/cells"),
        );
        // Metadata-only: one level binding, no chunk bytes were read.
        assert_eq!(result.binding_seed.images[1].levels.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A dataset with NO `labels/` group imports exactly as before: one image,
    /// intensity, no extra fetch/binding entries.
    #[tokio::test]
    async fn import_single_image_without_labels_is_unchanged() {
        let dir = temp_dir("import_no_labels");
        create_single_image_fixture(&dir, None);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "plain", "Plain").await.unwrap();

        assert_eq!(result.manifest.images().len(), 1);
        assert!(!result.manifest.images()[0].is_label());
        if let FetchSource::Proxied(ref proxied) = result.fetch {
            assert_eq!(proxied.images.len(), 1);
        } else {
            panic!("expected Proxied fetch");
        }
        assert_eq!(result.binding_seed.images.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A malformed label group is skipped without failing the open, and the
    /// base image plus every OTHER valid label group still import. Covers each
    /// distinct failure mode: no `image-label`, unsupported dtype, and a bad
    /// codec chain.
    #[tokio::test]
    async fn import_skips_malformed_label_groups_without_failing() {
        let dir = temp_dir("import_labels_malformed");
        create_single_image_fixture(&dir, None);
        write_labels_index(
            &dir,
            &["good", "not_a_label", "bad_dtype", "bad_codec", "also_good"],
        );
        // Valid.
        write_label_group(
            &dir,
            "good",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );
        // Missing image-label block → not a label → skipped.
        write_label_group(&dir, "not_a_label", None, "uint32", raw_codecs());
        // Unsupported dtype (not in the allow-list) → skipped.
        write_label_group(
            &dir,
            "bad_dtype",
            Some(sample_image_label()),
            "complex128",
            raw_codecs(),
        );
        // Bad codec (big-endian bytes) → skipped.
        write_label_group(
            &dir,
            "bad_codec",
            Some(sample_image_label()),
            "uint32",
            serde_json::json!([{"name": "bytes", "configuration": {"endian": "big"}}]),
        );
        // Valid again → proves iteration continues past the bad ones.
        write_label_group(
            &dir,
            "also_good",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "mix", "Mixed")
            .await
            .expect("a bad label group must never fail the open");

        let images = result.manifest.images();
        // Base + the two valid labels only.
        assert_eq!(images.len(), 3);
        assert!(!images[0].is_label());
        let label_ids: Vec<&str> = images[1..].iter().map(|i| i.image_id.0.as_str()).collect();
        assert_eq!(label_ids, vec!["mix:label:good", "mix:label:also_good"]);

        // Fetch/binding stay in lockstep with the images.
        assert_eq!(result.binding_seed.images.len(), 3);

        let _ = fs::remove_dir_all(&dir);
    }

    /// An empty / non-array `labels` list means no labels, and the import is
    /// unchanged (the presence of an empty `labels/zarr.json` alone must not
    /// add or fail anything).
    #[tokio::test]
    async fn import_empty_labels_list_adds_nothing() {
        let dir = temp_dir("import_labels_empty");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &[]);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "empty", "Empty").await.unwrap();

        assert_eq!(result.manifest.images().len(), 1);
        assert!(!result.manifest.images()[0].is_label());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A plate carries labels PER FOV under `<well>/<field>/labels/...`, and
    /// only some FOVs have them. Each label attaches to its own field entity
    /// with a FOV-scoped id and store prefix; FOVs without labels are
    /// unchanged, and a bad group on one FOV doesn't disturb the others.
    #[tokio::test]
    async fn import_plate_attaches_per_fov_labels() {
        let dir = temp_dir("import_labels_plate");
        create_plate_fixture(
            &dir,
            "labeled_plate",
            &["A"],
            &["1"],
            &[("A", "1", 0, 0, 2)],
            [1, 1, 10, 256, 256],
            [1, 1, 1, 128, 128],
            1,
        );

        // FOV A/1/0 has a valid label; FOV A/1/1 has none.
        let fov0 = dir.join("A").join("1").join("0");
        write_labels_index(&fov0, &["nuclei"]);
        write_label_group(
            &fov0,
            "nuclei",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "plate", "Plate").await.unwrap();

        let images = result.manifest.images();
        // 2 intensity FOVs + 1 label on FOV 0.
        let labels: Vec<&ImageSpec> = images.iter().filter(|i| i.is_label()).collect();
        assert_eq!(labels.len(), 1);
        assert_eq!(
            labels[0].image_id,
            ImageId("plate:label:A/1/0/nuclei".into()),
        );

        // The label's owner is the FOV-0 field entity (the same owner as the
        // FOV-0 intensity image).
        let fov0_intensity = images
            .iter()
            .find(|i| i.image_id == ImageId("plate:image:A/1/0".into()))
            .expect("FOV 0 intensity image");
        assert_eq!(labels[0].owner, fov0_intensity.owner);

        // Binding prefix is FOV-scoped.
        let label_binding = result
            .binding_seed
            .images
            .iter()
            .find(|b| b.image_id == ImageId("plate:label:A/1/0/nuclei".into()))
            .expect("label binding seed");
        assert_eq!(
            label_binding.store_prefix.as_deref(),
            Some("A/1/0/labels/nuclei")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Write a label group `<base>/labels/<name>` whose `image-label.colors`
    /// array has `n_colors` entries, serialized COMPACTLY so the on-disk
    /// `zarr.json` size is predictable. Used to build a legitimately large
    /// segmentation sidecar (bigger than the initial read cap, under the hard
    /// ceiling, with more colors than the per-group entry cap). The array is a
    /// valid single-level uint32 t,z,y,x group like [`write_label_group`].
    fn write_label_group_with_n_colors(base: &std::path::Path, name: &str, n_colors: usize) {
        let group_dir = base.join("labels").join(name);
        fs::create_dir_all(&group_dir).unwrap();

        let colors: Vec<serde_json::Value> = (0..n_colors)
            .map(|i| serde_json::json!({"label-value": i as u64, "rgba": [1, 2, 3, 4]}))
            .collect();

        let ome = serde_json::json!({
            "version": "0.5",
            "image-label": { "version": "0.5", "colors": colors },
            "multiscales": [{
                "version": "0.5",
                "name": name,
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"}
                ],
                "datasets": [{
                    "path": "0",
                    "coordinateTransformations": [{
                        "type": "scale",
                        "scale": [1.0, 1.0, 1.0, 1.0]
                    }]
                }]
            }]
        });
        let group_root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": ome }
        });
        // Compact (not pretty) so size ≈ n_colors * ~43 bytes — predictable.
        fs::write(
            group_dir.join("zarr.json"),
            serde_json::to_string(&group_root).unwrap(),
        )
        .unwrap();

        let level_dir = group_dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [1, 1, 64, 64],
            "data_type": "uint32",
            "chunk_grid": {
                "name": "regular",
                "configuration": { "chunk_shape": [1, 1, 64, 64] }
            },
            "codecs": raw_codecs(),
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// A LARGE but VALID label group is KEPT (not skipped): its group
    /// `zarr.json` is bigger than the initial read cap, so a naive bounded read
    /// would truncate and drop it, but the truncation-aware retry reads it in
    /// full (still under the hard ceiling). Colors are length-capped at
    /// [`parse::MAX_LABEL_ENTRIES`] rather than the whole group being lost.
    #[tokio::test]
    async fn import_keeps_large_valid_label_with_capped_colors() {
        let dir = temp_dir("import_labels_large_valid");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["cells"]);

        // Enough colors that the COMPACT group zarr.json exceeds the initial
        // read cap (≈43 bytes/entry) yet stays far under the hard ceiling, and
        // the count itself is well past the per-group entry cap.
        let n_colors =
            (parse::LABEL_METADATA_INITIAL_BYTES as usize / 40) + parse::MAX_LABEL_ENTRIES + 1;
        write_label_group_with_n_colors(&dir, "cells", n_colors);

        // Sanity: the fixture really did exceed the initial cap (otherwise the
        // test wouldn't exercise the retry path it's meant to guard).
        let group_json = dir.join("labels").join("cells").join("zarr.json");
        let on_disk = fs::metadata(&group_json).unwrap().len();
        assert!(
            on_disk > parse::LABEL_METADATA_INITIAL_BYTES,
            "fixture must exceed the initial read cap to exercise the retry; got {on_disk} bytes",
        );
        assert!(
            on_disk < parse::MAX_LABEL_METADATA_BYTES,
            "fixture must stay under the hard ceiling; got {on_disk} bytes",
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "big", "Big")
            .await
            .expect("a large VALID label must not fail the open");

        // The label is KEPT (base + label), not dropped.
        let images = result.manifest.images();
        assert_eq!(
            images.len(),
            2,
            "large valid label must be kept, not skipped"
        );
        assert!(images[1].is_label());
        match &images[1].role {
            ImageRole::Label(meta) => {
                assert_eq!(meta.name, "cells");
                // Colors are length-capped, not truncated-to-parse-failure.
                assert_eq!(meta.colors.len(), parse::MAX_LABEL_ENTRIES);
            }
            ImageRole::Intensity => panic!("expected Label role"),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// A label group whose array `shape` rank disagrees with its declared
    /// `axes` rank is SKIPPED with a warning (never attached with silently
    /// position-mapped geometry), while the base image and other valid groups
    /// still import.
    #[tokio::test]
    async fn import_skips_label_with_shape_rank_mismatch() {
        let dir = temp_dir("import_labels_rank_mismatch");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["bad_rank", "good"]);

        // 4 declared axes (t,z,y,x) but a 3-element shape/chunk → rank mismatch.
        let group_dir = dir.join("labels").join("bad_rank");
        fs::create_dir_all(&group_dir).unwrap();
        let ome = serde_json::json!({
            "version": "0.5",
            "image-label": {"version": "0.5"},
            "multiscales": [{
                "version": "0.5",
                "name": "bad_rank",
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"}
                ],
                "datasets": [{
                    "path": "0",
                    "coordinateTransformations": [{"type": "scale", "scale": [1.0, 1.0, 1.0, 1.0]}]
                }]
            }]
        });
        fs::write(
            group_dir.join("zarr.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "zarr_format": 3, "node_type": "group", "attributes": {"ome": ome}
            }))
            .unwrap(),
        )
        .unwrap();
        let level_dir = group_dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        // `chunk_shape` rank MATCHES the 4 axes (so the pre-existing chunk-rank
        // check passes) but `shape` rank is 3 — isolating the NEW shape-rank
        // check as the sole reason this group is skipped.
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "zarr_format": 3,
                "node_type": "array",
                "shape": [64, 64, 64],
                "data_type": "uint32",
                "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 64, 64]}},
                "codecs": raw_codecs(),
                "fill_value": 0
            }))
            .unwrap(),
        )
        .unwrap();

        // A well-formed 4D group proves iteration continues past the bad one.
        write_label_group(
            &dir,
            "good",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "rank", "Rank")
            .await
            .expect("a rank-mismatched label must not fail the open");

        let images = result.manifest.images();
        // Base + the single well-formed label; the mismatched one was skipped.
        assert_eq!(images.len(), 2);
        let label_ids: Vec<&str> = images[1..].iter().map(|i| i.image_id.0.as_str()).collect();
        assert_eq!(label_ids, vec!["rank:label:good"]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A `labels` list with a duplicate name must not mint two label
    /// `ImageSpec`s with the same `image_id`: the first occurrence wins and the
    /// later dup is dropped, so ids never collide.
    #[tokio::test]
    async fn import_dedups_duplicate_label_names() {
        let dir = temp_dir("import_labels_dedup");
        create_single_image_fixture(&dir, None);
        // "nuclei" listed twice, plus a distinct "cells".
        write_labels_index(&dir, &["nuclei", "nuclei", "cells"]);
        write_label_group(
            &dir,
            "nuclei",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );
        write_label_group(
            &dir,
            "cells",
            Some(sample_image_label()),
            "uint32",
            raw_codecs(),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "dup", "Dup").await.unwrap();

        let images = result.manifest.images();
        // Base + exactly one "nuclei" + one "cells" — no duplicate id.
        assert_eq!(images.len(), 3);
        let label_ids: Vec<&str> = images[1..].iter().map(|i| i.image_id.0.as_str()).collect();
        assert_eq!(label_ids, vec!["dup:label:nuclei", "dup:label:cells"]);

        // Ids are unique across ALL images (the collision this guards against).
        let mut all_ids: Vec<&str> = images.iter().map(|i| i.image_id.0.as_str()).collect();
        let before = all_ids.len();
        all_ids.sort_unstable();
        all_ids.dedup();
        assert_eq!(all_ids.len(), before, "label image_ids must not collide");

        // Fetch + binding stay in lockstep (also de-duplicated).
        assert_eq!(result.binding_seed.images.len(), 3);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Directly exercise the capped/truncation-aware reader with SMALL caps so
    /// the three byte-size regimes are covered cheaply (no multi-MiB fixtures):
    /// a small object is returned whole; a large-but-valid object (over the
    /// initial cap, under the ceiling) is read in full via the retry; an object
    /// over the ceiling errors so the caller skips it.
    #[tokio::test]
    async fn read_zarr_json_capped_keeps_large_valid_and_rejects_over_ceiling() {
        let dir = temp_dir("read_capped");
        fs::create_dir_all(&dir).unwrap();
        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();

        // Helper: write a valid JSON object padded so its serialized length is
        // AT LEAST `target` bytes, via a filler string key.
        let write_sized = |rel: &str, target: usize| {
            let mut v = serde_json::json!({"ok": true, "pad": ""});
            let base = serde_json::to_string(&v).unwrap().len();
            let fill = target.saturating_sub(base);
            v["pad"] = serde_json::json!("z".repeat(fill));
            let s = serde_json::to_string(&v).unwrap();
            assert!(s.len() >= target);
            fs::write(dir.join(rel), s).unwrap();
        };

        let initial = 4096u64;
        let ceiling = 16384u64;

        // 1) Small object (< initial): returned whole.
        write_sized("small.json", 100);
        let v = parse::read_zarr_json_capped(&store, "small.json", initial, ceiling)
            .await
            .expect("small object parses");
        assert_eq!(v["ok"], serde_json::json!(true));

        // 2) Large-but-valid (> initial, < ceiling): retry reads it in full.
        write_sized("mid.json", 8000);
        let v = parse::read_zarr_json_capped(&store, "mid.json", initial, ceiling)
            .await
            .expect("large-but-valid object is kept via the retry");
        assert_eq!(v["ok"], serde_json::json!(true));

        // 3) Over the ceiling: errors, so the caller skips the group.
        write_sized("huge.json", (ceiling as usize) + 4096);
        let err = parse::read_zarr_json_capped(&store, "huge.json", initial, ceiling)
            .await
            .expect_err("over-ceiling metadata must error");
        assert!(
            matches!(err, StoreError::Metadata(_)),
            "expected a Metadata error, got {err:?}",
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
