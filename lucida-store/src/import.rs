//! Dataset import pipeline.
//!
//! Reads OME-Zarr metadata and produces a three-part [`ImportResult`] containing
//! a [`DatasetManifest`], [`FetchSource`], and [`ServerBindingSeed`].

use std::sync::Arc;

use futures_util::stream::StreamExt;
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
/// Detects whether the root describes a collection or a single image and
/// produces the appropriate [`ImportResult`].
pub async fn import_dataset(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
) -> Result<ImportResult, StoreError> {
    let root_json = parse::read_zarr_json(store, "zarr.json").await?;

    if root_json.pointer("/attributes/ome/plate").is_some() {
        import_collection(store, id, name, &root_json).await
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
        warnings: Vec::new(),
    })
}

/// Maximum number of metadata object-store GETs kept in flight while importing
/// a collection. Bounds fan-out so a wide collection opens quickly without self-throttling
/// the backing store.
const METADATA_FETCH_CONCURRENCY: usize = 32;

/// One group's parsed metadata: its collection path, grid coordinates, and the tiles
/// it declares. Produced concurrently, then assembled in declared order.
struct GroupParsed {
    path: String,
    row_index: u32,
    column_index: u32,
    tiles: Vec<TileParsed>,
}

/// One tile within a group: its store prefix and any stage translation.
struct TileParsed {
    store_prefix: String,
    translation: Option<Vec<f64>>,
}

/// The collection path used to name a group in warnings and diagnostics. Prefers the
/// declared `path`; falls back to the row/column labels (then indices) when the
/// entry omits it, so a skipped group is still identifiable.
fn group_collection_path(
    path: Option<&str>,
    row_index: u32,
    column_index: u32,
    rows: &[String],
    columns: &[String],
) -> String {
    if let Some(path) = path {
        return path.to_string();
    }
    let row = rows
        .get(row_index as usize)
        .cloned()
        .unwrap_or_else(|| row_index.to_string());
    let column = columns
        .get(column_index as usize)
        .cloned()
        .unwrap_or_else(|| column_index.to_string());
    format!("{row}/{column}")
}

fn skipped_group_warning(target: &str, reason: String) -> ImportWarning {
    ImportWarning {
        kind: ImportWarningKind::SkippedGroup,
        target: target.to_string(),
        message: format!("skipped group {target:?}: {reason}"),
    }
}

/// Fetch and parse a single group's `zarr.json`, extracting its tiles.
///
/// Tolerant by design: a missing collection `path`, an unreadable or malformed
/// `zarr.json`, or a missing `ome.well.images` list yields a [`ImportWarning`]
/// the caller records and skips, rather than aborting the whole collection. Only the
/// object-store GET is awaited here so callers can fan many groups out at once.
/// `target` is the group's collection path used in any warning, computed by the caller
/// so this future owns all of its inputs.
async fn parse_one_group(
    store: Arc<dyn ObjectStore>,
    path: Option<String>,
    row_index: u32,
    column_index: u32,
    target: String,
) -> Result<GroupParsed, ImportWarning> {
    let Some(group_path) = path else {
        return Err(skipped_group_warning(
            &target,
            "collection entry is missing 'path'".to_string(),
        ));
    };

    let group_meta_path = Path::from(format!("{group_path}/zarr.json"));
    let group_bytes = match store.get(&group_meta_path).await {
        Ok(response) => match response.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => {
                return Err(skipped_group_warning(
                    &target,
                    format!("group metadata is unreadable: {e}"),
                ));
            }
        },
        Err(e) => {
            return Err(skipped_group_warning(
                &target,
                format!("group metadata is unreadable: {e}"),
            ));
        }
    };

    let group_json: serde_json::Value = match serde_json::from_slice(&group_bytes) {
        Ok(value) => value,
        Err(e) => {
            return Err(skipped_group_warning(
                &target,
                format!("group metadata is not valid JSON: {e}"),
            ));
        }
    };

    let Some(images) = group_json
        .pointer("/attributes/ome/well/images")
        .and_then(|v| v.as_array())
    else {
        return Err(skipped_group_warning(
            &target,
            "group metadata has no ome.well.images list".to_string(),
        ));
    };

    let mut tiles: Vec<TileParsed> = Vec::new();
    for image_entry in images {
        let tile_path = image_entry
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("0")
            .to_string();
        let store_prefix = format!("{group_path}/{tile_path}");

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

        tiles.push(TileParsed {
            store_prefix,
            translation,
        });
    }

    Ok(GroupParsed {
        path: group_path,
        row_index,
        column_index,
        tiles,
    })
}

