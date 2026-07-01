//! Shared OME-Zarr parsing helpers.
//!
//! Low-level functions for reading and parsing Zarr v3 / OME-Zarr metadata
//! from an object store. Consumed by [`crate::import`].

use std::sync::Arc;

use object_store::path::Path;
use object_store::{GetOptions, GetRange, ObjectStore};
use serde::Deserialize;

use lucida_content::normalize::{normalize_f64_to_5d, normalize_to_5d};
use lucida_content::{ChannelInfo, LabelColor, LabelMeta, LabelProperty};

use crate::backend::StoreError;

/// Tight byte cap for the `labels/zarr.json` LIST read. That group only carries
/// the array of label group *names* (`attributes.ome.labels`), which is small
/// even for hundreds of labels, so we never need to grow this. Bounding it hard
/// keeps a hostile/corrupt list group from ballooning memory. A list larger
/// than this comes back truncated and simply parses to fewer names (or none).
pub(crate) const MAX_LABEL_LIST_BYTES: u64 = 4 * 1024 * 1024;

/// Initial byte cap for a label GROUP / LEVEL `zarr.json` read. A typical
/// label sidecar is well under this, so the common case is a single bounded
/// GET. When a legitimate large segmentation (e.g. tens of thousands of cells
/// with per-value `colors`/`properties`) pushes the group `zarr.json` past
/// this, the read comes back exactly this many bytes — a truncation signal —
/// and we retry unbounded up to [`MAX_LABEL_METADATA_BYTES`] rather than
/// silently dropping a valid group. See [`read_zarr_json_capped`].
pub(crate) const LABEL_METADATA_INITIAL_BYTES: u64 = 4 * 1024 * 1024;

/// Hard ceiling on a label GROUP / LEVEL `zarr.json` read. Untrusted metadata
/// never grows memory past this even on a truncation retry; a `zarr.json`
/// larger than this is treated as malformed and the group is skipped. Set high
/// enough that a real large-mask sidecar (a 55k-cell `image-label` block with
/// per-value colors + properties) fits comfortably, while still bounding a
/// hostile producer.
pub(crate) const MAX_LABEL_METADATA_BYTES: u64 = 64 * 1024 * 1024;

/// Cap on the number of label group names we will consider from a single
/// `labels/zarr.json`. Bounds work even if a producer lists an absurd count.
pub(crate) const MAX_LABEL_NAMES: usize = 1024;

/// Cap on `image-label.colors` / `image-label.properties` entries kept per
/// label group. Extra entries beyond the cap are dropped; malformed entries
/// within the cap are dropped individually.
pub(crate) const MAX_LABEL_ENTRIES: usize = 65_536;

/// Intermediate per-level metadata parsed from OME multiscales.
#[derive(Debug, Clone)]
pub struct LevelEntry {
    pub path: String,
    pub scale: [f64; 5], // [T, C, Z, Y, X]
}

