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
    // The environment override is the import's only ambient input. It is
    // read exactly once, here at the entry point, and threaded down as a
    // plain argument so every inner path is a pure function of its inputs.
    let force_exhaustive = exhaustive_label_discovery_forced();
    import_dataset_with_label_discovery(store, id, name, force_exhaustive).await
}

/// [`import_dataset`] with the exhaustive-label-discovery decision passed
/// explicitly instead of read from the environment.
async fn import_dataset_with_label_discovery(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
    force_exhaustive_label_discovery: bool,
) -> Result<ImportResult, StoreError> {
    let root_json = parse::read_zarr_json(store, "zarr.json").await?;

    if parse::ome_attr(&root_json, "plate").is_some() {
        import_collection(
            store,
            id,
            name,
            &root_json,
            force_exhaustive_label_discovery,
        )
        .await
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
    // degrade gracefully without failing the import, but an index that
    // exists (or errors) without yielding names is surfaced as a warning so
    // possibly-incomplete discovery never passes silently.
    let mut warnings: Vec<ImportWarning> = Vec::new();
    let mut label_budget = LabelBudget::new();
    let probed = probe_labels_for_image(store, "").await;
    if probed.index == LabelIndexState::Unusable {
        warnings.push(unusable_label_index_warning(
            id,
            1,
            &[probed.labels_prefix.as_str()],
        ));
    }
    let labels =
        build_labels_within_budget(&mut label_budget, store, id, &image_id, &entity_id, probed)
            .await;

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
        warnings,
    })
}

/// Maximum number of metadata object-store GETs kept in flight while importing
/// a collection. Bounds fan-out so a wide collection opens quickly without self-throttling
/// the backing store.
const METADATA_FETCH_CONCURRENCY: usize = 32;

/// Sampled label discovery engages only when it would skip at least this
/// many per-tile probes; otherwise the whole collection is probed
/// exhaustively. Sampling probes each group's first and last tile and only
/// probes a group's remaining tiles when a sampled tile signals labels, so
/// label-discovery metadata traffic scales with the number of groups (plus
/// labeled tiles) rather than with total tiles. Without this, a wide remote
/// collection pays one round-trip per tile — nearly always a 404 — and that
/// fan-out dominates the whole open.
///
/// Measuring the threshold against the savings (total tiles minus sampled
/// tiles) rather than a flat tile count means a collection only slightly
/// wider than its own sample keeps complete discovery: curtailing it would
/// save fewer than this many reads, which is not worth the completeness
/// loss.
///
/// Trade-off sampling accepts: a group whose labels sit only on tiles that
/// are neither first nor last — with clean misses on both sampled tiles — is
/// never expanded, so those labels go undiscovered. Whenever any tile goes
/// unprobed the import records an [`ImportWarning`] naming
/// [`EXHAUSTIVE_LABEL_DISCOVERY_ENV`], which restores full per-tile probing.
const LABEL_PROBE_SAMPLING_MIN_SKIPPED: usize = 64;

/// Environment variable that forces per-tile label probing on collections of
/// every size (one metadata read per tile, full discovery). Any value other
/// than empty or `"0"` enables it. Read once per import, at the
/// [`import_dataset`] entry point.
const EXHAUSTIVE_LABEL_DISCOVERY_ENV: &str = "LUCIDA_EXHAUSTIVE_LABEL_DISCOVERY";

/// Per-import cap on group expansions triggered by an *unusable* sampled
/// labels index — one whose read failed short of a clean NotFound, or whose
/// content held no usable names. A usable index that actually listed names
/// is never subject to this cap: real labels always expand their group.
/// Only expansions that would add reads are charged: a group whose samples
/// already cover all of its tiles is fully probed as-is, so its expansion
/// costs nothing and consumes no allowance.
///
/// Trade-off: a genuinely labeled group hiding behind a broken index is
/// probed in full only while this budget lasts (charged in declared group
/// order); past it, that group's labels go undiscovered until the operator
/// sets [`EXHAUSTIVE_LABEL_DISCOVERY_ENV`], which the aggregated
/// unusable-index warning names. The cap is kept single-digit because many
/// suspect groups at once almost always means one store-wide condition —
/// throttling, timeouts, or a permission configuration in which missing keys
/// surface as errors rather than NotFound — where every group looks
/// label-suspect simultaneously and uncapped expansion would recreate the
/// per-tile fan-out sampling exists to avoid, aimed at a store that is
/// already struggling. Four keeps discovery complete for a real dataset with
/// a handful of damaged indexes while bounding worst-case anomaly-triggered
/// traffic to four group-widths of extra reads on top of the samples.
const MAX_UNUSABLE_GROUP_EXPANSIONS: usize = 4;

/// Number of example paths named in the aggregated unusable-index warning
/// message: enough to locate the pattern without flooding the message when a
/// store-wide failure makes every index unusable.
const UNUSABLE_INDEX_WARNING_EXAMPLES: usize = 3;

/// Whether [`EXHAUSTIVE_LABEL_DISCOVERY_ENV`] requests exhaustive discovery.
fn exhaustive_label_discovery_forced() -> bool {
    std::env::var(EXHAUSTIVE_LABEL_DISCOVERY_ENV)
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
}

/// Whether every tile of a collection should be probed for labels, given the
/// total tile count, the number of tiles sampling would probe, and the
/// operator override. Exhaustive unless sampling skips at least
/// [`LABEL_PROBE_SAMPLING_MIN_SKIPPED`] tiles.
fn use_exhaustive_label_probes(
    total_tiles: usize,
    sample_count: usize,
    force_exhaustive: bool,
) -> bool {
    force_exhaustive || total_tiles < sample_count.saturating_add(LABEL_PROBE_SAMPLING_MIN_SKIPPED)
}

/// The tile indices sampled per group when label discovery is not exhaustive:
/// each group's first and last tile. `group_spans` are per-group index ranges
/// into the flattened tile list, in declared group order.
fn sample_probe_indices(group_spans: &[std::ops::Range<usize>]) -> Vec<usize> {
    let mut indices = Vec::with_capacity(group_spans.len() * 2);
    for span in group_spans {
        if span.is_empty() {
            continue;
        }
        indices.push(span.start);
        if span.end - span.start > 1 {
            indices.push(span.end - 1);
        }
    }
    indices
}

/// One group's parsed metadata: its collection path, grid coordinates, and the tiles
/// it declares. Produced concurrently, then assembled in declared order.
struct GroupParsed {
    path: String,
    row_index: u32,
    column_index: u32,
    tiles: Vec<TileParsed>,
}

/// One tile within a group: its store prefix and any explicit translation.
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

/// Number of example tile prefixes named in the aggregated
/// unreadable-tile-geometry warning message: enough to locate the pattern
/// without flooding the message when a store-wide condition makes many
/// candidate representatives unreadable at once.
const UNREADABLE_GEOMETRY_WARNING_EXAMPLES: usize = 3;