async fn import_collection(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
    root_json: &serde_json::Value,
) -> Result<ImportResult, StoreError> {
    let collection_json = root_json
        .pointer("/attributes/ome/plate")
        .ok_or_else(|| StoreError::Metadata("no ome.plate in root zarr.json".into()))?;

    // Parse rows and columns.
    let rows: Vec<String> = collection_json
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let columns: Vec<String> = collection_json
        .get("columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let groups_json = collection_json
        .get("wells")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata("collection has no groups array".into()))?;

    // Fetch every group's `zarr.json` with bounded concurrency, keyed by its
    // declared position, then re-order the results so downstream assembly runs
    // in declared group order regardless of completion order.
    let group_outcomes: Vec<Result<GroupParsed, ImportWarning>> = {
        // Extract each group's declared tiles (owned) up front so the concurrent
        // futures borrow nothing from the collection JSON, rows, or columns.
        struct GroupRequest {
            path: Option<String>,
            row_index: u32,
            column_index: u32,
            target: String,
        }
        let requests: Vec<GroupRequest> = groups_json
            .iter()
            .map(|group_entry| {
                let path = group_entry
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let row_index = group_entry
                    .get("rowIndex")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let column_index = group_entry
                    .get("columnIndex")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let target = group_collection_path(
                    path.as_deref(),
                    row_index,
                    column_index,
                    &rows,
                    &columns,
                );
                GroupRequest {
                    path,
                    row_index,
                    column_index,
                    target,
                }
            })
            .collect();

        let mut slots: Vec<Option<Result<GroupParsed, ImportWarning>>> =
            (0..requests.len()).map(|_| None).collect();
        let mut stream =
            futures_util::stream::iter(requests.into_iter().enumerate().map(|(index, req)| {
                let store = store.clone();
                async move {
                    let outcome = parse_one_group(
                        store,
                        req.path,
                        req.row_index,
                        req.column_index,
                        req.target,
                    )
                    .await;
                    (index, outcome)
                }
            }))
            .buffer_unordered(METADATA_FETCH_CONCURRENCY);
        while let Some((index, outcome)) = stream.next().await {
            slots[index] = Some(outcome);
        }
        slots
            .into_iter()
            .map(|slot| slot.expect("every group index is filled by the fetch loop"))
            .collect()
    };

    // Assemble in declared order: survivors keep their declared sequence and
    // skipped groups become warnings (never a hard failure while any group
    // parses), so representative-tile selection and ordering are computed over
    // the survivors exactly as the sequential importer would.
    let mut parsed_groups: Vec<GroupParsed> = Vec::new();
    let mut warnings: Vec<ImportWarning> = Vec::new();
    for outcome in group_outcomes {
        match outcome {
            Ok(group) => parsed_groups.push(group),
            Err(warning) => warnings.push(warning),
        }
    }

    if parsed_groups.is_empty() {
        return Err(StoreError::Metadata(
            "collection has no readable groups".into(),
        ));
    }

    let mut representative_tile_path: Option<String> = None;
    let mut has_explicit_positions = false;
    for group in &parsed_groups {
        for tile in &group.tiles {
            if tile.translation.is_some() {
                has_explicit_positions = true;
            }
            if representative_tile_path.is_none() {
                representative_tile_path = Some(tile.store_prefix.clone());
            }
        }
    }

    // Read representative tile multiscales.
    let rep_path = representative_tile_path
        .ok_or_else(|| StoreError::Metadata("collection has no tiles".into()))?;

    let rep_json = parse::read_zarr_json(store, &format!("{rep_path}/zarr.json")).await?;
    let rep_parsed = parse::parse_multiscales(&rep_json, &format!("{rep_path}: "))?;
    let axes_names = rep_parsed.axes_names;
    let level_entries = rep_parsed.level_entries;

    // Channel display names from the representative tile's omero block. OME-Zarr
    // collections require all tiles to share one multiscale, so the representative
    // tile's channels apply to every tile (generic; optional).
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

    let positioning_mode = if has_explicit_positions {
        PositioningMode::Explicit
    } else {
        PositioningMode::Derived
    };

    // For stage-positioned collections, OME-Zarr translations are in physical units
    // (e.g., microns), but the rest of lucida composes them with voxel-unit
    // group placements. Convert translations to voxel units here using the
    // level-0 scale. Defensive: a missing or invalid scale falls back to 1.0
    // (pass-through) and emits a single warning per dataset.
    let (scale_x, scale_y) = {
        let raw_x = levels[0].scale[4];
        let raw_y = levels[0].scale[3];
        let valid = |s: f64| s.is_finite() && s != 0.0;
        let sx = if valid(raw_x) { raw_x } else { 1.0 };
        let sy = if valid(raw_y) { raw_y } else { 1.0 };
        if has_explicit_positions && (!valid(raw_x) || !valid(raw_y)) {
            eprintln!(
                "[lucida-store] dataset {id:?} has missing or invalid voxel \
                 scale (scale_x={raw_x}, scale_y={raw_y}); stage translations \
                 are passed through unchanged",
            );
        }
        (sx, sy)
    };

    // Determine row/column labels for each group from row_index/column_index.
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
    // Label overlays discovered per-tile, flattened across the whole collection.
    // The budget is shared across tiles so aggregate label/color memory is
    // bounded no matter how many tiles carry labels.
    let mut label_specs: Vec<LabelSpec> = Vec::new();
    let mut label_budget = LabelBudget::new();

    // Probe every tile's `labels/` group index with bounded concurrency — the
    // only per-tile label I/O safe to fan out, since it reads one small index
    // object and holds only names, never built specs — keyed by declared tile
    // order.
    let tile_prefixes: Vec<String> = parsed_groups
        .iter()
        .flat_map(|group| group.tiles.iter().map(|tile| tile.store_prefix.clone()))
        .collect();
    let mut probed_labels: Vec<Option<ProbedLabels>> =
        (0..tile_prefixes.len()).map(|_| None).collect();
    let mut probe_stream =
        futures_util::stream::iter(tile_prefixes.iter().cloned().enumerate().map(
            |(index, prefix)| {
                let store = store.clone();
                async move {
                    let probed = probe_labels_for_image(&store, &prefix).await;
                    (index, probed)
                }
            },
        ))
        .buffer_unordered(METADATA_FETCH_CONCURRENCY);
    while let Some((index, probed)) = probe_stream.next().await {
        probed_labels[index] = Some(probed);
    }

    // Build the probed labels serially, in declared tile order, gated by the
    // shared running budget: `build_label`'s expensive per-label reads and
    // allocations only run while the budget has room and stop the instant it is
    // exhausted. This keeps peak label memory/IO O(budget) and reproduces the
    // sequential importer's retention exactly — the same labels and colors are
    // kept, and the same ones dropped, in the same order.
    let mut tile_labels = Vec::with_capacity(tile_prefixes.len());
    for (prefix, probed) in tile_prefixes.iter().zip(probed_labels) {
        let probed = probed.expect("every tile index is filled by the probe loop");
        let image_id = ImageId(format!("{id}:image:{prefix}"));
        let owner = EntityId(format!("{id}:tile:{prefix}"));
        let imported =
            build_labels_within_budget(&mut label_budget, store, id, &image_id, &owner, probed)
                .await;
        tile_labels.push(imported);
    }
    let mut tile_labels = tile_labels.into_iter();

    for group in &parsed_groups {
        let group_entity_id = EntityId(format!("{id}:group:{}", group.path));

        entities.push(Entity {
            id: group_entity_id.clone(),
            kind: EntityKind::Group,
            parent: None,
            labels: EntityLabels {
                name: Some(format!(
                    "{}/{}",
                    find_row_label(group.row_index),
                    find_col_label(group.column_index),
                )),
                group_row: Some(find_row_label(group.row_index)),
                group_column: Some(find_col_label(group.column_index)),
                row_index: Some(group.row_index),
                column_index: Some(group.column_index),
                ..Default::default()
            },
        });

        // Collect stage translations for this group's tiles to normalize them.
        // Translations are stored in OME-Zarr in physical units (e.g. microns);
        // convert to voxel units here so downstream consumers see consistent
        // units across grid- and stage-positioned collections.
        let stage_positions: Vec<Option<[f64; 2]>> = if has_explicit_positions {
            group
                .tiles
                .iter()
                .map(|tile| {
                    tile.translation.as_ref().map(|t| {
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
            vec![None; group.tiles.len()]
        };

        // Find minimum for normalization within this group.
        let (min_x, min_y) = if has_explicit_positions {
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

        for (fi, tile) in group.tiles.iter().enumerate() {
            let tile_entity_id = EntityId(format!("{id}:tile:{}", tile.store_prefix));
            let image_id = ImageId(format!("{id}:image:{}", tile.store_prefix));

            entities.push(Entity {
                id: tile_entity_id.clone(),
                kind: EntityKind::Tile,
                parent: Some(group_entity_id.clone()),
                labels: EntityLabels {
                    name: Some(format!("Tile {}", fi)),
                    tile_index: Some(fi as u32),
                    ..Default::default()
                },
            });

            // Build tile->group transform.
            if has_explicit_positions {
                if let Some([x, y]) = stage_positions[fi] {
                    transforms.push(TransformEdge {
                        from: tile_entity_id.clone(),
                        to: group_entity_id.clone(),
                        transform: VoxelTransform::from_voxel_translation_2d(x - min_x, y - min_y),
                    });
                } else {
                    transforms.push(TransformEdge {
                        from: tile_entity_id.clone(),
                        to: group_entity_id.clone(),
                        transform: VoxelTransform::from_voxel_translation_2d(0.0, 0.0),
                    });
                }
            }
            // Grid transforms are built after all entities are created.

            // This tile's `labels/` group was probed concurrently above and
            // its budget charged in declared order; take the prepared overlays
            // so they interleave after the tile's own image entries exactly as
            // a sequential probe would place them.
            let tile_labels = tile_labels
                .next()
                .expect("one prepared label set per tile, in declared order");

            images.push(ImageSpec {
                image_id: image_id.clone(),
                owner: tile_entity_id,
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
                store_prefix: Some(tile.store_prefix.clone()),
                levels: level_bindings.clone(),
            });

            // Append the tile's labels after its own image entries.
            label_specs.extend(tile_labels.specs);
            fetch_images.extend(tile_labels.fetch);
            binding_images.extend(tile_labels.bindings);
        }
    }

    // Build grid tile transforms if not stage-positioned.
    if !has_explicit_positions {
        let group_entities: Vec<&Entity> = entities
            .iter()
            .filter(|e| e.kind == EntityKind::Group)
            .collect();
        let tile_entities: Vec<Entity> = entities
            .iter()
            .filter(|e| e.kind == EntityKind::Tile)
            .cloned()
            .collect();

        let grid_transforms = lucida_content::collection::build_grid_tile_transforms(
            &group_entities
                .iter()
                .map(|e| (*e).clone())
                .collect::<Vec<_>>(),
            &tile_entities,
            full_shape_5d,
        )
        .map_err(|e| StoreError::Metadata(e.to_string()))?;

        transforms = grid_transforms;
    }

    // Build collection layout (places groups, not tiles).
    let source_layout = lucida_content::collection::build_collection_layout(
        &entities,
        &rows,
        &columns,
        full_shape_5d,
    );

    let default_layout_id = source_layout.id.clone();

    let manifest = DatasetManifest::new(
        DatasetId(id.to_string()),
        name.to_string(),
        DatasetKind::Collection {
            rows,
            columns,
            positioning_mode,
            has_explicit_positions,
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
        warnings,
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
/// representative tile of a collection, since OME-Zarr collections require all tiles to
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
/// A zero chunk dimension is rejected with a [`StoreError`] rather than allowed
/// to reach the `shape / chunk` grid computation (which would divide by zero and
/// panic). This keeps untrusted array metadata — a label's or an image's
/// `chunk_shape` — from aborting the process: a bad label surfaces as an `Err`
/// the caller skips, and a bad source array fails the import loudly.
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
            let shape = normalize_to_5d(&meta.shape, axes_names, 1);
            let chunk_shape =
                normalize_to_5d(&meta.chunk_grid.configuration.chunk_shape, axes_names, 1);
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
/// `labels` list; this bounds the total kept across every tile of a collection so
/// an adversarial dataset can't accumulate unbounded label specs in memory.
const MAX_LABELS_PER_DATASET: usize = 1 << 16;

/// Dataset-wide ceiling on retained color-table entries, summed across all
/// labels. Complements the per-label color cap in `parse` so the total color
/// memory across a whole collection stays bounded.
const MAX_LABEL_COLORS_PER_DATASET: usize = 1 << 20;

/// Remaining dataset-wide budget for retained labels and color entries, carried
/// across every source image / collection tile so aggregate memory is bounded even
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

/// One source image's `labels/` group after its index has been read but before
/// any label is built. Holds the group prefix (for the per-label reads and
/// diagnostics) and the declared label names in order — never the built
/// multiscale specs, so holding one of these for every tile of a wide collection at
/// once costs no per-label memory.
#[derive(Default)]
struct ProbedLabels {
    labels_prefix: String,
    names: Vec<String>,
}

/// Detect an OME-NGFF `labels/` child group on a source image group and import
/// every well-formed label it lists, up to the shared dataset budget.
///
/// `base_prefix` is the source image group's store prefix (`""` for a
/// standalone image, `"{group}/{tile}"` for a collection tile); labels live under
/// `{base_prefix}/labels`. A missing `labels/` group — the common case —
/// returns empty. Each label is built through the same multiscale pipeline as
/// an ordinary image and attached to `source_image_id`; a label that fails to
/// parse is skipped with a warning so one bad label never fails the import.
/// `budget` is shared across all calls for a dataset and bounds the aggregate
/// number of retained labels and colors: once it is exhausted, no further label
/// is read or built.
async fn import_labels_for_image(
    budget: &mut LabelBudget,
    store: &Arc<dyn ObjectStore>,
    dataset_id: &str,
    base_prefix: &str,
    source_image_id: &ImageId,
    source_owner: &EntityId,
) -> ImportedLabels {
    let probed = probe_labels_for_image(store, base_prefix).await;
    build_labels_within_budget(
        budget,
        store,
        dataset_id,
        source_image_id,
        source_owner,
        probed,
    )
    .await
}

/// Read a source image's `labels/` group index and return the label names it
/// declares, in order, without building any of them. A missing `labels/` group —
/// the common case — yields an empty list.
///
/// This reads exactly one small index object and holds only names, so it is the
/// only per-tile label I/O safe to fan out concurrently: probing every tile of
/// a wide collection at once costs no per-label memory. The expensive per-label reads
/// happen later in [`build_labels_within_budget`], gated by the shared budget.
async fn probe_labels_for_image(store: &Arc<dyn ObjectStore>, base_prefix: &str) -> ProbedLabels {
    let labels_prefix = if base_prefix.is_empty() {
        "labels".to_string()
    } else {
        format!("{base_prefix}/labels")
    };

    let Some(labels_json) =
        parse::read_optional_zarr_json(store, &format!("{labels_prefix}/zarr.json")).await
    else {
        return ProbedLabels {
            labels_prefix,
            names: Vec::new(),
        };
    };

    let names = parse::parse_labels_names(&labels_json);
    ProbedLabels {
        labels_prefix,
        names,
    }
}

/// Build a source image's probed labels in declared order, charging the shared
/// dataset budget as it goes and stopping the instant the budget is exhausted.
///
/// The budget gate wraps `build_label` itself, so the per-label multiscale and
/// color-table reads and allocations only ever run for labels that are actually
/// retained: peak label memory and build I/O stay O(budget), never O(total
/// declared), even for an adversarial dataset that lists far more labels than
/// the budget allows. Malformed labels and budget exhaustion are logged exactly
/// as a purely sequential importer would, so the retained set — and which labels
/// and colors are dropped once the budget is exceeded — is identical no matter
/// how the probe that produced `probed` was scheduled.
async fn build_labels_within_budget(
    budget: &mut LabelBudget,
    store: &Arc<dyn ObjectStore>,
    dataset_id: &str,
    source_image_id: &ImageId,
    source_owner: &EntityId,
    probed: ProbedLabels,
) -> ImportedLabels {
    let ProbedLabels {
        labels_prefix,
        names,
    } = probed;
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
            Ok(mut label) => {
                // Clamp this label's colors to the remaining dataset-wide budget
                // before retaining them, then charge both budgets.
                if label.spec.colors.len() > budget.colors_remaining {
                    label.spec.colors.truncate(budget.colors_remaining);
                }
                budget.colors_remaining -= label.spec.colors.len();
                budget.labels_remaining -= 1;
                imported.specs.push(label.spec);
                imported.fetch.push(label.fetch);
                imported.bindings.push(label.binding);
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
    // A zero chunk dimension here returns Err, so the label is skipped by the
    // caller rather than panicking the whole import.
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

    /// Create a minimal OME-Zarr collection fixture.
    // Test helper; args mirror collection-layout shape parameters.
    #[allow(clippy::too_many_arguments)]
    fn create_collection_fixture(
        dir: &std::path::Path,
        collection_name: &str,
        rows: &[&str],
        columns: &[&str],
        groups: &[(
            /*row*/ &str,
            /*col*/ &str,
            /*row_idx*/ u32,
            /*col_idx*/ u32,
            /*num_tiles*/ u32,
        )],
        tile_shape: [u64; 5],
        tile_chunk: [u64; 5],
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
        let groups_json: Vec<serde_json::Value> = groups
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
                        "name": collection_name,
                        "rows": rows_json,
                        "columns": cols_json,
                        "wells": groups_json,
                        "field_count": groups.iter().map(|w| w.4).max().unwrap_or(1),
                    }
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        for (row, col, _ri, _ci, num_tiles) in groups {
            let group_dir = dir.join(row).join(col);
            fs::create_dir_all(&group_dir).unwrap();

            let row_dir = dir.join(row);
            let row_meta = serde_json::json!({"zarr_format": 3, "node_type": "group"});
            fs::write(
                row_dir.join("zarr.json"),
                serde_json::to_string_pretty(&row_meta).unwrap(),
            )
            .unwrap();

            let images: Vec<serde_json::Value> = (0..*num_tiles)
                .map(|i| serde_json::json!({"path": i.to_string()}))
                .collect();

            let group_meta = serde_json::json!({
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
                group_dir.join("zarr.json"),
                serde_json::to_string_pretty(&group_meta).unwrap(),
            )
            .unwrap();

            for i in 0..*num_tiles {
                let tile_dir = group_dir.join(i.to_string());
                fs::create_dir_all(&tile_dir).unwrap();

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

                let tile_root = serde_json::json!({
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
                    tile_dir.join("zarr.json"),
                    serde_json::to_string_pretty(&tile_root).unwrap(),
                )
                .unwrap();

                for lvl in 0..num_levels {
                    let level_dir = tile_dir.join(lvl.to_string());
                    fs::create_dir_all(&level_dir).unwrap();
                    let scale = 1u64 << lvl;
                    let level_shape = [
                        tile_shape[0],
                        tile_shape[1],
                        tile_shape[2],
                        tile_shape[3].div_ceil(scale),
                        tile_shape[4].div_ceil(scale),
                    ];
                    let arr = serde_json::json!({
                        "zarr_format": 3,
                        "node_type": "array",
                        "shape": level_shape,
                        "data_type": "uint16",
                        "chunk_grid": {
                            "name": "regular",
                            "configuration": { "chunk_shape": tile_chunk }
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
    #[ignore = "depends on example_files/volume-3d.ome.zarr (not in repo)"]
    async fn import_single_image() {
        let store = crate::backend::open(&format!(
            "{}/example_files/volume-3d.ome.zarr",
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
    async fn import_collection() {
        let dir = temp_dir("import_collection");
        create_collection_fixture(
            &dir,
            "test_collection",
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
        let result = import_dataset(&store, "collection-id", "Test Collection")
            .await
            .unwrap();

        // Verify content graph.
        assert!(matches!(
            result.manifest.kind,
            DatasetKind::Collection { .. }
        ));

        // Should have group entities and tile entities.
        let groups: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Group)
            .collect();
        let tiles: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Tile)
            .collect();
        assert_eq!(groups.len(), 3, "expected 3 groups");
        assert_eq!(tiles.len(), 4, "expected 4 tiles total (2+1+1)");

        // Every tile should have a parent that is a group.
        for tile in &tiles {
            assert!(tile.parent.is_some());
            let parent_id = tile.parent.as_ref().unwrap();
            assert!(
                groups.iter().any(|w| &w.id == parent_id),
                "tile parent {:?} should be a group",
                parent_id,
            );
        }

        // Should have transforms (tile->group).
        assert!(!result.manifest.transforms().is_empty());

        // Should have one image per tile.
        assert_eq!(result.manifest.images().len(), tiles.len());

        // Fetch should be Proxied with one spec per image.
        if let FetchSource::Proxied(ref proxied) = result.fetch {
            assert_eq!(proxied.images.len(), tiles.len());
        } else {
            panic!("Expected Proxied fetch descriptor");
        }

        // Binding seed should have one entry per image, each with store_prefix.
        assert_eq!(result.binding_seed.images.len(), tiles.len());
        for img in &result.binding_seed.images {
            assert!(img.store_prefix.is_some());
        }

        // Verify source layout places groups, not tiles.
        let layout = &result.manifest.source_layouts()[0];
        for placement in &layout.placements {
            assert!(
                groups.iter().any(|w| w.id == placement.entity_id),
                "Layout should only place groups, not tiles",
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

        // DatasetKind::Collection should carry correct metadata.
        match &result.manifest.kind {
            DatasetKind::Collection {
                rows,
                columns,
                positioning_mode,
                has_explicit_positions,
            } => {
                assert_eq!(rows, &["A", "B"]);
                assert_eq!(columns, &["1", "2"]);
                assert_eq!(*positioning_mode, PositioningMode::Derived);
                assert!(!has_explicit_positions);
            }
            _ => panic!("expected Collection kind"),
        }

        // A fully valid collection records no warnings.
        assert!(
            result.warnings.is_empty(),
            "valid collection should have no warnings, got {:?}",
            result.warnings,
        );

        // Pretty-print for visual inspection.
        println!("{}", serde_json::to_string_pretty(&result).unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A single hollow/unreadable group is skipped with a recorded warning while
    /// the rest of the collection imports. The representative tile is drawn from the
    /// first surviving group in declared order.
    #[tokio::test]
    async fn skipped_group_does_not_fail_collection_import() {
        let dir = temp_dir("skipped_group");
        create_collection_fixture(
            &dir,
            "skip_collection",
            &["A", "B"],
            &["1", "2"],
            &[
                ("A", "1", 0, 0, 1),
                ("A", "2", 0, 1, 1),
                ("B", "1", 1, 0, 1),
            ],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 128, 128],
            1,
        );

        // Corrupt one group's metadata so it cannot be parsed.
        fs::write(dir.join("A").join("2").join("zarr.json"), b"{ not json").unwrap();

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "skip-id", "Skip Collection")
            .await
            .unwrap();

        // Exactly one warning, naming the skipped group by its collection path.
        assert_eq!(
            result.warnings.len(),
            1,
            "expected one skipped-group warning"
        );
        let warning = &result.warnings[0];
        assert_eq!(warning.kind, ImportWarningKind::SkippedGroup);
        assert_eq!(warning.target, "A/2");
        assert!(
            warning.message.contains("A/2"),
            "message should name the group, got {:?}",
            warning.message,
        );

        // Two groups survive; the collection still opens.
        let groups: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Group)
            .collect();
        assert_eq!(groups.len(), 2, "expected 2 surviving groups");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A collection where no group parses is a genuinely broken dataset and still
    /// fails the import loudly.
    #[tokio::test]
    async fn collection_with_no_readable_groups_fails() {
        let dir = temp_dir("all_bad_groups");
        create_collection_fixture(
            &dir,
            "broken_collection",
            &["A"],
            &["1", "2"],
            &[("A", "1", 0, 0, 1), ("A", "2", 0, 1, 1)],
            [1, 1, 1, 128, 128],
            [1, 1, 1, 64, 64],
            1,
        );

        fs::write(dir.join("A").join("1").join("zarr.json"), b"nonsense").unwrap();
        fs::write(dir.join("A").join("2").join("zarr.json"), b"nonsense").unwrap();

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "broken-id", "Broken Collection")
            .await
            .unwrap_err();
        assert!(
            matches!(err, StoreError::Metadata(_)),
            "expected a metadata error, got {err:?}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_collection_with_stage_positions() {
        let dir = temp_dir("import_collection_stage");
        fs::create_dir_all(&dir).unwrap();

        // Build collection root with stage translations on the tiles.
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "plate": {
                        "version": "0.5",
                        "name": "stage_collection",
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

        // Group with stage-positioned tiles.
        let group_dir = dir.join("A").join("1");
        fs::create_dir_all(&group_dir).unwrap();
        let group_meta = serde_json::json!({
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
            group_dir.join("zarr.json"),
            serde_json::to_string_pretty(&group_meta).unwrap(),
        )
        .unwrap();

        // Write tile multiscale metadata.
        for i in 0..2u32 {
            let tile_dir = group_dir.join(i.to_string());
            fs::create_dir_all(&tile_dir).unwrap();
            let tile_root = serde_json::json!({
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
                tile_dir.join("zarr.json"),
                serde_json::to_string_pretty(&tile_root).unwrap(),
            )
            .unwrap();

            let level_dir = tile_dir.join("0");
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
        let result = import_dataset(&store, "stage-id", "Stage Collection")
            .await
            .unwrap();

        // Should be an explicitly-positioned collection.
        if let DatasetKind::Collection {
            positioning_mode,
            has_explicit_positions,
            ..
        } = &result.manifest.kind
        {
            assert_eq!(*positioning_mode, PositioningMode::Explicit);
            assert!(*has_explicit_positions);
        } else {
            panic!("expected Collection kind");
        }

        // Transforms should reflect normalized stage positions.
        assert_eq!(result.manifest.transforms().len(), 2);
        // tile 0 translation [y=100, x=200] => position [x=200, y=100], normalized min.
        // tile 1 translation [y=300, x=600] => position [x=600, y=300].
        // min_x=200, min_y=100 => tile 0 at (0,0), tile 1 at (400,200).
        let t0 = &result.manifest.transforms()[0];
        let t1 = &result.manifest.transforms()[1];
        assert!(
            (t0.transform.matrix()[12]).abs() < 1e-9,
            "tile 0 tx should be 0"
        );
        assert!(
            (t0.transform.matrix()[13]).abs() < 1e-9,
            "tile 0 ty should be 0"
        );
        assert!(
            (t1.transform.matrix()[12] - 400.0).abs() < 1e-9,
            "tile 1 tx should be 400, got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 200.0).abs() < 1e-9,
            "tile 1 ty should be 200, got {}",
            t1.transform.matrix()[13],
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Build a single-group stage-positioned collection fixture.
    ///
    /// `translations[i]` is written verbatim as the tile's
    /// `coordinateTransformations.translation` (5-element TCZYX). Pass `None`
    /// to omit the entry, producing a grid-positioned group.
    /// `scale` is the level-0 [T, C, Z, Y, X] scale; pass `None` to omit the
    /// `scale` coordinate transform entirely (so default scale of 1.0 applies).
    fn create_stage_collection_fixture(
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
                        "name": "test_collection",
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

        let group_dir = dir.join("A").join("1");
        fs::create_dir_all(&group_dir).unwrap();

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

        let group_meta = serde_json::json!({
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
            group_dir.join("zarr.json"),
            serde_json::to_string_pretty(&group_meta).unwrap(),
        )
        .unwrap();

        for i in 0..translations.len() {
            let tile_dir = group_dir.join(i.to_string());
            fs::create_dir_all(&tile_dir).unwrap();

            // Optionally include the scale coordinate transform.
            let mut dataset = serde_json::json!({"path": "0"});
            if let Some(s) = scale {
                dataset["coordinateTransformations"] = serde_json::json!([{
                    "type": "scale",
                    "scale": s,
                }]);
            }

            let tile_root = serde_json::json!({
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
                tile_dir.join("zarr.json"),
                serde_json::to_string_pretty(&tile_root).unwrap(),
            )
            .unwrap();

            let level_dir = tile_dir.join("0");
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

    /// Find the tile->group TransformEdge for a given tile index. Tile IDs
    /// follow the pattern `{dataset}:tile:A/1/{i}` per the import code.
    fn find_tile_transform<'a>(
        result: &'a ImportResult,
        dataset_id: &str,
        tile_index: usize,
    ) -> &'a TransformEdge {
        let target = format!("{dataset_id}:tile:A/1/{tile_index}");
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
    /// units before forming the tile->group transform.
    /// tile 0 at (0, 0); tile 1 at (100 µm, 200 µm). With Y/X scale of
    /// 0.5 µm/voxel the second tile ends up at (200, 400) voxels.
    #[tokio::test]
    async fn stage_translations_normalized_to_voxel_units() {
        let dir = temp_dir("stage_translations_voxel_units");
        // Translations are TCZYX. The test puts X=100 µm, Y=200 µm on tile 1.
        let translations = vec![
            Some([0.0, 0.0, 0.0, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0, 200.0, 100.0]),
        ];
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.5]);
        create_stage_collection_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "stage-vox", "Stage Voxel")
            .await
            .unwrap();

        // Sanity: should be Explicit-positioned.
        if let DatasetKind::Collection {
            positioning_mode,
            has_explicit_positions,
            ..
        } = &result.manifest.kind
        {
            assert_eq!(*positioning_mode, PositioningMode::Explicit);
            assert!(*has_explicit_positions);
        } else {
            panic!("expected Collection kind");
        }

        // tile 0 is the per-group origin.
        let t0 = find_tile_transform(&result, "stage-vox", 0);
        assert!(
            (t0.transform.matrix()[12]).abs() < 1e-9,
            "tile 0 tx should be 0"
        );
        assert!(
            (t0.transform.matrix()[13]).abs() < 1e-9,
            "tile 0 ty should be 0"
        );

        // tile 1: 100 µm / 0.5 = 200 voxels in X, 200 µm / 0.5 = 400 voxels in Y.
        let t1 = find_tile_transform(&result, "stage-vox", 1);
        assert!(
            (t1.transform.matrix()[12] - 200.0).abs() < 1e-9,
            "tile 1 tx should be 200 voxels, got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 400.0).abs() < 1e-9,
            "tile 1 ty should be 400 voxels, got {}",
            t1.transform.matrix()[13],
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Grid-positioned collections (no translations) must be unaffected by the
    /// scale-conversion code path.
    #[tokio::test]
    async fn grid_collections_unaffected() {
        let dir = temp_dir("grid_collections_unaffected");
        // Two tiles, neither with a translation -> grid-positioned collection.
        let translations = vec![None, None];
        // Choose a non-trivial scale so the wrong code path would be visible.
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.5]);
        create_stage_collection_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "grid-collection", "Grid Collection")
            .await
            .unwrap();

        // Sanity: should be Derived-positioned.
        if let DatasetKind::Collection {
            positioning_mode,
            has_explicit_positions,
            ..
        } = &result.manifest.kind
        {
            assert_eq!(*positioning_mode, PositioningMode::Derived);
            assert!(!*has_explicit_positions);
        } else {
            panic!("expected Collection kind");
        }

        // The grid formula: for n=2 tiles, cols = ceil(sqrt(2)) = 2,
        // gap = 0.08 * 128 = 10.24, so tile 0 at (0, 0), tile 1 at
        // (128 + 10.24, 0). tile size is 128x128 (level 0 shape).
        let tile_x = 128.0_f64;
        let gap_x = 0.08 * tile_x;

        let t0 = find_tile_transform(&result, "grid-collection", 0);
        assert!((t0.transform.matrix()[12]).abs() < 1e-9, "tile 0 tx");
        assert!((t0.transform.matrix()[13]).abs() < 1e-9, "tile 0 ty");

        let t1 = find_tile_transform(&result, "grid-collection", 1);
        assert!(
            (t1.transform.matrix()[12] - (tile_x + gap_x)).abs() < 1e-9,
            "tile 1 tx should be {} voxels, got {}",
            tile_x + gap_x,
            t1.transform.matrix()[12],
        );
        assert!((t1.transform.matrix()[13]).abs() < 1e-9, "tile 1 ty");

        let _ = fs::remove_dir_all(&dir);
    }

    /// When the multiscales `scale` coordinate transform is omitted, the
    /// default scale is 1.0 (per parse.rs), so stage translations should pass
    /// through to voxel units unchanged.
    #[tokio::test]
    async fn missing_voxel_scale_falls_back_to_unit_scale() {
        let dir = temp_dir("missing_voxel_scale");
        // tile 1 at translation (100 µm, 200 µm) — but with scale=1.0 (the
        // default), the conversion is a no-op and the voxel translation
        // matches the raw value.
        let translations = vec![
            Some([0.0, 0.0, 0.0, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0, 200.0, 100.0]),
        ];
        // No explicit scale entry -> default of 1.0 in parse.rs.
        create_stage_collection_fixture(&dir, &translations, None);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "missing-scale", "Missing Scale")
            .await
            .unwrap();

        // tile 0 at origin.
        let t0 = find_tile_transform(&result, "missing-scale", 0);
        assert!((t0.transform.matrix()[12]).abs() < 1e-9);
        assert!((t0.transform.matrix()[13]).abs() < 1e-9);

        // tile 1: pass-through (raw 100 -> 100 voxels in X, 200 -> 200 in Y).
        let t1 = find_tile_transform(&result, "missing-scale", 1);
        assert!(
            (t1.transform.matrix()[12] - 100.0).abs() < 1e-9,
            "tile 1 tx should be 100 voxels (pass-through), got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 200.0).abs() < 1e-9,
            "tile 1 ty should be 200 voxels (pass-through), got {}",
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
        create_stage_collection_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "zero-scale", "Zero Scale")
            .await
            .unwrap();

        // tile 0 at origin.
        let t0 = find_tile_transform(&result, "zero-scale", 0);
        assert!((t0.transform.matrix()[12]).abs() < 1e-9);
        assert!((t0.transform.matrix()[13]).abs() < 1e-9);

        // tile 1: X falls back to scale=1 (raw 100 -> 100). Y uses real
        // scale=0.5 (raw 200 -> 400). Verify no NaN/Inf.
        let t1 = find_tile_transform(&result, "zero-scale", 1);
        assert!(
            t1.transform.matrix()[12].is_finite(),
            "tile 1 tx must be finite (no division by zero), got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[12] - 100.0).abs() < 1e-9,
            "tile 1 tx should be 100 (X scale fell back to 1.0), got {}",
            t1.transform.matrix()[12],
        );
        assert!(
            (t1.transform.matrix()[13] - 400.0).abs() < 1e-9,
            "tile 1 ty should be 400 (Y scale 0.5 still applied), got {}",
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
                    {"label": "Channel 0", "color": "0000FF"},
                    {"label": "Channel 1", "color": "00FF00"}
                ]
            })),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "omero-id", "Omero").await.unwrap();

        let ci = &result.manifest.images()[0].multiscale.channel_infos;
        assert_eq!(ci.len(), 2);
        assert_eq!(ci[0].label, "Channel 0");
        assert_eq!(ci[0].color.as_deref(), Some("0000FF"));
        assert_eq!(ci[1].label, "Channel 1");

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

    /// Write a `labels/` group listing `names` into an existing image or tile
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
        write_labels_index(&dir, &["region-b"]);
        write_label_multiscale(
            &dir,
            "region-b",
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
        assert_eq!(label.name, "region-b");
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
        assert_eq!(binding.store_prefix.as_deref(), Some("labels/region-b"));
        assert_eq!(binding.axes_names, vec!["t", "z", "y", "x"]);
        assert!(!binding.levels.is_empty());

        // The stored spec exposes the label's full multiscale for streaming.
        let spec = result
            .manifest
            .label_specs()
            .iter()
            .find(|s| s.name == "region-b")
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

    /// Labels nested under a single collection tile attach to that tile's image,
    /// with a tile-nested store prefix, and leave DatasetKind and the tile
    /// image set unchanged.
    #[tokio::test]
    async fn import_collection_with_labels_on_tile() {
        let dir = temp_dir("import_collection_labels");
        create_collection_fixture(
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

        // Attach a "region-c" label to tile A/1/0 only.
        let tile_dir = dir.join("A").join("1").join("0");
        write_labels_index(&tile_dir, &["region-c"]);
        write_label_multiscale(
            &tile_dir,
            "region-c",
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
        let result = import_dataset(&store, "collection-lbl", "Collection Labeled")
            .await
            .unwrap();

        // DatasetKind and tile image set are unchanged (4 tiles: 2+1+1).
        assert!(matches!(
            result.manifest.kind,
            DatasetKind::Collection { .. }
        ));
        assert_eq!(result.manifest.images().len(), 4);

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1);
        let label = &labels[0];
        assert_eq!(label.name, "region-c");
        assert_eq!(label.data_type, DataType::Uint32);
        assert_eq!(label.axis_names, vec!["t", "z", "y", "x"]);
        // Attached to the A/1/0 tile image specifically.
        let expected_source = ImageId("collection-lbl:image:A/1/0".to_string());
        assert_eq!(label.source_image_id, expected_source);
        // That source image really exists in the manifest.
        assert!(
            result
                .manifest
                .images()
                .iter()
                .any(|i| i.image_id == expected_source),
        );

        // Streamable with a tile-nested store prefix.
        let binding = result
            .binding_seed
            .images
            .iter()
            .find(|b| b.image_id == label.label_image_id)
            .expect("label binding present");
        assert_eq!(
            binding.store_prefix.as_deref(),
            Some("A/1/0/labels/region-c")
        );

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

    /// The same guard applies on the collection path: a zero chunk dimension in the
    /// representative tile's array fails loudly rather than panicking.
    #[tokio::test]
    async fn collection_source_with_zero_chunk_fails_without_panic() {
        let dir = temp_dir("import_collection_zero_chunk");
        create_collection_fixture(
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
        let err = import_dataset(&store, "pzc", "Collection Zero Chunk")
            .await
            .expect_err("a zero-chunk collection tile array must fail the import");
        assert!(matches!(err, StoreError::Metadata(_)));
        assert!(
            err.to_string().contains("zero"),
            "error should name the zero dimension: {err}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// An [`ObjectStore`] decorator that records the location of every GET it
    /// serves and delegates all work to an inner store. Lets a test observe
    /// exactly which objects the importer reads.
    #[derive(Debug)]
    struct RecordingStore {
        inner: Arc<dyn ObjectStore>,
        gets: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl std::fmt::Display for RecordingStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "RecordingStore({})", self.inner)
        }
    }

    #[async_trait::async_trait]
    impl ObjectStore for RecordingStore {
        async fn put_opts(
            &self,
            location: &Path,
            payload: object_store::PutPayload,
            opts: object_store::PutOptions,
        ) -> object_store::Result<object_store::PutResult> {
            self.inner.put_opts(location, payload, opts).await
        }

        async fn put_multipart_opts(
            &self,
            location: &Path,
            opts: object_store::PutMultipartOptions,
        ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
            self.inner.put_multipart_opts(location, opts).await
        }

        async fn get_opts(
            &self,
            location: &Path,
            options: object_store::GetOptions,
        ) -> object_store::Result<object_store::GetResult> {
            self.gets.lock().unwrap().push(location.to_string());
            self.inner.get_opts(location, options).await
        }

        async fn delete(&self, location: &Path) -> object_store::Result<()> {
            self.inner.delete(location).await
        }

        fn list(
            &self,
            prefix: Option<&Path>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
        {
            self.inner.list(prefix)
        }

        async fn list_with_delimiter(
            &self,
            prefix: Option<&Path>,
        ) -> object_store::Result<object_store::ListResult> {
            self.inner.list_with_delimiter(prefix).await
        }

        async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
            self.inner.copy(from, to).await
        }

        async fn copy_if_not_exists(&self, from: &Path, to: &Path) -> object_store::Result<()> {
            self.inner.copy_if_not_exists(from, to).await
        }
    }

    /// The shared dataset budget gates `build_label` itself: once it is
    /// exhausted, labels beyond the budget are neither built nor read. A group
    /// declaring three well-formed labels, imported under a budget of two,
    /// retains the first two in declared order and performs no I/O whatsoever
    /// against the third — so peak label memory and build I/O track the budget,
    /// never the number of labels a dataset declares.
    #[tokio::test]
    async fn label_budget_stops_building_once_exhausted() {
        let dir = temp_dir("label_budget_stop");
        create_single_image_fixture(&dir, None);
        write_labels_index(&dir, &["keep0", "keep1", "over"]);
        for name in ["keep0", "keep1", "over"] {
            write_label_multiscale(
                &dir,
                name,
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
        }

        let gets = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let store: Arc<dyn ObjectStore> = Arc::new(RecordingStore {
            inner: crate::backend::open(dir.to_str().unwrap()).unwrap(),
            gets: gets.clone(),
        });

        // A budget of exactly two labels, with ample color headroom.
        let mut budget = LabelBudget {
            labels_remaining: 2,
            colors_remaining: MAX_LABEL_COLORS_PER_DATASET,
        };

        let source_image_id = ImageId("img".to_string());
        let source_owner = EntityId("owner".to_string());

        // The probe discovers all declared names — cheap, and expected.
        let probed = probe_labels_for_image(&store, "").await;
        assert_eq!(probed.names, vec!["keep0", "keep1", "over"]);

        let imported = build_labels_within_budget(
            &mut budget,
            &store,
            "ds",
            &source_image_id,
            &source_owner,
            probed,
        )
        .await;

        // Exactly the first two labels are retained, in declared order.
        let kept: Vec<&str> = imported.specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(kept, vec!["keep0", "keep1"]);
        assert_eq!(imported.fetch.len(), 2);
        assert_eq!(imported.bindings.len(), 2);
        // The budget is fully consumed.
        assert_eq!(budget.labels_remaining, 0);

        // Decisive: the third label's group is never read. Building it would
        // require reading its `zarr.json`; the budget gate stops the loop first.
        let reads = gets.lock().unwrap();
        assert!(
            reads.iter().any(|p| p.contains("labels/keep0/")),
            "the first in-budget label must be built (read): {reads:?}",
        );
        assert!(
            reads.iter().any(|p| p.contains("labels/keep1/")),
            "the second in-budget label must be built (read): {reads:?}",
        );
        assert!(
            reads.iter().all(|p| !p.contains("labels/over")),
            "no I/O may touch the over-budget label: {reads:?}",
        );
        drop(reads);

        let _ = fs::remove_dir_all(&dir);
    }
}