/// Deserialized from a level's zarr.json.
#[derive(Debug, Deserialize)]
pub struct ArrayMeta {
    pub shape: Vec<u64>, // N-dimensional (matches axes count)
    pub data_type: String,
    pub chunk_grid: ChunkGrid,
    #[serde(default)]
    pub codecs: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGrid {
    pub configuration: ChunkGridConfig,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGridConfig {
    pub chunk_shape: Vec<u64>, // N-dimensional (matches axes count)
}

/// Read and parse a zarr.json file from the object store.
pub(crate) async fn read_zarr_json(
    store: &Arc<dyn ObjectStore>,
    path: &str,
) -> Result<serde_json::Value, StoreError> {
    let bytes = store.get(&Path::from(path)).await?.bytes().await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| StoreError::Metadata(format!("invalid JSON in {path}: {e}")))
}

/// Fetch at most `max_bytes` of an object, returning the (possibly truncated)
/// bytes WITHOUT parsing. `object_store`'s `Bounded(0..max_bytes)` range clamps
/// to the object length, so a smaller object returns in full and a larger one
/// returns exactly `max_bytes` bytes — that equality is the truncation signal
/// [`read_zarr_json_capped`] uses. This is metadata-only; no chunk bytes are
/// ever requested here.
async fn get_bytes_bounded(
    store: &Arc<dyn ObjectStore>,
    path: &str,
    max_bytes: u64,
) -> Result<bytes::Bytes, StoreError> {
    let opts = GetOptions {
        range: Some(GetRange::Bounded(0..max_bytes)),
        ..Default::default()
    };
    Ok(store
        .get_opts(&Path::from(path), opts)
        .await?
        .bytes()
        .await?)
}

/// Read and parse a `zarr.json` under a fixed byte cap.
///
/// Used for the tightly-bounded `labels/zarr.json` LIST read, where the object
/// only carries a small array of names. We fetch at most `max_bytes`; a larger
/// object comes back truncated and either parses to fewer names or fails to
/// parse (treated as "no labels" by the caller). This is metadata-only.
pub(crate) async fn read_zarr_json_bounded(
    store: &Arc<dyn ObjectStore>,
    path: &str,
    max_bytes: u64,
) -> Result<serde_json::Value, StoreError> {
    let bytes = get_bytes_bounded(store, path, max_bytes).await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| StoreError::Metadata(format!("invalid JSON in {path}: {e}")))
}

/// Read and parse a label GROUP / LEVEL `zarr.json`, keeping a legitimate large
/// sidecar rather than truncating it, while still bounding untrusted metadata.
///
/// Strategy: fetch an `initial_bytes`-bounded slice first (the common case, one
/// GET). If the response is *exactly* `initial_bytes`, the object was at least
/// that large and our slice is (almost certainly) truncated — invalid JSON we
/// must not skip a valid group over. In that case retry once with a
/// `hard_ceiling`-bounded slice, which admits real large masks (tens of
/// thousands of `colors`/`properties` entries) up to the ceiling. Only if THAT
/// response is also exactly `hard_ceiling` (i.e. the metadata genuinely exceeds
/// the ceiling) do we surface the resulting parse error so the caller skips the
/// group. A malformed `zarr.json` at any size fails to parse and is likewise
/// skipped. `initial_bytes` must be `<= hard_ceiling`. Metadata-only — no chunk
/// bytes are ever requested here.
pub(crate) async fn read_zarr_json_capped(
    store: &Arc<dyn ObjectStore>,
    path: &str,
    initial_bytes: u64,
    hard_ceiling: u64,
) -> Result<serde_json::Value, StoreError> {
    debug_assert!(initial_bytes <= hard_ceiling);

    let bytes = get_bytes_bounded(store, path, initial_bytes).await?;

    // Not truncated at the initial cap (or the two caps coincide) → parse now.
    if (bytes.len() as u64) < initial_bytes || initial_bytes >= hard_ceiling {
        return serde_json::from_slice(&bytes)
            .map_err(|e| StoreError::Metadata(format!("invalid JSON in {path}: {e}")));
    }

    // Suspected truncation: re-fetch up to the hard ceiling so a valid large
    // sidecar is KEPT. A response still at the ceiling means the metadata
    // exceeds it — the parse below fails and the caller skips the group.
    let full = get_bytes_bounded(store, path, hard_ceiling).await?;
    serde_json::from_slice(&full).map_err(|e| {
        if full.len() as u64 >= hard_ceiling {
            StoreError::Metadata(format!(
                "label metadata in {path} exceeds the {hard_ceiling}-byte ceiling"
            ))
        } else {
            StoreError::Metadata(format!("invalid JSON in {path}: {e}"))
        }
    })
}

/// Parse the ordered list of label group names from a `labels/zarr.json` value.
///
/// The list lives at `attributes.ome.labels` (an array of strings). GENERIC and
/// untrusted-input safe:
/// - A missing/`ome`-less/non-array `labels` yields an empty list (no labels).
/// - Non-string / blank entries are dropped; order of the remainder is kept.
/// - The list is truncated to [`MAX_LABEL_NAMES`] so a pathological producer
///   cannot make us enumerate an unbounded number of groups.
///
/// Returned names are the raw relative group names (e.g. `"nuclei"`); they are
/// used only to form store paths under `<base>/labels/<name>` and image ids.
pub(crate) fn parse_labels_list(labels_json: &serde_json::Value) -> Vec<String> {
    let Some(names) = labels_json
        .pointer("/attributes/ome/labels")
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    names
        .iter()
        .filter_map(|n| n.as_str().map(str::trim).filter(|s| is_safe_label_name(s)))
        .take(MAX_LABEL_NAMES)
        .map(str::to_string)
        .collect()
}