/// One aggregated [`ImportWarning`] covering every group representative tile
/// that could not be read while selecting the collection's shared geometry.
/// Aggregated by design — a store-wide condition (throttling, timeouts, or a
/// permission configuration that answers a missing key with an error rather
/// than NotFound) can make many representatives unreadable at once, and one
/// warning per candidate would drown the open result. Only emitted once the
/// collection has opened over a later readable representative; `examples` are
/// the passed-over tile prefixes, of which only the first
/// [`UNREADABLE_GEOMETRY_WARNING_EXAMPLES`] are named.
fn unreadable_tile_geometry_warning(
    dataset_id: &str,
    unreadable: usize,
    examples: &[&str],
) -> ImportWarning {
    let noun = if unreadable == 1 { "tile" } else { "tiles" };
    let examples = examples
        .iter()
        .take(UNREADABLE_GEOMETRY_WARNING_EXAMPLES)
        .map(|prefix| format!("{prefix:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    ImportWarning {
        kind: ImportWarningKind::UnreadableTileGeometry,
        target: dataset_id.to_string(),
        message: format!(
            "{unreadable} representative {noun} could not be read for the \
             collection's shared geometry (e.g. {examples}); the collection \
             opened over the next readable tile's geometry. A store permission \
             or throttling issue may be the cause."
        ),
    }
}

/// The shared multiscale geometry every tile of a collection inherits, learned
/// by reading one representative tile. OME-Zarr collections require all tiles to
/// share one multiscale, so a single readable tile's axes, levels, geometry, and
/// channel metadata apply to every tile.
struct SharedTileGeometry {
    axes_names: Vec<String>,
    level_entries: Vec<parse::LevelEntry>,
    channel_infos: Vec<ChannelInfo>,
    level_metas: Vec<parse::ArrayMeta>,
}

/// Read and parse one tile's shared multiscale geometry. Any read or parse
/// failure — an unreadable/malformed `zarr.json` or unreadable level-array
/// metadata — is returned as an error so the caller can fall forward to the next
/// candidate tile instead of aborting the whole collection.
async fn read_tile_geometry(
    store: &Arc<dyn ObjectStore>,
    tile_prefix: &str,
) -> Result<SharedTileGeometry, StoreError> {
    let tile_json = parse::read_zarr_json(store, &format!("{tile_prefix}/zarr.json")).await?;
    let parsed = parse::parse_multiscales(&tile_json, &format!("{tile_prefix}: "))?;
    // Channel display names from the tile's omero block (generic; optional).
    let channel_infos = parse::parse_omero_channels(&tile_json);
    let level_metas = parse::read_level_metas(store, tile_prefix, &parsed.level_entries).await?;
    Ok(SharedTileGeometry {
        axes_names: parsed.axes_names,
        level_entries: parsed.level_entries,
        channel_infos,
        level_metas,
    })
}

/// Select a collection's shared multiscale geometry from candidate
/// representative tiles — one per group, in declared order.
///
/// Because every tile of an OME-Zarr collection shares one multiscale, a
/// single readable representative anywhere defines the geometry for all, so the
/// search never needs to look past one tile per group: the candidate set is
/// O(groups), the same cost tier as parsing the groups themselves, never
/// O(total tiles).
///
/// The first candidate is read alone, so a healthy collection reads exactly one
/// tile before any fan-out. Only when the leading representative is unreadable
/// are the remaining candidates fanned out with bounded concurrency
/// ([`METADATA_FETCH_CONCURRENCY`]) and reduced in declared order, taking the
/// first whose geometry reads. This keeps a corrupt leading representative — or
/// a whole corrupt leading group — falling forward concurrently instead of one
/// serial round-trip per candidate, even under a store-wide condition that
/// makes every read fail.
///
/// Returns the chosen geometry (`None` when no candidate is readable) together
/// with the prefixes of the unreadable candidates that were passed over, in
/// declared order, so the caller can aggregate them into a single warning.
///
/// Candidates are taken by owned value so the concurrent futures — and the
/// stream that drives them — borrow nothing from the caller, keeping the
/// resulting future straightforwardly `Send`.
async fn select_shared_tile_geometry(
    store: &Arc<dyn ObjectStore>,
    candidate_prefixes: Vec<String>,
) -> (Option<SharedTileGeometry>, Vec<String>) {
    let mut unreadable: Vec<String> = Vec::new();
    let mut candidates = candidate_prefixes.into_iter();

    // The leading candidate is read on its own so the common case — a healthy
    // collection — costs exactly one representative read.
    let Some(first) = candidates.next() else {
        return (None, unreadable);
    };
    match read_tile_geometry(store, &first).await {
        Ok(geometry) => return (Some(geometry), unreadable),
        Err(_) => unreadable.push(first),
    }

    // Reached only when the leading representative is unreadable. Fan the rest
    // out with bounded concurrency and consume the results in declared order,
    // so the first readable candidate wins while reads overlap rather than
    // serialize. Returning early drops the stream, cancelling the reads still
    // in flight past the chosen tile.
    let mut stream = futures_util::stream::iter(candidates.map(|prefix| {
        let store = store.clone();
        async move {
            let outcome = read_tile_geometry(&store, &prefix).await;
            (prefix, outcome)
        }
    }))
    .buffered(METADATA_FETCH_CONCURRENCY);
    while let Some((prefix, outcome)) = stream.next().await {
        match outcome {
            Ok(geometry) => return (Some(geometry), unreadable),
            Err(_) => unreadable.push(prefix),
        }
    }
    (None, unreadable)
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

    let Some(images) = parse::ome_attr(&group_json, "well")
        .and_then(|well| well.get("images"))
        .and_then(|v| v.as_array())
    else {
        return Err(skipped_group_warning(
            &target,
            "group metadata has no ome.well.images list".to_string(),
        ));
    };

    // An empty list is as unusable as a missing one: it yields no tiles, which
    // would otherwise become a silent orphan group with no images and no
    // warning. Skip it loudly, exactly as the missing-list case is skipped.
    if images.is_empty() {
        return Err(skipped_group_warning(
            &target,
            "group metadata's ome.well.images list is empty".to_string(),
        ));
    }

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
    force_exhaustive_label_discovery: bool,
) -> Result<ImportResult, StoreError> {
    let collection_json = parse::ome_attr(root_json, "plate").ok_or_else(|| {
        StoreError::Metadata(parse::describe_missing_ome_attr(root_json, "plate"))
    })?;

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

    // Whether any tile is explicitly positioned is a pure function of the
    // already-parsed group metadata (no tile I/O): a single tile carrying a
    // translation makes the whole collection explicitly positioned.
    let has_explicit_positions = parsed_groups
        .iter()
        .flat_map(|group| group.tiles.iter())
        .any(|tile| tile.translation.is_some());

    // Learn the shared multiscale geometry every tile inherits by reading a
    // single representative tile. OME-Zarr collections require all tiles to
    // share one multiscale, so any tile whose geometry reads and parses defines
    // axes, levels, geometry, and channels for every tile — exactly one
    // readable tile anywhere is enough.
    //
    // The candidate set is therefore one representative per group (its first
    // tile), tried in declared order. A candidate whose `zarr.json` or
    // level-array metadata is unreadable or malformed is passed over and the
    // next group's representative is tried, so one corrupt tile — or a whole
    // corrupt leading group — no longer aborts an otherwise-valid collection.
    // Because a single readable representative suffices, the interior tiles of
    // a group whose representative is unreadable are never probed: the search
    // stays O(groups), never O(total tiles), even when a store-wide condition
    // (throttling, timeouts, or permissions masking NotFound as an error)
    // makes every read fail. The healthy common case reads exactly one tile;
    // a corrupt leading representative falls forward with bounded concurrency.
    //
    // If no representative is readable the import fails loudly rather than open
    // a geometry-less collection.
    let representative_prefixes: Vec<String> = parsed_groups
        .iter()
        .filter_map(|group| group.tiles.first())
        .map(|tile| tile.store_prefix.clone())
        .collect();
    let (shared_geometry, unreadable_representatives) =
        select_shared_tile_geometry(store, representative_prefixes).await;
    let SharedTileGeometry {
        axes_names,
        level_entries,
        channel_infos,
        level_metas,
    } = shared_geometry.ok_or_else(|| {
        StoreError::Metadata("collection has no tile with readable geometry".into())
    })?;

    // The collection opened. If selection had to fall forward past unreadable
    // representatives, surface them as one aggregated warning; the common case
    // — the leading representative read cleanly — records nothing.
    if !unreadable_representatives.is_empty() {
        let examples: Vec<&str> = unreadable_representatives
            .iter()
            .map(String::as_str)
            .collect();
        warnings.push(unreadable_tile_geometry_warning(
            id,
            unreadable_representatives.len(),
            &examples,
        ));
    }

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

    // For explicitly-positioned collections, OME-Zarr translations are in physical
    // units, but the rest of lucida composes them with voxel-unit
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
                 scale (scale_x={raw_x}, scale_y={raw_y}); explicit translations \
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

    // Discover per-tile `labels/` groups. This is the only remaining per-tile
    // metadata I/O, so it must not fan out one read per tile on a wide
    // collection: collections within LABEL_PROBE_SAMPLING_MIN_SKIPPED tiles
    // of their own sample size probe every tile exhaustively, while wider
    // ones sample each group's first and last tile and expand to the whole
    // group when a sample signals labels. Tiles left unprobed are treated as
    // label-free and the import records a warning naming the
    // exhaustive-discovery override.
    let mut tile_prefixes: Vec<String> = Vec::new();
    let mut group_spans: Vec<std::ops::Range<usize>> = Vec::with_capacity(parsed_groups.len());
    for group in &parsed_groups {
        let start = tile_prefixes.len();
        tile_prefixes.extend(group.tiles.iter().map(|tile| tile.store_prefix.clone()));
        group_spans.push(start..tile_prefixes.len());
    }
    let mut probed_labels: Vec<Option<ProbedLabels>> =
        (0..tile_prefixes.len()).map(|_| None).collect();
    let samples = sample_probe_indices(&group_spans);
    if use_exhaustive_label_probes(
        tile_prefixes.len(),
        samples.len(),
        force_exhaustive_label_discovery,
    ) {
        let all: Vec<usize> = (0..tile_prefixes.len()).collect();
        probe_labels_for_tiles(store, &tile_prefixes, all, &mut probed_labels).await;
    } else {
        probe_labels_for_tiles(store, &tile_prefixes, samples, &mut probed_labels).await;

        // Expand to every tile of any group whose sampled tiles signal
        // labels, so a labeled group's discovery stays complete (its cost
        // scales with its own tile count, not the whole collection's). Only
        // a clean NotFound on both sampled tiles is a definitive miss. Two
        // signals expand a group, on very different terms:
        //
        // - A usable index that LISTS names is proof of labels, so the rest
        //   of the group is always probed — real labels are never rationed.
        // - An index that exists (or errored) without yielding names is only
        //   a suspicion, and it expands at most
        //   MAX_UNUSABLE_GROUP_EXPANSIONS groups per import, in declared
        //   order, counting only groups whose expansion adds reads (a group
        //   the samples already fully probed costs — and charges — nothing).
        //   When the cause is store-wide — throttling, timeouts, a
        //   permission setup in which missing keys error instead of
        //   returning NotFound — every group looks suspect at once, and
        //   uncapped expansion would recreate the per-tile fan-out sampling
        //   exists to avoid, aimed at a store that is already failing.
        //   Groups past the cap are left unexpanded; the aggregated
        //   unusable-index warning below names the anomaly and the
        //   exhaustive override.
        let mut follow_up: Vec<usize> = Vec::new();
        let mut unusable_expansions = 0usize;
        for span in &group_spans {
            let sampled_state = |state: LabelIndexState| {
                span.clone().any(|index| {
                    probed_labels[index]
                        .as_ref()
                        .is_some_and(|probed| probed.index == state)
                })
            };
            let expand = if sampled_state(LabelIndexState::Listed) {
                true
            } else if sampled_state(LabelIndexState::Unusable)
                && unusable_expansions < MAX_UNUSABLE_GROUP_EXPANSIONS
            {
                // The cap bounds extra reads, so a slot is charged only when
                // this group's expansion actually adds unprobed tiles. A
                // group whose samples already covered every tile (one or two
                // tiles) is fully probed as it stands: expanding it reads
                // nothing, and charging it would spend allowance that a later
                // group's real expansion needs. Its unusable indexes still
                // reach the aggregated warning below.
                let adds_reads = span.clone().any(|index| probed_labels[index].is_none());
                if adds_reads {
                    unusable_expansions += 1;
                }
                adds_reads
            } else {
                false
            };
            if expand {
                follow_up.extend(span.clone().filter(|index| probed_labels[*index].is_none()));
            }
        }
        if !follow_up.is_empty() {
            probe_labels_for_tiles(store, &tile_prefixes, follow_up, &mut probed_labels).await;
        }

        let unprobed = probed_labels.iter().filter(|slot| slot.is_none()).count();
        if unprobed > 0 {
            warnings.push(ImportWarning {
                kind: ImportWarningKind::SampledLabelDiscovery,
                target: id.to_string(),
                message: format!(
                    "label discovery was sampled: probed {probed} of {total} tiles \
                     (each group's first and last tile, expanding to every tile of any \
                     group where labels were found); labels present only on unsampled \
                     tiles were not discovered. Set {EXHAUSTIVE_LABEL_DISCOVERY_ENV}=1 \
                     to probe every tile.",
                    probed = probed_labels.len() - unprobed,
                    total = probed_labels.len(),
                ),
            });
        }
    }

    // Aggregate every unusable labels index probed above — whichever
    // discovery path (sampled or exhaustive) probed it — into one warning.
    // Absence stays silent; an unusable index means labels may exist that
    // discovery could not see, and that must reach the user.
    let unusable_prefixes: Vec<&str> = probed_labels
        .iter()
        .flatten()
        .filter(|probed| probed.index == LabelIndexState::Unusable)
        .map(|probed| probed.labels_prefix.as_str())
        .collect();
    if !unusable_prefixes.is_empty() {
        warnings.push(unusable_label_index_warning(
            id,
            unusable_prefixes.len(),
            &unusable_prefixes,
        ));
    }

    // Build the probed labels serially, in declared tile order, gated by the
    // shared running budget: `build_label`'s expensive per-label reads and
    // allocations only run while the budget has room and stop the instant it is
    // exhausted. This keeps peak label memory/IO O(budget) and reproduces the
    // sequential importer's retention exactly — the same labels and colors are
    // kept, and the same ones dropped, in the same order.
    let mut tile_labels = Vec::with_capacity(tile_prefixes.len());
    for (prefix, probed) in tile_prefixes.iter().zip(probed_labels) {
        // A tile left unprobed by sampled discovery is treated as label-free
        // (the sampling warning above covers the possibility it wasn't).
        let probed = probed.unwrap_or_else(|| ProbedLabels {
            labels_prefix: format!("{prefix}/labels"),
            names: Vec::new(),
            index: LabelIndexState::Absent,
        });
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

        // Collect explicit translations for this group's tiles to normalize them.
        // Translations are stored in OME-Zarr in physical units;
        // convert to voxel units here so downstream consumers see consistent
        // units across derived- and explicitly-positioned collections.
        let explicit_positions: Vec<Option<[f64; 2]>> = if has_explicit_positions {
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
            for [x, y] in explicit_positions.iter().flatten() {
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
                if let Some([x, y]) = explicit_positions[fi] {
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

            // This tile's `labels/` group was probed (or deliberately skipped
            // as label-free) above and its budget charged in declared order;
            // take the prepared overlays so they interleave after the tile's
            // own image entries exactly as a sequential probe would place
            // them.
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

    // Build grid tile transforms if not explicitly-positioned.
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
    /// What the probe learned about the labels index object itself, kept
    /// separate from `names` so sampled discovery can tell a definitive miss
    /// from an index that exists but could not be used.
    index: LabelIndexState,
}

/// What probing a source image's `labels/` index object established.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum LabelIndexState {
    /// A clean NotFound: no index object exists, so the image is
    /// definitively label-free.
    #[default]
    Absent,
    /// The index exists and lists at least one usable label name.
    Listed,
    /// Something is there but nothing usable came back: the read failed
    /// short of a clean NotFound, the object was not valid JSON, or the JSON
    /// carried no usable `attributes.ome.labels` names. Under sampled
    /// discovery this marks the group label-suspect, so its remaining tiles
    /// are probed instead of being assumed label-free.
    Unusable,
}

/// One aggregated [`ImportWarning`] covering every labels index that was
/// probed during an import but could not be used
/// ([`LabelIndexState::Unusable`]): the read failed short of a clean
/// NotFound, the bytes were not valid JSON, or the index listed no usable
/// names. Aggregated by design — a store-wide condition (throttling, or a
/// permission configuration in which a missing key surfaces as an error
/// rather than NotFound) makes every index unusable at once, and one warning
/// per tile would drown the open result. `examples` are the affected
/// `labels/` prefixes; only the first
/// [`UNUSABLE_INDEX_WARNING_EXAMPLES`] are named in the message.
fn unusable_label_index_warning(
    dataset_id: &str,
    unusable: usize,
    examples: &[&str],
) -> ImportWarning {
    let noun = if unusable == 1 {
        "label index"
    } else {
        "label indexes"
    };
    let examples = examples
        .iter()
        .take(UNUSABLE_INDEX_WARNING_EXAMPLES)
        .map(|prefix| format!("{prefix:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    ImportWarning {
        kind: ImportWarningKind::UnusableLabelIndex,
        target: dataset_id.to_string(),
        message: format!(
            "{unusable} {noun} could not be read or held no usable label \
             names (e.g. {examples}); label discovery may be incomplete. A \
             store permission or throttling issue may be the cause. Set \
             {EXHAUSTIVE_LABEL_DISCOVERY_ENV}=1 to probe every tile.",
        ),
    }
}

/// Read a source image's `labels/` group index and return the label names it
/// declares, in order, without building any of them. A missing `labels/` group —
/// the common case — yields an empty list, marked [`LabelIndexState::Absent`];
/// an index that exists but yields no usable names is marked
/// [`LabelIndexState::Unusable`] so callers can treat the anomaly as a signal.
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

    let labels_json =
        match parse::read_optional_zarr_json(store, &format!("{labels_prefix}/zarr.json")).await {
            parse::OptionalZarrJson::Parsed(value) => value,
            parse::OptionalZarrJson::Absent => {
                return ProbedLabels {
                    labels_prefix,
                    names: Vec::new(),
                    index: LabelIndexState::Absent,
                };
            }
            parse::OptionalZarrJson::Unusable => {
                return ProbedLabels {
                    labels_prefix,
                    names: Vec::new(),
                    index: LabelIndexState::Unusable,
                };
            }
        };

    let names = parse::parse_labels_names(&labels_json);
    let index = if names.is_empty() {
        LabelIndexState::Unusable
    } else {
        LabelIndexState::Listed
    };
    ProbedLabels {
        labels_prefix,
        names,
        index,
    }
}

/// Probe the `labels/` group index of the given tiles (indices into
/// `tile_prefixes`) with bounded concurrency, filling each probed slot of
/// `probed_labels`. Slots not named in `indices` are left untouched, so
/// callers can layer probe passes (sample first, then expand).
async fn probe_labels_for_tiles(
    store: &Arc<dyn ObjectStore>,
    tile_prefixes: &[String],
    indices: Vec<usize>,
    probed_labels: &mut [Option<ProbedLabels>],
) {
    let mut probe_stream = futures_util::stream::iter(indices.into_iter().map(|index| {
        let store = store.clone();
        let prefix = tile_prefixes[index].clone();
        async move {
            let probed = probe_labels_for_image(&store, &prefix).await;
            (index, probed)
        }
    }))
    .buffer_unordered(METADATA_FETCH_CONCURRENCY);
    while let Some((index, probed)) = probe_stream.next().await {
        probed_labels[index] = Some(probed);
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
        // Build cost is driven purely by the names; how the index responded
        // matters only to discovery scheduling.
        index: _,
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

    /// An unreadable representative tile no longer aborts the whole collection:
    /// selection falls forward to the next tile whose geometry parses, records a
    /// warning naming the corrupt tile, and every tile (including the corrupt
    /// one) still imports over the shared geometry.
    #[tokio::test]
    async fn unreadable_representative_tile_falls_forward() {
        let dir = temp_dir("unreadable_rep_tile");
        create_collection_fixture(
            &dir,
            "rep_collection",
            &["A", "B"],
            &["1"],
            &[("A", "1", 0, 0, 2), ("B", "1", 1, 0, 1)],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 128, 128],
            1,
        );

        // Corrupt the first tile's own multiscale metadata — the tile that
        // would be picked as representative — while leaving its group's
        // well/images list and every other tile intact.
        fs::write(
            dir.join("A").join("1").join("0").join("zarr.json"),
            b"{ not json",
        )
        .unwrap();

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "rep-id", "Rep Collection")
            .await
            .unwrap();

        // Exactly one aggregated geometry warning, keyed to the dataset and
        // naming the unreadable candidate tile as an example.
        let geo_warnings: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnreadableTileGeometry)
            .collect();
        assert_eq!(
            geo_warnings.len(),
            1,
            "expected one aggregated unreadable-tile-geometry warning, got {:?}",
            result.warnings,
        );
        assert_eq!(geo_warnings[0].target, "rep-id");
        assert!(
            geo_warnings[0].message.contains("A/1/0"),
            "message should name the tile, got {:?}",
            geo_warnings[0].message,
        );

        // All three tiles remain — only the geometry source tile changed.
        let tiles: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Tile)
            .collect();
        assert_eq!(
            tiles.len(),
            3,
            "every tile still imports over shared geometry"
        );

        // The shared geometry was learned from a readable tile.
        for image in result.manifest.images() {
            assert_eq!(image.multiscale.levels[0].shape, [1, 1, 1, 256, 256]);
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// When the representative candidates are corrupt across more than one group,
    /// selection keeps falling forward across group boundaries until a readable
    /// tile is found; only the corrupt candidates read before it are warned.
    #[tokio::test]
    async fn representative_tile_falls_forward_across_groups() {
        let dir = temp_dir("rep_tile_across_groups");
        create_collection_fixture(
            &dir,
            "cross_group_collection",
            &["A", "B"],
            &["1"],
            &[("A", "1", 0, 0, 1), ("B", "1", 1, 0, 1)],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 128, 128],
            1,
        );

        // The entire first group's only tile is unreadable; the second group's
        // tile is valid and must supply the shared geometry.
        fs::write(dir.join("A").join("1").join("0").join("zarr.json"), b"nope").unwrap();

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "cross-id", "Cross Group Collection")
            .await
            .unwrap();

        let geo_warnings: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnreadableTileGeometry)
            .collect();
        assert_eq!(
            geo_warnings.len(),
            1,
            "only the one corrupt candidate is warned"
        );
        assert_eq!(geo_warnings[0].target, "cross-id");
        assert!(
            geo_warnings[0].message.contains("A/1/0"),
            "message should name the corrupt candidate, got {:?}",
            geo_warnings[0].message,
        );

        // Both groups' tiles still import.
        let tiles: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Tile)
            .collect();
        assert_eq!(tiles.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A collection in which no tile has readable geometry cannot learn the
    /// shared multiscale and still fails the import loudly rather than open a
    /// geometry-less collection.
    #[tokio::test]
    async fn collection_with_no_readable_tile_geometry_fails() {
        let dir = temp_dir("no_readable_tile_geometry");
        create_collection_fixture(
            &dir,
            "broken_geometry",
            &["A"],
            &["1", "2"],
            &[("A", "1", 0, 0, 1), ("A", "2", 0, 1, 1)],
            [1, 1, 1, 128, 128],
            [1, 1, 1, 64, 64],
            1,
        );

        // Both groups parse (well/images intact) but every tile's own geometry
        // metadata is corrupt.
        fs::write(dir.join("A").join("1").join("0").join("zarr.json"), b"nope").unwrap();
        fs::write(dir.join("A").join("2").join("0").join("zarr.json"), b"nope").unwrap();

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let err = import_dataset(&store, "broken-geo-id", "Broken Geometry")
            .await
            .unwrap_err();
        assert!(
            matches!(err, StoreError::Metadata(_)),
            "expected a metadata error, got {err:?}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The geometry search never reads a corrupt leading group tile-by-tile.
    /// With every tile of the leading group unreadable, the search tries that
    /// group's single representative, then falls forward to the next group's
    /// representative — so the corrupt group's interior tiles are never read
    /// and total geometry reads track the group count, not the tile count.
    #[tokio::test]
    async fn corrupt_leading_group_geometry_search_skips_interior_tiles() {
        let dir = temp_dir("corrupt_leading_group_geometry");
        create_collection_fixture(
            &dir,
            "p",
            &["A", "B"],
            &["1"],
            &[("A", "1", 0, 0, 20), ("B", "1", 1, 0, 20)],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        // Corrupt EVERY tile of the leading group, so no tile in it is
        // readable. The search must still not read the group tile-by-tile.
        for tile in 0..20 {
            fs::write(
                dir.join("A")
                    .join("1")
                    .join(tile.to_string())
                    .join("zarr.json"),
                b"{ not json",
            )
            .unwrap();
        }

        let (store, reads) = recording_store(&dir);
        let result =
            import_dataset_with_label_discovery(&store, "clg", "Corrupt Leading Group", false)
                .await
                .expect("a corrupt leading group must fall forward, not fail the import");

        // The collection opened over the healthy group's geometry: every tile
        // of both groups still imports.
        assert_eq!(result.manifest.images().len(), 40, "one image per tile");

        // Decisive: the leading group cost exactly one geometry read (its
        // representative), never its 20 tiles, and the search fell forward to
        // the next group's representative.
        let reads = reads.lock().unwrap();
        assert!(
            reads.iter().any(|p| p == "A/1/0/zarr.json"),
            "the leading group's representative must be tried: {reads:?}",
        );
        assert!(
            reads.iter().any(|p| p == "B/1/0/zarr.json"),
            "selection must fall forward to the next group's representative: {reads:?}",
        );
        for interior in ["A/1/1/zarr.json", "A/1/10/zarr.json", "A/1/19/zarr.json"] {
            assert!(
                !reads.iter().any(|p| p == interior),
                "interior tiles of the corrupt leading group must never be read for \
                 geometry, but {interior} was: {reads:?}",
            );
        }
        drop(reads);

        // One aggregated geometry warning, naming the fell-forward
        // representative as an example.
        let geo: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnreadableTileGeometry)
            .collect();
        assert_eq!(geo.len(), 1, "warnings: {:?}", result.warnings);
        assert_eq!(geo[0].target, "clg");
        assert!(geo[0].message.contains("A/1/0"), "{}", geo[0].message);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Store-wide tile-geometry read errors must not re-open the per-tile
    /// fan-out: with every tile's own `zarr.json` GET failing (non-NotFound)
    /// on a wide collection whose group metadata still reads, the geometry
    /// search reads exactly one representative per group — never one per tile —
    /// and then fails loudly rather than opening a geometry-less collection.
    #[tokio::test]
    async fn store_wide_tile_geometry_read_errors_are_bounded_by_groups() {
        let dir = temp_dir("store_wide_geometry_errors");
        // 4 rows x 3 columns = 12 groups, 20 tiles each = 240 tiles.
        wide_label_free_fixture(&dir, &["A", "B", "C", "D"], &["1", "2", "3"], 20);

        let (store, reads) = tile_geometry_read_erroring_store(&dir);
        let err = import_dataset_with_label_discovery(&store, "swg", "Store Wide Geometry", false)
            .await
            .expect_err("no tile has readable geometry, so the import must fail loudly");
        assert!(matches!(err, StoreError::Metadata(_)), "got {err:?}");

        // Decisive: one geometry read per group (12), never one per tile (240).
        let tile_geometry_reads = count_tile_geometry_reads(&reads);
        assert_eq!(
            tile_geometry_reads, 12,
            "expected one geometry read per group (12 groups), got {tile_geometry_reads}",
        );
        assert!(
            tile_geometry_reads <= 24,
            "geometry reads must stay bounded by groups, not the 240 tiles: \
             {tile_geometry_reads}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A group whose `ome.well.images` list is present but empty yields no tiles;
    /// it must be skipped with a warning, exactly like a missing list, instead of
    /// becoming a silent orphan group with no images.
    #[tokio::test]
    async fn empty_images_group_is_skipped_with_warning() {
        let dir = temp_dir("empty_images_group");
        create_collection_fixture(
            &dir,
            "empty_images_collection",
            &["A", "B"],
            &["1"],
            &[("A", "1", 0, 0, 0), ("B", "1", 1, 0, 1)],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 128, 128],
            1,
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "empty-id", "Empty Images Collection")
            .await
            .unwrap();

        // The empty-images group is skipped with a warning naming it.
        let skip_warnings: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::SkippedGroup && w.target == "A/1")
            .collect();
        assert_eq!(
            skip_warnings.len(),
            1,
            "empty-images group should be skipped with a warning, got {:?}",
            result.warnings,
        );
        assert!(
            skip_warnings[0].message.contains("empty"),
            "message should explain the list is empty, got {:?}",
            skip_warnings[0].message,
        );

        // Only the non-empty group becomes a group entity — no silent orphan.
        let groups: Vec<_> = result
            .manifest
            .entities()
            .iter()
            .filter(|e| e.kind == EntityKind::Group)
            .collect();
        assert_eq!(
            groups.len(),
            1,
            "empty group must not become an orphan entity"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn import_collection_with_explicit_positions() {
        let dir = temp_dir("import_collection_explicit");
        fs::create_dir_all(&dir).unwrap();

        // Build collection root with explicit translations on the tiles.
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "plate": {
                        "version": "0.5",
                        "name": "explicit_collection",
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

        // Group with explicitly-positioned tiles.
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
        let result = import_dataset(&store, "explicit-id", "Explicit Collection")
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

        // Transforms should reflect normalized explicit positions.
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

    /// Build a single-group explicitly-positioned collection fixture.
    ///
    /// `translations[i]` is written verbatim as the tile's
    /// `coordinateTransformations.translation` (5-element TCZYX). Pass `None`
    /// to omit the entry, producing a derived-positioned group.
    /// `scale` is the level-0 [T, C, Z, Y, X] scale; pass `None` to omit the
    /// `scale` coordinate transform entirely (so default scale of 1.0 applies).
    fn create_explicit_collection_fixture(
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

    /// Explicit translations stored in physical units must be converted to voxel
    /// units before forming the tile->group transform.
    /// tile 0 at (0, 0); tile 1 at (100 µm, 200 µm). With Y/X scale of
    /// 0.5 µm/voxel the second tile ends up at (200, 400) voxels.
    #[tokio::test]
    async fn explicit_translations_normalized_to_voxel_units() {
        let dir = temp_dir("explicit_translations_voxel_units");
        // Translations are TCZYX. The test puts X=100 µm, Y=200 µm on tile 1.
        let translations = vec![
            Some([0.0, 0.0, 0.0, 0.0, 0.0]),
            Some([0.0, 0.0, 0.0, 200.0, 100.0]),
        ];
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.5]);
        create_explicit_collection_fixture(&dir, &translations, scale);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "explicit-vox", "Explicit Voxel")
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
        let t0 = find_tile_transform(&result, "explicit-vox", 0);
        assert!(
            (t0.transform.matrix()[12]).abs() < 1e-9,
            "tile 0 tx should be 0"
        );
        assert!(
            (t0.transform.matrix()[13]).abs() < 1e-9,
            "tile 0 ty should be 0"
        );

        // tile 1: 100 µm / 0.5 = 200 voxels in X, 200 µm / 0.5 = 400 voxels in Y.
        let t1 = find_tile_transform(&result, "explicit-vox", 1);
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

    /// Derived-positioned collections (no translations) must be unaffected by the
    /// scale-conversion code path.
    #[tokio::test]
    async fn grid_collections_unaffected() {
        let dir = temp_dir("grid_collections_unaffected");
        // Two tiles, neither with a translation -> derived-positioned collection.
        let translations = vec![None, None];
        // Choose a non-trivial scale so the wrong code path would be visible.
        let scale = Some([1.0, 1.0, 1.0, 0.5, 0.5]);
        create_explicit_collection_fixture(&dir, &translations, scale);

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
    /// default scale is 1.0 (per parse.rs), so explicit translations should pass
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
        create_explicit_collection_fixture(&dir, &translations, None);

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
        create_explicit_collection_fixture(&dir, &translations, scale);

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

    /// Create a 7-axis fixture whose OME attributes use the 0.4-style
    /// top-level placement (`attributes.multiscales`) inside a Zarr **v3**
    /// group, rather than the 0.5 `attributes.ome.multiscales` namespace.
    /// Mirrors the metadata shape of a real store that previously failed to
    /// open (two non-canonical axes, two levels, an `omero` block).
    fn create_7d_top_level_placement_fixture(dir: &std::path::Path) {
        fs::create_dir_all(dir).unwrap();

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "multiscales": [{
                    "version": "0.4",
                    "name": "sample",
                    "axes": [
                        {"name": "m", "type": "space", "unit": "position"},
                        {"name": "p", "type": "space", "unit": "site"},
                        {"name": "t", "type": "time"},
                        {"name": "z", "type": "space"},
                        {"name": "c", "type": "channel"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [
                        {
                            "path": "0",
                            "coordinateTransformations": [{
                                "type": "scale",
                                "scale": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
                            }]
                        },
                        {
                            "path": "1",
                            "coordinateTransformations": [{
                                "type": "scale",
                                "scale": [1.0, 1.0, 1.0, 1.0, 1.0, 8.0, 8.0]
                            }]
                        }
                    ]
                }],
                "omero": {
                    "channels": [
                        {"label": "Ch A", "active": true},
                        {"label": "Ch B", "active": true}
                    ]
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        // [m, p, t, z, c, y, x] at both levels; y/x are 8x coarser at level 1.
        let levels: [(&str, [u64; 7], [u64; 7]); 2] = [
            (
                "0",
                [24, 9, 448, 3, 2, 2048, 2048],
                [1, 9, 16, 3, 1, 2048, 2048],
            ),
            (
                "1",
                [24, 9, 448, 3, 2, 256, 256],
                [24, 1, 1, 3, 1, 256, 256],
            ),
        ];
        for (path, shape, chunk) in levels {
            let level_dir = dir.join(path);
            fs::create_dir_all(&level_dir).unwrap();
            let arr = serde_json::json!({
                "zarr_format": 3,
                "node_type": "array",
                "shape": shape,
                "data_type": "uint16",
                "chunk_grid": {
                    "name": "regular",
                    "configuration": { "chunk_shape": chunk }
                },
                "codecs": [
                    {"name": "bytes", "configuration": {"endian": "little"}},
                    {"name": "zstd", "configuration": {"level": 3, "checksum": false}}
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

    /// End-to-end regression for a Zarr v3 store carrying the OME-Zarr
    /// 0.4-style top-level attribute placement. It must import exactly as the
    /// namespaced 0.5 form does: canonical 5D axes, both non-canonical axes
    /// pinned, omero labels picked up, and per-level chunk byte layouts
    /// computed from the raw 7-axis order.
    #[tokio::test]
    async fn import_reads_top_level_ome_attribute_placement() {
        let dir = temp_dir("import_top_level_placement");
        create_7d_top_level_placement_fixture(&dir);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "placement-test", "Placement Test")
            .await
            .unwrap();

        assert!(matches!(result.manifest.kind, DatasetKind::Single));
        let multiscale = &result.manifest.images()[0].multiscale;

        // Canonical axes keep the source's declared order (here z precedes c);
        // shapes and scales are mapped by name, so this list is descriptive,
        // never a positional index into the 5D arrays.
        let names: Vec<&str> = multiscale.axes.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["t", "z", "c", "y", "x"]);
        assert_eq!(
            multiscale.pinned_axes,
            vec![
                PinnedAxis {
                    name: "m".to_string(),
                    size: 24,
                    pinned_index: 0,
                },
                PinnedAxis {
                    name: "p".to_string(),
                    size: 9,
                    pinned_index: 0,
                },
            ],
        );

        // Both declared levels survive, normalized to canonical 5D.
        assert_eq!(multiscale.levels.len(), 2);
        assert_eq!(multiscale.levels[0].shape, [448, 2, 3, 2048, 2048]);
        assert_eq!(multiscale.levels[1].shape, [448, 2, 3, 256, 256]);

        // The `omero` block is read from the same top-level placement.
        let labels: Vec<&str> = multiscale
            .channel_infos
            .iter()
            .map(|c| c.label.as_str())
            .collect();
        assert_eq!(labels, vec!["Ch A", "Ch B"]);

        // Raw axes order is preserved for the chunk-path resolver, and the
        // level-1 layout slices the m=24 bundle down to one canonical chunk.
        let seed = &result.binding_seed.images[0];
        assert_eq!(seed.axes_names, vec!["m", "p", "t", "z", "c", "y", "x"]);
        let level1 = seed
            .levels
            .iter()
            .find(|l| l.level_index == 1)
            .expect("level 1 binding");
        assert_eq!(
            level1.chunk_byte_layout.canonical_byte_size,
            3 * 256 * 256 * 2
        );
        assert_eq!(
            level1.chunk_byte_layout.on_disk_byte_size,
            24 * 3 * 256 * 256 * 2
        );

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

    /// Write a `labels/zarr.json` whose bytes are not valid JSON into an
    /// existing image or tile directory.
    fn write_corrupt_labels_index(group_dir: &std::path::Path) {
        let labels_dir = group_dir.join("labels");
        fs::create_dir_all(&labels_dir).unwrap();
        fs::write(labels_dir.join("zarr.json"), b"{ this is not json").unwrap();
    }

    /// Write a `labels/zarr.json` that parses as JSON but carries no
    /// `attributes.ome.labels` names at all.
    fn write_nameless_labels_index(group_dir: &std::path::Path) {
        let labels_dir = group_dir.join("labels");
        fs::create_dir_all(&labels_dir).unwrap();
        let json = serde_json::json!({"zarr_format": 3, "node_type": "group"});
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

    /// An [`ObjectStore`] decorator that records the location of every read
    /// operation it serves — GET (and HEAD, which routes through `get_opts`)
    /// plus LIST — and delegates all work to an inner store. Lets a test
    /// observe exactly which objects the importer reads and how many read
    /// round-trips an import costs. When `fail_get_when` is set, GETs whose
    /// location satisfies the predicate fail with a non-NotFound storage
    /// error (still recorded), simulating a store-wide condition such as
    /// throttling or a permission setup that turns missing keys into errors.
    #[derive(Debug)]
    struct RecordingStore {
        inner: Arc<dyn ObjectStore>,
        reads: Arc<std::sync::Mutex<Vec<String>>>,
        fail_get_when: Option<fn(&str) -> bool>,
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
            let location_str = location.to_string();
            self.reads.lock().unwrap().push(location_str.clone());
            if let Some(should_fail) = self.fail_get_when
                && should_fail(&location_str)
            {
                return Err(object_store::Error::Generic {
                    store: "test",
                    source: format!("simulated storage error reading {location_str}").into(),
                });
            }
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
            self.reads.lock().unwrap().push(format!(
                "list:{}",
                prefix.map(Path::to_string).unwrap_or_default()
            ));
            self.inner.list(prefix)
        }

        async fn list_with_delimiter(
            &self,
            prefix: Option<&Path>,
        ) -> object_store::Result<object_store::ListResult> {
            self.reads.lock().unwrap().push(format!(
                "list:{}",
                prefix.map(Path::to_string).unwrap_or_default()
            ));
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

        let reads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let store: Arc<dyn ObjectStore> = Arc::new(RecordingStore {
            inner: crate::backend::open(dir.to_str().unwrap()).unwrap(),
            reads: reads.clone(),
            fail_get_when: None,
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
        let reads = reads.lock().unwrap();
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

    /// Wrap a local fixture directory in a [`RecordingStore`], returning the
    /// store and the shared read log.
    fn recording_store(
        dir: &std::path::Path,
    ) -> (Arc<dyn ObjectStore>, Arc<std::sync::Mutex<Vec<String>>>) {
        let reads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let store: Arc<dyn ObjectStore> = Arc::new(RecordingStore {
            inner: crate::backend::open(dir.to_str().unwrap()).unwrap(),
            reads: reads.clone(),
            fail_get_when: None,
        });
        (store, reads)
    }

    /// Like [`recording_store`], but every GET of a `labels/zarr.json` index
    /// fails with a non-NotFound storage error, simulating a store on which
    /// label-index reads error store-wide (throttling, permissions masking
    /// NotFound, timeouts). The failed reads are still recorded.
    fn label_read_erroring_store(
        dir: &std::path::Path,
    ) -> (Arc<dyn ObjectStore>, Arc<std::sync::Mutex<Vec<String>>>) {
        let reads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let store: Arc<dyn ObjectStore> = Arc::new(RecordingStore {
            inner: crate::backend::open(dir.to_str().unwrap()).unwrap(),
            reads: reads.clone(),
            fail_get_when: Some(|location| location.ends_with("labels/zarr.json")),
        });
        (store, reads)
    }

    /// Like [`recording_store`], but every GET of a tile's own multiscale
    /// metadata (`group/column/tile/zarr.json`) fails with a non-NotFound
    /// storage error, simulating a store on which tile-geometry reads error
    /// store-wide. Group and root metadata sit shallower (fewer path
    /// separators) and still read cleanly, so groups parse while no tile's
    /// geometry can be read. The failed reads are still recorded.
    fn tile_geometry_read_erroring_store(
        dir: &std::path::Path,
    ) -> (Arc<dyn ObjectStore>, Arc<std::sync::Mutex<Vec<String>>>) {
        let reads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let store: Arc<dyn ObjectStore> = Arc::new(RecordingStore {
            inner: crate::backend::open(dir.to_str().unwrap()).unwrap(),
            reads: reads.clone(),
            fail_get_when: Some(|location| {
                location.ends_with("/zarr.json") && location.matches('/').count() == 3
            }),
        });
        (store, reads)
    }

    /// Count the recorded tile-geometry metadata reads
    /// (`group/column/tile/zarr.json`), which the geometry search must keep
    /// bounded by the group count rather than the total tile count.
    fn count_tile_geometry_reads(reads: &std::sync::Mutex<Vec<String>>) -> usize {
        reads
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.ends_with("/zarr.json") && path.matches('/').count() == 3)
            .count()
    }

    /// Count the recorded label-index probe reads (`.../labels/zarr.json`).
    fn count_label_probes(reads: &std::sync::Mutex<Vec<String>>) -> usize {
        reads
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.ends_with("labels/zarr.json"))
            .count()
    }

    #[test]
    fn exhaustive_probe_decision_boundary_and_override() {
        // Single-group collection: two samples (first + last tile). Sampling
        // engages only once it skips at least
        // LABEL_PROBE_SAMPLING_MIN_SKIPPED tiles.
        let samples = 2;
        // One tile short of the minimum savings: exhaustive.
        assert!(use_exhaustive_label_probes(
            samples + LABEL_PROBE_SAMPLING_MIN_SKIPPED - 1,
            samples,
            false
        ));
        // Exactly the minimum savings: sampling engages.
        assert!(!use_exhaustive_label_probes(
            samples + LABEL_PROBE_SAMPLING_MIN_SKIPPED,
            samples,
            false
        ));
        // A sample that already covers every tile (many one- and two-tile
        // groups) is exhaustive by construction, at any collection width.
        assert!(use_exhaustive_label_probes(500, 500, false));
        // The operator override restores exhaustive probing at any size.
        assert!(use_exhaustive_label_probes(10_000, 4, true));
    }

    #[test]
    fn sample_indices_cover_each_groups_first_and_last_tile() {
        // Groups of 1, 3, 0, and 5 tiles: single-tile groups contribute one
        // index (no duplicate), empty groups contribute none.
        let spans = vec![0..1, 1..4, 4..4, 4..9];
        assert_eq!(sample_probe_indices(&spans), vec![0, 1, 3, 4, 8]);
    }

    /// A label-free collection wide enough for sampled discovery imports
    /// with metadata read traffic proportional to its GROUPS, never one read
    /// per tile: 6 groups x 60 tiles = 360 tiles must cost on the order of
    /// dozens of reads (root + one per group + the representative tile's
    /// template + two label samples per group). The bounded discovery is
    /// surfaced as a warning naming the exhaustive override.
    #[tokio::test]
    async fn label_free_wide_collection_reads_scale_with_groups() {
        let dir = temp_dir("wide_label_free");
        create_collection_fixture(
            &dir,
            "wide",
            &["A", "B", "C"],
            &["1", "2"],
            &[
                ("A", "1", 0, 0, 60),
                ("A", "2", 0, 1, 60),
                ("B", "1", 1, 0, 60),
                ("B", "2", 1, 1, 60),
                ("C", "1", 2, 0, 60),
                ("C", "2", 2, 1, 60),
            ],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "wide-id", "Wide", false)
            .await
            .unwrap();

        assert_eq!(result.manifest.images().len(), 360, "one image per tile");
        assert!(result.manifest.labels().is_empty());

        let reads = reads.lock().unwrap();
        // Label probes: exactly two per group (first + last tile), never one
        // per tile.
        let label_probes = reads
            .iter()
            .filter(|p| p.ends_with("labels/zarr.json"))
            .count();
        assert_eq!(
            label_probes, 12,
            "expected 2 label probes per group (6 groups), got {label_probes}",
        );
        // Total metadata reads track structure (root + 6 group metas + the
        // representative tile and its level + 12 label samples ≈ 21), never
        // the 360 tiles.
        println!("metadata reads for 6x60 collection: {}", reads.len());
        assert!(
            reads.len() <= 40,
            "expected dozens of metadata reads for a 360-tile collection, got {}",
            reads.len(),
        );
        drop(reads);

        // Bounded discovery is announced, with the escape hatch named.
        let sampled: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::SampledLabelDiscovery)
            .collect();
        assert_eq!(sampled.len(), 1, "warnings: {:?}", result.warnings);
        assert!(
            sampled[0].message.contains(EXHAUSTIVE_LABEL_DISCOVERY_ENV),
            "warning must name the override: {:?}",
            sampled[0].message,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Under sampled discovery, a group whose sampled tile carries labels is
    /// expanded to a full per-tile probe, so every labeled tile of that group
    /// is discovered — including interior ones the sample missed — while the
    /// label-free sibling group still costs only its two samples.
    #[tokio::test]
    async fn sampled_discovery_expands_labeled_group_and_finds_all_labels() {
        let dir = temp_dir("sampled_labeled_group");
        create_collection_fixture(
            &dir,
            "p",
            &["A"],
            &["1", "2"],
            &[("A", "1", 0, 0, 40), ("A", "2", 0, 1, 40)],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        // Label three tiles of A/1: the sampled first tile plus an interior
        // one and the last one.
        for tile in ["0", "17", "39"] {
            let tile_dir = dir.join("A").join("1").join(tile);
            write_labels_index(&tile_dir, &["mask"]);
            write_label_multiscale(
                &tile_dir,
                "mask",
                &["t", "z", "y", "x"],
                &[1, 1, 16, 16],
                &[1, 1, 16, 16],
                &[1.0, 1.0, 1.0, 1.0],
                "uint32",
                serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
            );
        }

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "pl", "Partially Labeled", false)
            .await
            .unwrap();

        // All three labels found, attached to the right tile images.
        let mut sources: Vec<String> = result
            .manifest
            .labels()
            .iter()
            .map(|l| l.source_image_id.0.clone())
            .collect();
        sources.sort();
        assert_eq!(
            sources,
            vec![
                "pl:image:A/1/0".to_string(),
                "pl:image:A/1/17".to_string(),
                "pl:image:A/1/39".to_string(),
            ],
        );

        // Probe cost: the labeled group is probed in full (40), the
        // label-free group costs only its two samples.
        let reads = reads.lock().unwrap();
        let a1 = reads
            .iter()
            .filter(|p| p.starts_with("A/1/") && p.ends_with("labels/zarr.json"))
            .count();
        let a2 = reads
            .iter()
            .filter(|p| p.starts_with("A/2/") && p.ends_with("labels/zarr.json"))
            .count();
        assert_eq!(a1, 40, "labeled group must be probed exhaustively");
        assert_eq!(a2, 2, "label-free group must cost only its samples");
        drop(reads);

        // A/2's interior tiles went unprobed, so the discovery-bounded
        // warning still stands.
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::SampledLabelDiscovery),
            "warnings: {:?}",
            result.warnings,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Small collections keep exhaustive discovery: a label present only on an
    /// interior tile (index 2 of 4 — neither a first- nor a last-tile sample
    /// position) of a single-group collection is still discovered, with no
    /// bounded-discovery warning.
    #[tokio::test]
    async fn small_collection_interior_label_is_discovered_exhaustively() {
        let dir = temp_dir("small_sparse_label");
        create_collection_fixture(
            &dir,
            "s",
            &["A"],
            &["1"],
            &[("A", "1", 0, 0, 4)],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        let tile_dir = dir.join("A").join("1").join("2");
        write_labels_index(&tile_dir, &["mask"]);
        write_label_multiscale(
            &tile_dir,
            "mask",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint16",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "small", "Small").await.unwrap();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1, "the interior tile's label must be found");
        assert_eq!(
            labels[0].source_image_id,
            ImageId("small:image:A/1/2".to_string()),
        );
        assert!(
            result.warnings.is_empty(),
            "exhaustive discovery must not warn: {:?}",
            result.warnings,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Build a two-group collection (2 x 40 tiles — wide enough that sampled
    /// discovery engages) whose only label sits on the interior tile
    /// `A/1/17`, a position first/last-tile sampling never probes directly.
    fn two_group_fixture_with_interior_label(dir: &std::path::Path) {
        create_collection_fixture(
            dir,
            "p",
            &["A"],
            &["1", "2"],
            &[("A", "1", 0, 0, 40), ("A", "2", 0, 1, 40)],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        let tile_dir = dir.join("A").join("1").join("17");
        write_labels_index(&tile_dir, &["mask"]);
        write_label_multiscale(
            &tile_dir,
            "mask",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );
    }

    /// The exhaustive override, passed down from the entry point, reaches
    /// collection discovery: with it, an interior-only label of a collection
    /// wide enough for sampling is still found, every tile's index is
    /// probed, and no bounded-discovery warning is recorded.
    #[tokio::test]
    async fn forced_exhaustive_discovery_finds_interior_label_without_warning() {
        let dir = temp_dir("forced_exhaustive_interior");
        two_group_fixture_with_interior_label(&dir);

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "fx", "Forced", true)
            .await
            .unwrap();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1, "labels: {labels:?}");
        assert_eq!(
            labels[0].source_image_id,
            ImageId("fx:image:A/1/17".to_string()),
        );
        assert!(
            !result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::SampledLabelDiscovery),
            "exhaustive discovery must not record a sampling warning: {:?}",
            result.warnings,
        );

        // Decisive: every tile's labels index was probed (80 of 80).
        let reads = reads.lock().unwrap();
        let probes = reads
            .iter()
            .filter(|p| p.ends_with("labels/zarr.json"))
            .count();
        assert_eq!(probes, 80, "expected one index probe per tile");
        drop(reads);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A labels index that EXISTS on both of a group's sampled tiles but is
    /// unusable (corrupt JSON) marks the group label-suspect: the group is
    /// probed in full, so its interior label is still discovered, while a
    /// sibling group with clean misses costs only its two samples.
    #[tokio::test]
    async fn corrupt_sampled_labels_index_expands_group_and_finds_interior_label() {
        let dir = temp_dir("corrupt_sampled_index");
        two_group_fixture_with_interior_label(&dir);
        write_corrupt_labels_index(&dir.join("A").join("1").join("0"));
        write_corrupt_labels_index(&dir.join("A").join("1").join("39"));

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "cx", "Corrupt Endpoints", false)
            .await
            .unwrap();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1, "labels: {labels:?}");
        assert_eq!(
            labels[0].source_image_id,
            ImageId("cx:image:A/1/17".to_string()),
        );

        let reads = reads.lock().unwrap();
        let a1 = reads
            .iter()
            .filter(|p| p.starts_with("A/1/") && p.ends_with("labels/zarr.json"))
            .count();
        let a2 = reads
            .iter()
            .filter(|p| p.starts_with("A/2/") && p.ends_with("labels/zarr.json"))
            .count();
        assert_eq!(a1, 40, "suspect group must be probed exhaustively");
        assert_eq!(a2, 2, "clean-miss group must cost only its samples");
        drop(reads);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Same expansion when the sampled tiles' labels index parses as JSON but
    /// declares no usable names: the anomaly still expands the group, so the
    /// interior label is discovered.
    #[tokio::test]
    async fn nameless_sampled_labels_index_expands_group_and_finds_interior_label() {
        let dir = temp_dir("nameless_sampled_index");
        two_group_fixture_with_interior_label(&dir);
        write_nameless_labels_index(&dir.join("A").join("1").join("0"));
        write_nameless_labels_index(&dir.join("A").join("1").join("39"));

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset_with_label_discovery(&store, "nx", "Nameless Endpoints", false)
            .await
            .unwrap();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1, "labels: {labels:?}");
        assert_eq!(
            labels[0].source_image_id,
            ImageId("nx:image:A/1/17".to_string()),
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Build a label-free wide collection of `rows.len() * columns.len()`
    /// groups with `tiles_per_group` tiles each (single level, tiny shapes).
    fn wide_label_free_fixture(
        dir: &std::path::Path,
        rows: &[&str],
        columns: &[&str],
        tiles_per_group: u32,
    ) {
        let mut groups: Vec<(&str, &str, u32, u32, u32)> = Vec::new();
        for (ri, row) in rows.iter().enumerate() {
            for (ci, column) in columns.iter().enumerate() {
                groups.push((row, column, ri as u32, ci as u32, tiles_per_group));
            }
        }
        create_collection_fixture(
            dir,
            "wide",
            rows,
            columns,
            &groups,
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
    }

    /// Store-wide label-index read errors must not re-open the per-tile
    /// fan-out: with every `labels/zarr.json` GET failing (non-NotFound) on a
    /// 24-group x 20-tile collection, the import still succeeds, expansion of
    /// anomaly-flagged groups is capped at [`MAX_UNUSABLE_GROUP_EXPANSIONS`],
    /// total label reads stay far below one per tile, and the anomaly is
    /// surfaced as ONE aggregated warning naming the likely store-side causes
    /// and the exhaustive override.
    #[tokio::test]
    async fn store_wide_label_read_errors_are_capped_and_warned() {
        let dir = temp_dir("store_wide_label_errors");
        wide_label_free_fixture(
            &dir,
            &["A", "B", "C", "D"],
            &["1", "2", "3", "4", "5", "6"],
            20,
        );

        let (store, reads) = label_read_erroring_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "err-id", "Erroring", false)
            .await
            .expect("store-wide label-read errors must never fail the import");

        assert_eq!(result.manifest.images().len(), 480, "one image per tile");
        assert!(result.manifest.labels().is_empty());

        // Read bound: two samples per group (48) plus at most
        // MAX_UNUSABLE_GROUP_EXPANSIONS expanded groups (18 remaining tiles
        // each) — never the 480-read per-tile fan-out.
        let label_probes = count_label_probes(&reads);
        assert_eq!(
            label_probes,
            48 + 18 * MAX_UNUSABLE_GROUP_EXPANSIONS,
            "expansion must be capped under store-wide probe errors",
        );
        assert!(label_probes <= 200, "got {label_probes} label reads");

        // Exactly one aggregated unusable-index warning — never one per tile.
        let unusable: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnusableLabelIndex)
            .collect();
        assert_eq!(unusable.len(), 1, "warnings: {:?}", result.warnings);
        let message = &unusable[0].message;
        assert!(message.contains("could not be read"), "{message}");
        assert!(message.contains("incomplete"), "{message}");
        assert!(message.contains("permission"), "{message}");
        assert!(message.contains("throttling"), "{message}");
        assert!(
            message.contains(EXHAUSTIVE_LABEL_DISCOVERY_ENV),
            "{message}"
        );
        // Every probed index errored, and the count reaches the message.
        assert!(
            message.contains(&label_probes.to_string()),
            "expected the unusable count {label_probes} in: {message}",
        );

        // The unexpanded groups' tiles went unprobed, so the sampling warning
        // fires alongside the anomaly warning rather than being masked by it.
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::SampledLabelDiscovery),
            "warnings: {:?}",
            result.warnings,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The nameless-everywhere variant of a store-wide anomaly: every tile
    /// carries a labels index that parses but lists no usable names. Same
    /// contract — capped expansion, one aggregated warning, import succeeds.
    #[tokio::test]
    async fn nameless_indexes_everywhere_are_capped_and_warned() {
        let dir = temp_dir("nameless_everywhere");
        let rows = ["A", "B"];
        let columns = ["1", "2", "3"];
        wide_label_free_fixture(&dir, &rows, &columns, 20);
        for row in rows {
            for column in columns {
                for tile in 0..20 {
                    write_nameless_labels_index(&dir.join(row).join(column).join(tile.to_string()));
                }
            }
        }

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "nl-id", "Nameless", false)
            .await
            .unwrap();

        assert!(result.manifest.labels().is_empty());

        // 6 groups x 2 samples, then the cap: only
        // MAX_UNUSABLE_GROUP_EXPANSIONS of the 6 anomaly-flagged groups
        // expand (18 remaining tiles each).
        let label_probes = count_label_probes(&reads);
        assert_eq!(label_probes, 12 + 18 * MAX_UNUSABLE_GROUP_EXPANSIONS);

        let unusable: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnusableLabelIndex)
            .collect();
        assert_eq!(unusable.len(), 1, "warnings: {:?}", result.warnings);
        assert!(
            unusable[0].message.contains(EXHAUSTIVE_LABEL_DISCOVERY_ENV),
            "{}",
            unusable[0].message,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The expansion cap applies only to anomaly-triggered expansion: groups
    /// whose sampled index actually LISTS names are all expanded, even when
    /// there are more of them than [`MAX_UNUSABLE_GROUP_EXPANSIONS`], because
    /// listed names are real labels, not a suspicion.
    #[tokio::test]
    async fn listed_group_expansion_is_not_capped() {
        let dir = temp_dir("listed_uncapped");
        let rows = ["A", "B"];
        let columns = ["1", "2", "3"];
        wide_label_free_fixture(&dir, &rows, &columns, 20);
        // 6 labeled groups (> the anomaly cap), label on each group's first
        // tile so the sample sees a Listed index.
        for row in rows {
            for column in columns {
                let tile_dir = dir.join(row).join(column).join("0");
                write_labels_index(&tile_dir, &["mask"]);
                write_label_multiscale(
                    &tile_dir,
                    "mask",
                    &["t", "z", "y", "x"],
                    &[1, 1, 16, 16],
                    &[1, 1, 16, 16],
                    &[1.0, 1.0, 1.0, 1.0],
                    "uint16",
                    serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
                );
            }
        }

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "lu-id", "Listed", false)
            .await
            .unwrap();

        // Every group's label was found: no cap applied.
        assert_eq!(result.manifest.labels().len(), 6);
        // All 6 groups expanded in full: 12 samples + 6 x 18 remaining tiles.
        assert_eq!(count_label_probes(&reads), 12 + 6 * 18);
        // Nothing was unusable, so no anomaly warning.
        assert!(
            !result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::UnusableLabelIndex),
            "warnings: {:?}",
            result.warnings,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A group whose samples already cover all of its tiles expands nothing,
    /// so an unusable index there must not consume an expansion slot: four
    /// two-tile all-corrupt groups declared first leave the whole allowance
    /// for a later 40-tile group with corrupt sampled endpoints, whose
    /// interior label is therefore still discovered.
    #[tokio::test]
    async fn fully_sampled_unusable_groups_do_not_consume_expansion_allowance() {
        let dir = temp_dir("fully_sampled_unusable_free");
        let mut groups: Vec<(&str, &str, u32, u32, u32)> = Vec::new();
        // MAX_UNUSABLE_GROUP_EXPANSIONS two-tile groups whose samples (first
        // and last tile) are the whole group: expanding them adds no reads.
        for (ci, column) in ["1", "2", "3", "4"].iter().enumerate() {
            groups.push(("A", column, 0, ci as u32, 2));
        }
        // Label-free filler wide enough that sampled discovery engages.
        groups.push(("B", "1", 1, 0, 40));
        groups.push(("B", "2", 1, 1, 40));
        // The group that needs the allowance, declared last.
        groups.push(("Z", "1", 2, 0, 40));
        create_collection_fixture(
            &dir,
            "fs",
            &["A", "B", "Z"],
            &["1", "2", "3", "4"],
            &groups,
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        for column in ["1", "2", "3", "4"] {
            for tile in ["0", "1"] {
                write_corrupt_labels_index(&dir.join("A").join(column).join(tile));
            }
        }
        write_corrupt_labels_index(&dir.join("Z").join("1").join("0"));
        write_corrupt_labels_index(&dir.join("Z").join("1").join("39"));
        let tile_dir = dir.join("Z").join("1").join("20");
        write_labels_index(&tile_dir, &["mask"]);
        write_label_multiscale(
            &tile_dir,
            "mask",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "fs-id", "Fully Sampled", false)
            .await
            .unwrap();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1, "labels: {labels:?}");
        assert_eq!(
            labels[0].source_image_id,
            ImageId("fs-id:image:Z/1/20".to_string()),
        );

        // 14 samples (4 x 2 + 2 x 2 + 2) plus Z/1's 38 remaining tiles; the
        // two-tile groups added no follow-up reads.
        assert_eq!(count_label_probes(&reads), 14 + 38);

        // The fully-sampled groups' unusable indexes still reach the
        // aggregated warning (8 of them, plus Z/1's two endpoints).
        let unusable: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnusableLabelIndex)
            .collect();
        assert_eq!(unusable.len(), 1, "warnings: {:?}", result.warnings);
        assert!(
            unusable[0].message.starts_with("10 label indexes"),
            "{}",
            unusable[0].message,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Mixed costs: fully-sampled all-corrupt groups alongside large
    /// corrupt-endpoint groups. Only the large groups' expansions add reads,
    /// so only they are charged, and a later large group with an interior
    /// label still fits within the allowance.
    #[tokio::test]
    async fn only_expansions_that_add_reads_are_charged_against_the_cap() {
        let dir = temp_dir("mixed_cost_expansions");
        let groups: Vec<(&str, &str, u32, u32, u32)> = vec![
            // Two zero-cost groups: two tiles each, both corrupt.
            ("A", "1", 0, 0, 2),
            ("A", "2", 0, 1, 2),
            // Two costly label-free groups with corrupt sampled endpoints.
            ("B", "1", 1, 0, 40),
            ("B", "2", 1, 1, 40),
            // The recoverable group, declared last.
            ("Z", "1", 2, 0, 40),
        ];
        create_collection_fixture(
            &dir,
            "mx",
            &["A", "B", "Z"],
            &["1", "2"],
            &groups,
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        for column in ["1", "2"] {
            for tile in ["0", "1"] {
                write_corrupt_labels_index(&dir.join("A").join(column).join(tile));
            }
            for tile in ["0", "39"] {
                write_corrupt_labels_index(&dir.join("B").join(column).join(tile));
            }
        }
        write_corrupt_labels_index(&dir.join("Z").join("1").join("0"));
        write_corrupt_labels_index(&dir.join("Z").join("1").join("39"));
        let tile_dir = dir.join("Z").join("1").join("20");
        write_labels_index(&tile_dir, &["mask"]);
        write_label_multiscale(
            &tile_dir,
            "mask",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "mx-id", "Mixed Cost", false)
            .await
            .unwrap();

        let labels = result.manifest.labels();
        assert_eq!(labels.len(), 1, "labels: {labels:?}");
        assert_eq!(
            labels[0].source_image_id,
            ImageId("mx-id:image:Z/1/20".to_string()),
        );

        // 10 samples plus three 38-tile expansions (B/1, B/2, Z/1): three
        // charged slots, still within MAX_UNUSABLE_GROUP_EXPANSIONS.
        assert_eq!(count_label_probes(&reads), 10 + 3 * 38);

        let _ = fs::remove_dir_all(&dir);
    }

    /// The documented trade-off past the cap still holds: when the allowance
    /// is spent on expansions that DID add reads, a later costly group is
    /// left unexpanded and its interior label goes undiscovered, with both
    /// the anomaly and sampling warnings recorded.
    #[tokio::test]
    async fn costly_group_beyond_the_cap_stays_unexpanded() {
        let dir = temp_dir("beyond_cap_unexpanded");
        let columns = ["1", "2", "3", "4", "5"];
        let groups: Vec<(&str, &str, u32, u32, u32)> = columns
            .iter()
            .enumerate()
            .map(|(ci, column)| ("A", *column, 0, ci as u32, 40))
            .collect();
        create_collection_fixture(
            &dir,
            "bc",
            &["A"],
            &columns,
            &groups,
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        // Every group's sampled endpoints are corrupt, so each expansion adds
        // 38 reads and is charged; the fifth group arrives after the
        // allowance is spent.
        for column in columns {
            for tile in ["0", "39"] {
                write_corrupt_labels_index(&dir.join("A").join(column).join(tile));
            }
        }
        let tile_dir = dir.join("A").join("5").join("20");
        write_labels_index(&tile_dir, &["mask"]);
        write_label_multiscale(
            &tile_dir,
            "mask",
            &["t", "z", "y", "x"],
            &[1, 1, 16, 16],
            &[1, 1, 16, 16],
            &[1.0, 1.0, 1.0, 1.0],
            "uint32",
            serde_json::json!({"colors": [{"label-value": 1, "rgba": [1, 2, 3, 4]}]}),
        );

        let (store, reads) = recording_store(&dir);
        let result = import_dataset_with_label_discovery(&store, "bc-id", "Beyond Cap", false)
            .await
            .unwrap();

        assert!(
            result.manifest.labels().is_empty(),
            "a costly group past the cap is not expanded, so its interior \
             label stays undiscovered: {:?}",
            result.manifest.labels(),
        );
        assert_eq!(
            count_label_probes(&reads),
            10 + 38 * MAX_UNUSABLE_GROUP_EXPANSIONS,
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::UnusableLabelIndex),
            "warnings: {:?}",
            result.warnings,
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::SampledLabelDiscovery),
            "warnings: {:?}",
            result.warnings,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The exhaustive collection path (small collection, per-tile probing)
    /// surfaces an unusable index through the same aggregated warning, with
    /// no sampling warning attached.
    #[tokio::test]
    async fn exhaustive_collection_with_corrupt_index_warns() {
        let dir = temp_dir("exhaustive_corrupt_index");
        create_collection_fixture(
            &dir,
            "s",
            &["A"],
            &["1"],
            &[("A", "1", 0, 0, 3)],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
            1,
        );
        write_corrupt_labels_index(&dir.join("A").join("1").join("1"));

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "xc", "Exhaustive Corrupt")
            .await
            .expect("a corrupt labels index must not fail the import");

        assert!(result.manifest.labels().is_empty());
        let unusable: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnusableLabelIndex)
            .collect();
        assert_eq!(unusable.len(), 1, "warnings: {:?}", result.warnings);
        assert!(
            unusable[0].message.contains("A/1/1/labels"),
            "the example path should locate the bad index: {}",
            unusable[0].message,
        );
        assert!(
            !result
                .warnings
                .iter()
                .any(|w| w.kind == ImportWarningKind::SampledLabelDiscovery),
            "exhaustive probing must not add a sampling warning: {:?}",
            result.warnings,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A standalone image whose `labels/zarr.json` is corrupt still imports,
    /// and the anomaly reaches the result as the same aggregated warning the
    /// collection paths emit.
    #[tokio::test]
    async fn single_image_with_corrupt_index_warns() {
        let dir = temp_dir("single_corrupt_index");
        create_single_image_fixture(&dir, None);
        write_corrupt_labels_index(&dir);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = import_dataset(&store, "sc", "Single Corrupt")
            .await
            .expect("a corrupt labels index must not fail the import");

        assert_eq!(result.manifest.images().len(), 1);
        assert!(result.manifest.labels().is_empty());
        let unusable: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::UnusableLabelIndex)
            .collect();
        assert_eq!(unusable.len(), 1, "warnings: {:?}", result.warnings);
        let message = &unusable[0].message;
        assert!(message.contains("labels"), "{message}");
        assert!(message.contains("incomplete"), "{message}");
        assert!(message.contains("permission"), "{message}");
        assert!(message.contains("throttling"), "{message}");
        assert!(
            message.contains(EXHAUSTIVE_LABEL_DISCOVERY_ENV),
            "{message}"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