/// True for a label name that is safe to compose into a store path as a single
/// group segment. A valid OME-NGFF label group name is one path component, so
/// we reject anything empty, containing a path separator (`/` or `\`), a NUL,
/// or the traversal components `.`/`..`. This keeps a hostile `labels` list
/// from steering reads outside the `labels/<name>` subtree (belt-and-suspenders
/// on top of the store's prefix jail).
fn is_safe_label_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// Parse the OME `image-label` block of a label group's root `zarr.json` into a
/// [`LabelMeta`].
///
/// Returns `None` when `attributes.ome.image-label` is absent or not a JSON
/// object — that is the signal that a group under `labels/` is not actually a
/// label (the caller skips it). `name` is the owning `labels/` group name (a
/// single path segment) and is stored verbatim on [`LabelMeta::name`] so
/// downstream can show it. Everything *inside* a present block is OPTIONAL and
/// UNTRUSTED, so parsing never fails past that point:
/// - `colors`: entries must be objects with an integer `label-value` (fits u32)
///   and an `rgba` array of exactly 4 integers in `0..=255`; malformed entries
///   are dropped, and the kept list is capped at [`MAX_LABEL_ENTRIES`].
/// - `properties`: entries must be objects with an integer `label-value`; the
///   remaining keys are carried verbatim as an opaque map. Capped identically.
/// - `source.image`: carried through verbatim as an opaque relative string. It
///   is NEVER resolved, joined onto a path, or opened.
pub(crate) fn parse_image_label(root_json: &serde_json::Value, name: &str) -> Option<LabelMeta> {
    let block = root_json
        .pointer("/attributes/ome/image-label")
        .and_then(|v| v.as_object())?;

    let colors = block
        .get("colors")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(parse_label_color)
                .take(MAX_LABEL_ENTRIES)
                .collect()
        })
        .unwrap_or_default();

    let properties = block
        .get("properties")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(parse_label_property)
                .take(MAX_LABEL_ENTRIES)
                .collect()
        })
        .unwrap_or_default();

    let source_image = block
        .get("source")
        .and_then(|s| s.get("image"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Some(LabelMeta {
        name: name.to_string(),
        colors,
        properties,
        source_image,
    })
}

/// Parse one `image-label.colors` entry, or `None` if malformed.
fn parse_label_color(entry: &serde_json::Value) -> Option<LabelColor> {
    let value = label_value(entry)?;
    let rgba_arr = entry.get("rgba").and_then(|v| v.as_array())?;
    if rgba_arr.len() != 4 {
        return None;
    }
    let mut rgba = [0u8; 4];
    for (slot, component) in rgba.iter_mut().zip(rgba_arr) {
        *slot = u8::try_from(component.as_u64()?).ok()?;
    }
    Some(LabelColor { value, rgba })
}

/// Parse one `image-label.properties` entry, or `None` if malformed. The
/// `label-value` key is stripped; all other keys are carried verbatim.
fn parse_label_property(entry: &serde_json::Value) -> Option<LabelProperty> {
    let value = label_value(entry)?;
    let mut fields = entry.as_object()?.clone();
    fields.remove("label-value");
    Some(LabelProperty { value, fields })
}

/// Extract a `label-value` as a `u32`, or `None` if missing / not a
/// non-negative integer that fits `u32`.
fn label_value(entry: &serde_json::Value) -> Option<u32> {
    u32::try_from(entry.get("label-value")?.as_u64()?).ok()
}

/// Parsed OME multiscales metadata.
#[derive(Debug)]
pub(crate) struct ParsedMultiscales {
    pub axes_names: Vec<String>,
    pub level_entries: Vec<LevelEntry>,
}

/// Parse OME multiscales from a root zarr.json value.
/// `error_prefix` is prepended to error messages (e.g., "A/1/0: " for plates).
pub(crate) fn parse_multiscales(
    root_json: &serde_json::Value,
    error_prefix: &str,
) -> Result<ParsedMultiscales, StoreError> {
    let multiscales = root_json
        .pointer("/attributes/ome/multiscales")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            StoreError::Metadata(format!(
                "{error_prefix}no ome.multiscales in root zarr.json"
            ))
        })?;

    let ms = multiscales
        .first()
        .ok_or_else(|| StoreError::Metadata(format!("{error_prefix}multiscales array is empty")))?;

    let axes_json: Vec<serde_json::Value> = ms
        .get("axes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let axes_names: Vec<String> = axes_json
        .iter()
        .filter_map(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let datasets_arr = ms
        .get("datasets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata(format!("{error_prefix}no datasets in multiscales")))?;

    let mut level_entries: Vec<LevelEntry> = Vec::new();
    for ds in datasets_arr {
        let path = ds
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                StoreError::Metadata(format!("{error_prefix}dataset entry missing path"))
            })?
            .to_string();

        let mut scale = [1.0_f64; 5]; // [T, C, Z, Y, X]
        if let Some(transforms) = ds
            .get("coordinateTransformations")
            .and_then(|v| v.as_array())
        {
            for ct in transforms {
                if ct.get("type").and_then(|v| v.as_str()) == Some("scale")
                    && let Some(s) = ct.get("scale").and_then(|v| v.as_array())
                {
                    let raw: Vec<f64> = s.iter().filter_map(|v| v.as_f64()).collect();
                    scale = normalize_f64_to_5d(&raw, &axes_names, 1.0);
                }
            }
        }

        level_entries.push(LevelEntry { path, scale });
    }

    if level_entries.is_empty() {
        return Err(StoreError::Metadata(format!(
            "{error_prefix}no levels found"
        )));
    }

    Ok(ParsedMultiscales {
        axes_names,
        level_entries,
    })
}

/// Parse per-channel display info from the OME `omero.channels` block of a
/// root (or FOV) `zarr.json` value.
///
/// GENERIC and untrusted-input safe. The omero block is optional rendering
/// metadata that *any* OME-Zarr producer may emit, omit, or get wrong — this
/// helper treats it as fully untrusted and never panics, errors, or mislabels:
///
/// - Missing `attributes.ome.omero` or `omero.channels`, or `channels` that is
///   not a JSON array → empty `Vec` (caller falls back to `Ch N`).
/// - Each entry's `label` must be a non-blank string; entries that are not
///   objects, lack `label`, or carry a non-string / whitespace-only label have
///   *no usable label*.
/// - **Positional integrity**: results are kept aligned to channel index. A
///   label-less channel in the *middle* is filled with the positional
///   `Ch {i}` fallback so every later label still lines up with its channel
///   (dropping it would silently shift all subsequent names). A label-less
///   *trailing* run is truncated instead — the web falls back per-index for
///   missing entries, so trimming keeps the wire minimal without misaligning
///   anything. If no entry has a usable label, the result is empty.
/// - `color`, when present, must be a string; anything else (number, object,
///   `null`) is dropped to `None`. The raw hex is carried through verbatim
///   (no `#`, no validation) — this slice does not consume it.
///
/// The result is intentionally *not* reconciled against the C-axis size here.
/// Parse stays a pure function of the metadata; if a producer's omero list
/// disagrees with the channel count, the labels remain positional and the web
/// falls back per-index for any channel beyond the list. See the module tests
/// for the malformed-input matrix this guarantees.
pub(crate) fn parse_omero_channels(root_json: &serde_json::Value) -> Vec<ChannelInfo> {
    let Some(channels) = root_json
        .pointer("/attributes/ome/omero/channels")
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    // First pass: best-effort label per position (None == no usable label).
    let parsed: Vec<Option<ChannelInfo>> = channels
        .iter()
        .map(|entry| {
            let label = entry
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let color = entry
                .get("color")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some(ChannelInfo {
                label: label.to_string(),
                color,
            })
        })
        .collect();

    // Truncate a trailing run of label-less channels: the web falls back
    // per-index, so there's nothing to preserve past the last real label.
    let last_labeled = parsed.iter().rposition(Option::is_some);
    let Some(last) = last_labeled else {
        return Vec::new(); // no usable labels anywhere
    };

    // Fill interior gaps with the positional fallback so index i always maps
    // to channel i; keep real labels as-is.
    parsed
        .into_iter()
        .take(last + 1)
        .enumerate()
        .map(|(i, slot)| {
            slot.unwrap_or(ChannelInfo {
                label: format!("Ch {i}"),
                color: None,
            })
        })
        .collect()
}

/// Read ArrayMeta for each level in the multiscale pyramid.
/// `base_prefix` is prepended to level paths (empty for root, "A/1/0" for plate FOVs).
pub(crate) async fn read_level_metas(
    store: &Arc<dyn ObjectStore>,
    base_prefix: &str,
    level_entries: &[LevelEntry],
) -> Result<Vec<ArrayMeta>, StoreError> {
    let mut level_metas: Vec<ArrayMeta> = Vec::new();
    for entry in level_entries {
        let level_path = if base_prefix.is_empty() {
            Path::from(format!("{}/zarr.json", entry.path))
        } else {
            Path::from(format!("{base_prefix}/{}/zarr.json", entry.path))
        };
        let level_bytes = store.get(&level_path).await?.bytes().await?;
        let error_ctx = if base_prefix.is_empty() {
            entry.path.clone()
        } else {
            format!("{base_prefix}/{}", entry.path)
        };
        let meta: ArrayMeta = serde_json::from_slice(&level_bytes)
            .map_err(|e| StoreError::Metadata(format!("{error_ctx}: {e}")))?;
        level_metas.push(meta);
    }
    Ok(level_metas)
}

/// Extract and normalize the full-resolution (level 0) shape and chunk shape to 5D.
/// Returns `(shape_5d, chunk_5d)`.
pub(crate) fn extract_full_res(
    level_metas: &[ArrayMeta],
    axes_names: &[String],
) -> ([u64; 5], [u64; 5]) {
    let full_res = &level_metas[0];
    let full_shape_5d = normalize_to_5d(&full_res.shape, axes_names, 1);
    let full_chunk_5d = normalize_to_5d(
        &full_res.chunk_grid.configuration.chunk_shape,
        axes_names,
        1,
    );
    (full_shape_5d, full_chunk_5d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_multiscales_extracts_axes_and_levels() {
        let root_json = serde_json::json!({
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
                        "datasets": [
                            {
                                "path": "0",
                                "coordinateTransformations": [{
                                    "type": "scale",
                                    "scale": [1.0, 1.0, 2.0, 0.5, 0.5]
                                }]
                            },
                            {
                                "path": "1",
                                "coordinateTransformations": [{
                                    "type": "scale",
                                    "scale": [1.0, 1.0, 4.0, 1.0, 1.0]
                                }]
                            }
                        ]
                    }]
                }
            }
        });

        let parsed = parse_multiscales(&root_json, "").unwrap();

        assert_eq!(parsed.axes_names, vec!["t", "c", "z", "y", "x"]);
        assert_eq!(parsed.level_entries.len(), 2);
        assert_eq!(parsed.level_entries[0].path, "0");
        assert_eq!(parsed.level_entries[0].scale, [1.0, 1.0, 2.0, 0.5, 0.5]);
        assert_eq!(parsed.level_entries[1].path, "1");
        assert_eq!(parsed.level_entries[1].scale, [1.0, 1.0, 4.0, 1.0, 1.0]);
    }

    #[test]
    fn parse_multiscales_error_prefix() {
        let root_json =
            serde_json::json!({"zarr_format": 3, "node_type": "group", "attributes": {}});
        let err = parse_multiscales(&root_json, "A/1/0: ").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("A/1/0: "),
            "error should contain prefix: {msg}",
        );
    }

    /// Wrap an omero value in the `attributes.ome.omero` envelope the parser
    /// reads from. `omero` is spliced verbatim so tests can supply malformed
    /// shapes (non-array channels, etc.).
    fn root_with_omero(omero: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "omero": omero } }
        })
    }

    #[test]
    fn omero_channels_parses_labels_and_colors_in_order() {
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "DAPI", "color": "0000FF"},
                {"label": "GFP", "color": "00FF00"},
                {"label": "RFP", "color": "FF0000"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 3);
        assert_eq!(infos[0].label, "DAPI");
        assert_eq!(infos[0].color.as_deref(), Some("0000FF"));
        assert_eq!(infos[1].label, "GFP");
        assert_eq!(infos[2].label, "RFP");
        assert_eq!(infos[2].color.as_deref(), Some("FF0000"));
    }

    #[test]
    fn omero_channels_label_only_is_fine() {
        let root = root_with_omero(serde_json::json!({
            "channels": [{"label": "Brightfield"}]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].label, "Brightfield");
        assert_eq!(infos[0].color, None);
    }

    #[test]
    fn no_omero_block_yields_empty() {
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "multiscales": [] } }
        });
        assert!(parse_omero_channels(&root).is_empty());
    }

    #[test]
    fn omero_without_channels_yields_empty() {
        let root = root_with_omero(serde_json::json!({ "rdefs": {} }));
        assert!(parse_omero_channels(&root).is_empty());
    }

    #[test]
    fn omero_channels_not_an_array_yields_empty() {
        // Untrusted shape: channels is an object, a string, a number, null.
        for bad in [
            serde_json::json!({"channels": {"label": "X"}}),
            serde_json::json!({"channels": "DAPI"}),
            serde_json::json!({"channels": 5}),
            serde_json::json!({"channels": null}),
        ] {
            let root = root_with_omero(bad);
            assert!(
                parse_omero_channels(&root).is_empty(),
                "non-array channels must degrade to empty",
            );
        }
    }

    #[test]
    fn omero_empty_channels_array_yields_empty() {
        let root = root_with_omero(serde_json::json!({ "channels": [] }));
        assert!(parse_omero_channels(&root).is_empty());
    }

    #[test]
    fn omero_channels_all_blank_or_missing_labels_yields_empty() {
        // Whitespace, empty string, missing key, non-string, non-object.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "   "},
                {"label": ""},
                {"color": "FF0000"},
                {"label": 42},
                "not-an-object",
                42
            ]
        }));
        assert!(
            parse_omero_channels(&root).is_empty(),
            "no usable label anywhere must fully fall back to Ch N (empty list)",
        );
    }

    #[test]
    fn omero_channels_trailing_blanks_are_truncated() {
        // Only channel 0 has a label; the rest fall back per-index on the web,
        // so the list is trimmed to length 1.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "DAPI"},
                {"label": "  "},
                {}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].label, "DAPI");
    }

    #[test]
    fn omero_channels_interior_gaps_keep_positions_aligned() {
        // Channel 1 has no usable label but channel 2 does: index 1 must be
        // filled with the positional fallback so "Marker" still maps to ch 2.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "DAPI"},
                {"label": "   "},
                {"label": "Marker"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 3);
        assert_eq!(infos[0].label, "DAPI");
        assert_eq!(infos[1].label, "Ch 1"); // positional fallback, alignment preserved
        assert_eq!(infos[1].color, None);
        assert_eq!(infos[2].label, "Marker");
    }

    #[test]
    fn omero_channels_label_is_trimmed() {
        let root = root_with_omero(serde_json::json!({
            "channels": [{"label": "  DAPI  "}]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos[0].label, "DAPI");
    }

    #[test]
    fn omero_channels_non_string_color_dropped() {
        // color as number/object/null/blank must not crash and must yield None.
        for bad_color in [
            serde_json::json!(16711680),
            serde_json::json!({"r": 255}),
            serde_json::json!(null),
            serde_json::json!("   "),
        ] {
            let root = root_with_omero(serde_json::json!({
                "channels": [{"label": "C", "color": bad_color}]
            }));
            let infos = parse_omero_channels(&root);
            assert_eq!(infos.len(), 1);
            assert_eq!(infos[0].label, "C");
            assert_eq!(
                infos[0].color, None,
                "non-string/blank color must degrade to None",
            );
        }
    }

    #[test]
    fn omero_channels_more_than_c_axis_is_preserved_positionally() {
        // Parse does NOT reconcile against the C-axis size — extra labels are
        // kept; downstream/web simply won't index past the real channel count.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "A"}, {"label": "B"}, {"label": "C"}, {"label": "D"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 4);
        assert_eq!(infos[3].label, "D");
    }

    fn labels_root(labels: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "labels": labels } }
        })
    }

    #[test]
    fn parse_labels_list_reads_names_in_order() {
        let root = labels_root(serde_json::json!(["nuclei", "cells"]));
        assert_eq!(parse_labels_list(&root), vec!["nuclei", "cells"]);
    }

    #[test]
    fn parse_labels_list_missing_or_bad_yields_empty() {
        // No ome block, no labels key, and non-array labels all degrade to [].
        let no_ome = serde_json::json!({"zarr_format": 3, "attributes": {}});
        assert!(parse_labels_list(&no_ome).is_empty());
        let no_key = labels_root(serde_json::json!(null));
        assert!(parse_labels_list(&no_key).is_empty());
        for bad in [
            serde_json::json!("nuclei"),
            serde_json::json!({"0": "nuclei"}),
            serde_json::json!(5),
        ] {
            assert!(parse_labels_list(&labels_root(bad)).is_empty());
        }
    }

    #[test]
    fn parse_labels_list_drops_blank_and_non_string_entries() {
        let root = labels_root(serde_json::json!(["nuclei", "  ", "", 42, "cells"]));
        assert_eq!(parse_labels_list(&root), vec!["nuclei", "cells"]);
    }

    #[test]
    fn parse_labels_list_rejects_path_traversal_names() {
        // A hostile list must not smuggle path separators or traversal
        // components through as group names — only single in-tree segments.
        let root = labels_root(serde_json::json!([
            "nuclei",
            "../../etc/passwd",
            "..",
            ".",
            "sub/dir",
            "back\\slash",
            "cells"
        ]));
        assert_eq!(parse_labels_list(&root), vec!["nuclei", "cells"]);
    }

    #[test]
    fn parse_labels_list_is_capped() {
        let many: Vec<serde_json::Value> = (0..(MAX_LABEL_NAMES + 50))
            .map(|i| serde_json::json!(format!("l{i}")))
            .collect();
        let root = labels_root(serde_json::json!(many));
        assert_eq!(parse_labels_list(&root).len(), MAX_LABEL_NAMES);
    }

    fn image_label_root(image_label: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "image-label": image_label } }
        })
    }

    #[test]
    fn parse_image_label_absent_or_non_object_is_none() {
        let no_block = serde_json::json!({
            "attributes": { "ome": { "multiscales": [] } }
        });
        assert!(parse_image_label(&no_block, "n").is_none());
        // Present but not an object → not a label group.
        assert!(parse_image_label(&image_label_root(serde_json::json!("x")), "n").is_none());
        assert!(parse_image_label(&image_label_root(serde_json::json!([1, 2])), "n").is_none());
    }

    #[test]
    fn parse_image_label_populates_group_name() {
        // The owning `labels/` group name rides onto LabelMeta.name verbatim so
        // downstream can show it instead of a synthetic id.
        let meta =
            parse_image_label(&image_label_root(serde_json::json!({})), "mitochondria").unwrap();
        assert_eq!(meta.name, "mitochondria");
    }

    #[test]
    fn parse_image_label_empty_object_yields_default_meta_plus_name() {
        // A present but empty `image-label` marks a valid label group with no
        // colors/properties/source — Some(default) apart from the group name.
        let meta = parse_image_label(&image_label_root(serde_json::json!({})), "nuclei").unwrap();
        assert_eq!(
            meta,
            LabelMeta {
                name: "nuclei".to_string(),
                ..LabelMeta::default()
            }
        );
    }

    #[test]
    fn parse_image_label_parses_colors_properties_source() {
        let root = image_label_root(serde_json::json!({
            "version": "0.5",
            "colors": [
                {"label-value": 1, "rgba": [255, 0, 0, 255]},
                {"label-value": 2, "rgba": [0, 255, 0, 128]}
            ],
            "properties": [
                {"label-value": 1, "area": 100, "name": "cell-1"}
            ],
            "source": {"image": "../../"}
        }));
        let meta = parse_image_label(&root, "cells").unwrap();
        assert_eq!(meta.name, "cells");
        assert_eq!(
            meta.colors,
            vec![
                LabelColor {
                    value: 1,
                    rgba: [255, 0, 0, 255]
                },
                LabelColor {
                    value: 2,
                    rgba: [0, 255, 0, 128]
                },
            ]
        );
        assert_eq!(meta.properties.len(), 1);
        assert_eq!(meta.properties[0].value, 1);
        // label-value is stripped; arbitrary keys survive verbatim.
        assert!(!meta.properties[0].fields.contains_key("label-value"));
        assert_eq!(
            meta.properties[0].fields.get("area"),
            Some(&serde_json::json!(100))
        );
        assert_eq!(
            meta.properties[0].fields.get("name"),
            Some(&serde_json::json!("cell-1"))
        );
        assert_eq!(meta.source_image.as_deref(), Some("../../"));
    }

    #[test]
    fn parse_image_label_drops_malformed_color_entries() {
        let root = image_label_root(serde_json::json!({
            "colors": [
                {"label-value": 1, "rgba": [255, 0, 0, 255]}, // ok
                {"label-value": 2, "rgba": [255, 0, 0]},      // too short
                {"label-value": 3, "rgba": [255, 0, 0, 999]}, // out of u8 range
                {"rgba": [1, 2, 3, 4]},                        // no label-value
                {"label-value": -1, "rgba": [1, 2, 3, 4]},     // negative value
                {"label-value": 4},                            // no rgba
                "not-an-object"
            ]
        }));
        let meta = parse_image_label(&root, "n").unwrap();
        assert_eq!(
            meta.colors,
            vec![LabelColor {
                value: 1,
                rgba: [255, 0, 0, 255]
            }]
        );
    }

    #[test]
    fn parse_image_label_never_resolves_source_image() {
        // A hostile source.image path is carried verbatim, never joined/opened.
        let root = image_label_root(serde_json::json!({
            "source": {"image": "../../../../etc/passwd"}
        }));
        let meta = parse_image_label(&root, "n").unwrap();
        assert_eq!(meta.source_image.as_deref(), Some("../../../../etc/passwd"));
        assert!(meta.colors.is_empty());
    }

    #[test]
    fn parse_image_label_caps_entries() {
        let colors: Vec<serde_json::Value> = (0..(MAX_LABEL_ENTRIES + 10))
            .map(|i| serde_json::json!({"label-value": i, "rgba": [0, 0, 0, 255]}))
            .collect();
        let root = image_label_root(serde_json::json!({ "colors": colors }));
        let meta = parse_image_label(&root, "n").unwrap();
        assert_eq!(meta.colors.len(), MAX_LABEL_ENTRIES);
    }

    #[test]
    fn extract_full_res_normalizes_to_5d() {
        let axes = vec!["z", "y", "x"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();

        let level_metas = vec![ArrayMeta {
            shape: vec![20, 100, 200],
            data_type: "uint16".to_string(),
            chunk_grid: ChunkGrid {
                configuration: ChunkGridConfig {
                    chunk_shape: vec![10, 64, 64],
                },
            },
            codecs: vec![],
        }];

        let (shape_5d, chunk_5d) = extract_full_res(&level_metas, &axes);

        // T=1, C=1, Z=20, Y=100, X=200
        assert_eq!(shape_5d, [1, 1, 20, 100, 200]);
        // T=1, C=1, Z=10, Y=64, X=64
        assert_eq!(chunk_5d, [1, 1, 10, 64, 64]);
    }
}
