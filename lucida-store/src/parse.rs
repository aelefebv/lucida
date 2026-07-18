//! Shared OME-Zarr parsing helpers.
//!
//! Low-level functions for reading and parsing Zarr v3 / OME-Zarr metadata
//! from an object store. Consumed by [`crate::import`].

use std::fmt;
use std::marker::PhantomData;

use serde::de::{Error as _, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use lucida_content::normalize::{normalize_f64_to_5d, normalize_to_5d};
use lucida_content::{ChannelInfo, LabelColor};

use crate::backend::StoreError;
use crate::metadata::{MetadataReader, ParsedJson, ParsedJsonValue};

/// Upper bound on label groups parsed from one `labels` list. Guards against
/// oversized/untrusted metadata; far above any realistic label count.
const MAX_LABEL_GROUPS: usize = 4096;

/// Upper bound on color-table entries kept per label. A display palette, not a
/// per-object table, so this is generous while still bounding memory.
const MAX_LABEL_COLORS: usize = 1 << 16;
const MAX_MULTISCALE_AXES: usize = 32;
const MAX_MULTISCALE_LEVELS: usize = 1024;
const MAX_LEVEL_PATH_BYTES: usize = 4096;
const MAX_ARRAY_CODECS: usize = 32;
const MAX_CHANNEL_INFOS: usize = 4096;

/// Intermediate per-level metadata parsed from OME multiscales.
#[derive(Debug, Clone)]
pub struct LevelEntry {
    pub path: String,
    pub scale: [f64; 5], // [T, C, Z, Y, X]
}

/// Deserialized from a level's zarr.json.
#[derive(Debug, Deserialize)]
pub struct ArrayMeta {
    #[serde(deserialize_with = "deserialize_array_dimensions")]
    pub shape: Vec<u64>, // N-dimensional (matches axes count)
    pub data_type: String,
    pub chunk_grid: ChunkGrid,
    #[serde(default, deserialize_with = "deserialize_array_codecs")]
    pub codecs: Vec<serde_json::Value>,
}

impl AsRef<ArrayMeta> for ArrayMeta {
    fn as_ref(&self) -> &ArrayMeta {
        self
    }
}

pub(crate) type ParsedArrayMeta = ParsedJson<ArrayMeta>;

#[derive(Debug, Deserialize)]
pub struct ChunkGrid {
    pub configuration: ChunkGridConfig,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGridConfig {
    #[serde(deserialize_with = "deserialize_array_dimensions")]
    pub chunk_shape: Vec<u64>, // N-dimensional (matches axes count)
}

struct BoundedVecVisitor<T, const MAX: usize> {
    field: &'static str,
    marker: PhantomData<T>,
}

impl<'de, T, const MAX: usize> Visitor<'de> for BoundedVecVisitor<T, MAX>
where
    T: Deserialize<'de>,
{
    type Value = Vec<T>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "an array with at most {MAX} entries")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        if sequence.size_hint().is_some_and(|size| size > MAX) {
            return Err(A::Error::custom(format!(
                "{} has more than {MAX} entries",
                self.field
            )));
        }
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(MAX));
        while let Some(value) = sequence.next_element()? {
            if values.len() == MAX {
                return Err(A::Error::custom(format!(
                    "{} has more than {MAX} entries",
                    self.field
                )));
            }
            values.push(value);
        }
        Ok(values)
    }
}

fn deserialize_bounded_vec<'de, D, T, const MAX: usize>(
    deserializer: D,
    field: &'static str,
) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    deserializer.deserialize_seq(BoundedVecVisitor::<T, MAX> {
        field,
        marker: PhantomData,
    })
}

fn deserialize_array_dimensions<'de, D>(deserializer: D) -> Result<Vec<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_vec::<D, u64, MAX_MULTISCALE_AXES>(deserializer, "array dimensions")
}

fn deserialize_array_codecs<'de, D>(deserializer: D) -> Result<Vec<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_vec::<D, serde_json::Value, MAX_ARRAY_CODECS>(deserializer, "array codecs")
}

/// Read and parse a zarr.json file from the object store.
pub(crate) async fn read_zarr_json(
    metadata: &MetadataReader,
    path: &str,
) -> Result<ParsedJsonValue, StoreError> {
    metadata.read_json_value(path).await
}

/// Parsed OME multiscales metadata.
#[derive(Debug)]
pub(crate) struct ParsedMultiscales {
    pub axes_names: Vec<String>,
    pub level_entries: Vec<LevelEntry>,
}

/// Parse OME multiscales from a root zarr.json value.
/// `error_prefix` is prepended to error messages (e.g., "A/1/0: " for collections).
pub(crate) fn parse_multiscales(
    root_json: &serde_json::Value,
    error_prefix: &str,
) -> Result<ParsedMultiscales, StoreError> {
    let multiscales = root_json
        .pointer("/attributes/ome/multiscales")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            StoreError::Schema(format!(
                "{error_prefix}no ome.multiscales in root zarr.json"
            ))
        })?;

    if multiscales.len() != 1 {
        return Err(StoreError::Schema(format!(
            "{error_prefix}expected exactly one multiscale series, found {}",
            multiscales.len()
        )));
    }
    let ms = multiscales
        .first()
        .ok_or_else(|| StoreError::Schema(format!("{error_prefix}multiscales array is empty")))?;

    let axes_json = ms
        .get("axes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Schema(format!("{error_prefix}axes must be an array")))?;
    if axes_json.is_empty() || axes_json.len() > MAX_MULTISCALE_AXES {
        return Err(StoreError::Schema(format!(
            "{error_prefix}axes count {} is outside 1..={MAX_MULTISCALE_AXES}",
            axes_json.len()
        )));
    }
    let mut axes_names = Vec::with_capacity(axes_json.len());
    let mut seen_axes = std::collections::HashSet::with_capacity(axes_json.len());
    for (index, axis) in axes_json.iter().enumerate() {
        let name = axis
            .get("name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                StoreError::Schema(format!("{error_prefix}axes[{index}].name must be a string"))
            })?;
        if name.trim().is_empty() || name.len() > 256 || name.contains(['/', '\\', '\0']) {
            return Err(StoreError::Schema(format!(
                "{error_prefix}axes[{index}].name is not a valid axis component"
            )));
        }
        let folded = name.to_ascii_lowercase();
        if !seen_axes.insert(folded) {
            return Err(StoreError::Schema(format!(
                "{error_prefix}axes[{index}].name duplicates an earlier axis"
            )));
        }
        axes_names.push(name.to_string());
    }

    let datasets_arr = ms
        .get("datasets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Schema(format!("{error_prefix}no datasets in multiscales")))?;
    if datasets_arr.is_empty() || datasets_arr.len() > MAX_MULTISCALE_LEVELS {
        return Err(StoreError::Schema(format!(
            "{error_prefix}datasets count {} is outside 1..={MAX_MULTISCALE_LEVELS}",
            datasets_arr.len()
        )));
    }

    let mut level_entries: Vec<LevelEntry> = Vec::new();
    let mut seen_paths = std::collections::HashSet::with_capacity(datasets_arr.len());
    for (dataset_index, ds) in datasets_arr.iter().enumerate() {
        let path = ds
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                StoreError::Schema(format!(
                    "{error_prefix}datasets[{dataset_index}].path must be a string"
                ))
            })?
            .to_string();
        if path.is_empty()
            || path.len() > MAX_LEVEL_PATH_BYTES
            || path.starts_with('/')
            || path.contains('\\')
            || path
                .split('/')
                .any(|component| component.is_empty() || matches!(component, "." | ".."))
        {
            return Err(StoreError::Schema(format!(
                "{error_prefix}datasets[{dataset_index}].path is not a safe relative path"
            )));
        }
        if !seen_paths.insert(path.clone()) {
            return Err(StoreError::Schema(format!(
                "{error_prefix}datasets[{dataset_index}].path duplicates an earlier level"
            )));
        }

        let mut scale = [1.0_f64; 5]; // [T, C, Z, Y, X]
        if let Some(transforms) = ds
            .get("coordinateTransformations")
            .and_then(|v| v.as_array())
        {
            let mut saw_scale = false;
            for (transform_index, ct) in transforms.iter().enumerate() {
                let transform_type = ct.get("type").and_then(|v| v.as_str()).ok_or_else(|| {
                    StoreError::Schema(format!(
                        "{error_prefix}datasets[{dataset_index}].coordinateTransformations[{transform_index}].type must be a string"
                    ))
                })?;
                let field = match transform_type {
                    "scale" => "scale",
                    "translation" => "translation",
                    other => {
                        return Err(StoreError::Schema(format!(
                            "{error_prefix}datasets[{dataset_index}].coordinateTransformations[{transform_index}] has unsupported type '{other}'"
                        )));
                    }
                };
                let values = ct.get(field).and_then(|v| v.as_array()).ok_or_else(|| {
                    StoreError::Schema(format!(
                        "{error_prefix}datasets[{dataset_index}].coordinateTransformations[{transform_index}].{field} must be an array"
                    ))
                })?;
                if values.len() != axes_names.len() {
                    return Err(StoreError::Schema(format!(
                        "{error_prefix}datasets[{dataset_index}].coordinateTransformations[{transform_index}].{field} has rank {}; expected {}",
                        values.len(),
                        axes_names.len()
                    )));
                }
                let mut raw = Vec::with_capacity(values.len());
                for (value_index, value) in values.iter().enumerate() {
                    let numeric = value.as_f64().ok_or_else(|| {
                        StoreError::Schema(format!(
                            "{error_prefix}datasets[{dataset_index}].coordinateTransformations[{transform_index}].{field}[{value_index}] must be a number"
                        ))
                    })?;
                    if !numeric.is_finite() || (field == "scale" && numeric <= 0.0) {
                        return Err(StoreError::Schema(format!(
                            "{error_prefix}datasets[{dataset_index}].coordinateTransformations[{transform_index}].{field}[{value_index}] must be finite{}",
                            if field == "scale" {
                                " and positive"
                            } else {
                                ""
                            }
                        )));
                    }
                    raw.push(numeric);
                }
                if field == "scale" {
                    if saw_scale {
                        return Err(StoreError::Schema(format!(
                            "{error_prefix}datasets[{dataset_index}] has multiple scale transformations"
                        )));
                    }
                    saw_scale = true;
                    scale = normalize_f64_to_5d(&raw, &axes_names, 1.0);
                } else if raw.iter().any(|value| *value != 0.0) {
                    return Err(StoreError::Schema(format!(
                        "{error_prefix}datasets[{dataset_index}] has a nonzero translation that this importer cannot preserve"
                    )));
                }
            }
        }

        level_entries.push(LevelEntry { path, scale });
    }

    if level_entries.is_empty() {
        return Err(StoreError::Schema(format!("{error_prefix}no levels found")));
    }

    Ok(ParsedMultiscales {
        axes_names,
        level_entries,
    })
}

/// Parse per-channel display info from the OME `omero.channels` block of a
/// root (or tile) `zarr.json` value.
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
        .take(MAX_CHANNEL_INFOS)
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

/// The outcome of reading an optional zarr.json, distinguishing a clean
/// NotFound from an object that exists (or errored) but yielded no usable
/// JSON. Absence is a definitive answer — the object is not there — while an
/// unusable object is an anomaly the caller may want to react to (e.g. by
/// probing further) instead of silently equating it with absence.
pub(crate) enum OptionalZarrJson {
    /// The object does not exist (a clean NotFound).
    Absent,
    /// The object was read and parsed.
    Parsed(ParsedJsonValue),
    /// The object could not be used: the read failed with an error other
    /// than NotFound, or the bytes were not valid JSON. Logged, never fatal.
    Unusable,
}

/// Read and parse a zarr.json that may not exist, without treating absence or
/// corruption as an error.
///
/// Detects optional child groups (e.g. a `labels/` group). A missing object
/// is the common case and yields [`OptionalZarrJson::Absent`] silently; a
/// present-but-corrupt object (bad JSON) or any other storage error yields
/// [`OptionalZarrJson::Unusable`] with a logged warning. Optional metadata
/// must never fail the whole import — the caller proceeds either way, but can
/// tell a definitive miss from an anomaly.
pub(crate) async fn read_optional_zarr_json(
    metadata: &MetadataReader,
    path: &str,
) -> OptionalZarrJson {
    match metadata.read_json_value(path).await {
        Ok(value) => OptionalZarrJson::Parsed(value),
        Err(StoreError::ObjectStore {
            source: object_store::Error::NotFound { .. },
            ..
        }) => OptionalZarrJson::Absent,
        Err(e) => {
            eprintln!("[lucida-store] ignoring optional metadata {path}: {e}");
            OptionalZarrJson::Unusable
        }
    }
}

/// A single label-group's name must be a safe single path segment: it is
/// concatenated into a store path (`{prefix}/labels/{name}`), so a name with a
/// separator or `..` could escape the dataset. Reject those (and empty /
/// over-long names) rather than trust untrusted metadata.
fn is_safe_label_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Parse the label-group names from a `labels/zarr.json` value's
/// `attributes.ome.labels` list.
///
/// GENERIC and untrusted-input safe: a missing/non-array `labels` yields an
/// empty `Vec`; non-string or unsafe entries are dropped; duplicate names are
/// deduped (first occurrence wins, order preserved); and the count is capped at
/// [`MAX_LABEL_GROUPS`]. The returned names are safe to use as store-path
/// segments.
pub(crate) fn parse_labels_names(labels_group_json: &serde_json::Value) -> Vec<String> {
    let Some(entries) = labels_group_json
        .pointer("/attributes/ome/labels")
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    let mut seen = std::collections::HashSet::new();
    let mut names = Vec::new();
    for entry in entries {
        let Some(name) = entry.as_str() else { continue };
        if !is_safe_label_name(name) {
            continue;
        }
        if seen.insert(name.to_string()) {
            names.push(name.to_string());
            if names.len() >= MAX_LABEL_GROUPS {
                break;
            }
        }
    }
    names
}

/// The parsed `ome.image-label` block of a single label group.
#[derive(Debug, Default)]
pub(crate) struct ImageLabelMeta {
    /// Validated color table, in declared order; empty when absent/malformed.
    pub colors: Vec<LabelColor>,
    /// Whether `image-label.source.image` was present (a declared back-pointer
    /// to the source intensity image).
    pub source_declared: bool,
}

/// Parse the `attributes.ome.image-label` block of a label group's zarr.json.
///
/// GENERIC and untrusted-input safe: a missing `image-label` yields the default
/// (no colors, no declared source). Each color entry must carry an integer
/// `label-value` (kept as `i64` — never truncated, since ids exceed 16 bits)
/// and an `rgba` array of exactly four `0..=255` integers; malformed entries
/// are skipped individually and the kept count is capped at
/// [`MAX_LABEL_COLORS`]. `properties`, when present, is intentionally not
/// consumed here.
pub(crate) fn parse_image_label(label_group_json: &serde_json::Value) -> ImageLabelMeta {
    let Some(image_label) = label_group_json.pointer("/attributes/ome/image-label") else {
        return ImageLabelMeta::default();
    };

    let source_declared = image_label
        .pointer("/source/image")
        .and_then(|v| v.as_str())
        .is_some();

    let colors = image_label
        .get("colors")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(parse_label_color)
                .take(MAX_LABEL_COLORS)
                .collect::<Vec<_>>()
                .into_boxed_slice()
                .into_vec()
        })
        .unwrap_or_default();

    ImageLabelMeta {
        colors,
        source_declared,
    }
}

/// Validate one `image-label.colors` entry. Returns `None` (dropping the entry)
/// when `label-value` is missing/non-integer/out of `i64` range, or when `rgba`
/// is absent, not a 4-element array, or has any component outside `0..=255`.
fn parse_label_color(entry: &serde_json::Value) -> Option<LabelColor> {
    let value = entry.get("label-value")?.as_i64()?;
    let rgba_arr = entry.get("rgba")?.as_array()?;
    if rgba_arr.len() != 4 {
        return None;
    }
    let mut rgba = [0u8; 4];
    for (slot, component) in rgba.iter_mut().zip(rgba_arr) {
        let n = component.as_u64()?;
        if n > u8::MAX as u64 {
            return None;
        }
        *slot = n as u8;
    }
    Some(LabelColor { value, rgba })
}

/// Read ArrayMeta for each level in the multiscale pyramid.
/// `base_prefix` is prepended to level paths (empty for root, "A/1/0" for collection tiles).
pub(crate) async fn read_level_metas(
    metadata: &MetadataReader,
    base_prefix: &str,
    level_entries: &[LevelEntry],
) -> Result<Vec<ParsedArrayMeta>, StoreError> {
    let mut level_metas: Vec<ParsedArrayMeta> = Vec::new();
    for entry in level_entries {
        let level_path = if base_prefix.is_empty() {
            format!("{}/zarr.json", entry.path)
        } else {
            format!("{base_prefix}/{}/zarr.json", entry.path)
        };
        let error_ctx = if base_prefix.is_empty() {
            entry.path.clone()
        } else {
            format!("{base_prefix}/{}", entry.path)
        };
        let meta: ParsedArrayMeta =
            metadata
                .read_json(&level_path)
                .await
                .map_err(|error| match error {
                    StoreError::Schema(message) => {
                        StoreError::Schema(format!("{error_ctx}: {message}"))
                    }
                    other => other,
                })?;
        level_metas.push(meta);
    }
    Ok(level_metas)
}

/// Extract and normalize the full-resolution (level 0) shape and chunk shape to 5D.
/// Returns `(shape_5d, chunk_5d)`.
pub(crate) fn extract_full_res<M>(level_metas: &[M], axes_names: &[String]) -> ([u64; 5], [u64; 5])
where
    M: AsRef<ArrayMeta>,
{
    let full_res = level_metas[0].as_ref();
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
    use std::sync::Arc;

    use object_store::ObjectStoreExt;
    use object_store::memory::InMemory;
    use object_store::path::Path;

    use crate::cache::SharedObjectCache;

    #[test]
    fn array_metadata_rejects_dimension_and_codec_fanout_during_deserialization() {
        let too_many_dimensions = serde_json::json!({
            "shape": vec![1u64; MAX_MULTISCALE_AXES + 1],
            "data_type": "uint8",
            "chunk_grid": {"configuration": {"chunk_shape": [1]}},
            "codecs": []
        });
        let error = serde_json::from_value::<ArrayMeta>(too_many_dimensions).unwrap_err();
        assert!(error.to_string().contains("array dimensions"));

        let too_many_codecs = serde_json::json!({
            "shape": [1],
            "data_type": "uint8",
            "chunk_grid": {"configuration": {"chunk_shape": [1]}},
            "codecs": vec![serde_json::json!({}); MAX_ARRAY_CODECS + 1]
        });
        let error = serde_json::from_value::<ArrayMeta>(too_many_codecs).unwrap_err();
        assert!(error.to_string().contains("array codecs"));
    }

    #[tokio::test]
    async fn every_retained_level_codec_tree_keeps_its_structural_claim() {
        const LEVELS: usize = 32;
        let store = Arc::new(InMemory::new());
        let payload = serde_json::to_vec(&serde_json::json!({
            "shape": [1, 1],
            "data_type": "uint8",
            "chunk_grid": {"configuration": {"chunk_shape": [1, 1]}},
            "codecs": [
                {"name": "bytes", "configuration": {"endian": "little"}},
                {"name": "nested", "configuration": {"tables": [[0], [0], [0]]}}
            ]
        }))
        .unwrap();
        let mut entries = Vec::new();
        for level in 0..LEVELS {
            let path = level.to_string();
            store
                .put(
                    &Path::from(format!("{path}/zarr.json")),
                    payload.clone().into(),
                )
                .await
                .unwrap();
            entries.push(LevelEntry {
                path,
                scale: [1.0; 5],
            });
        }
        let shared = SharedObjectCache::new(64 * 1024 * 1024, 1024 * 1024);
        let reader = MetadataReader::with_shared_cache(store, Arc::clone(&shared));

        let metas = read_level_metas(&reader, "", &entries).await.unwrap();
        assert_eq!(metas.len(), LEVELS);
        assert_eq!(metas[0].codecs.len(), 2);
        let held = shared.memory_snapshot().metadata_parsed_bytes;
        assert!(held > 0);

        drop(metas);
        assert_eq!(shared.memory_snapshot().metadata_parsed_bytes, 0);
        drop(reader);
        assert_eq!(shared.memory_snapshot().total_bytes, 0);
    }

    #[test]
    fn optional_channel_metadata_is_capped_before_result_allocation_fanout() {
        let channels = (0..(MAX_CHANNEL_INFOS + 100))
            .map(|index| serde_json::json!({"label": format!("Channel {index}")}))
            .collect::<Vec<_>>();
        let root = root_with_omero(serde_json::json!({"channels": channels}));

        let parsed = parse_omero_channels(&root);
        assert_eq!(parsed.len(), MAX_CHANNEL_INFOS);
        assert_eq!(parsed.last().unwrap().label, "Channel 4095");
    }

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
                {"label": "Channel 0", "color": "0000FF"},
                {"label": "Channel 1", "color": "00FF00"},
                {"label": "Channel 2", "color": "FF0000"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 3);
        assert_eq!(infos[0].label, "Channel 0");
        assert_eq!(infos[0].color.as_deref(), Some("0000FF"));
        assert_eq!(infos[1].label, "Channel 1");
        assert_eq!(infos[2].label, "Channel 2");
        assert_eq!(infos[2].color.as_deref(), Some("FF0000"));
    }

    #[test]
    fn omero_channels_label_only_is_fine() {
        let root = root_with_omero(serde_json::json!({
            "channels": [{"label": "Channel 9"}]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].label, "Channel 9");
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
            serde_json::json!({"channels": "Channel 0"}),
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
                {"label": "Channel 0"},
                {"label": "  "},
                {}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].label, "Channel 0");
    }

    #[test]
    fn omero_channels_interior_gaps_keep_positions_aligned() {
        // Channel 1 has no usable label but channel 2 does: index 1 must be
        // filled with the positional fallback so "Marker" still maps to ch 2.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "Channel 0"},
                {"label": "   "},
                {"label": "Marker"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 3);
        assert_eq!(infos[0].label, "Channel 0");
        assert_eq!(infos[1].label, "Ch 1"); // positional fallback, alignment preserved
        assert_eq!(infos[1].color, None);
        assert_eq!(infos[2].label, "Marker");
    }

    #[test]
    fn omero_channels_label_is_trimmed() {
        let root = root_with_omero(serde_json::json!({
            "channels": [{"label": "  Channel 0  "}]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos[0].label, "Channel 0");
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

    // --- parse_labels_names tests ---

    /// Wrap a `labels` value in the `attributes.ome.labels` envelope the parser
    /// reads from. Spliced verbatim so tests can pass malformed shapes.
    fn labels_group(labels: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "labels": labels } }
        })
    }

    #[test]
    fn labels_names_parses_in_order() {
        let json = labels_group(serde_json::json!(["region-b", "foreground", "region-e"]));
        assert_eq!(
            parse_labels_names(&json),
            vec!["region-b", "foreground", "region-e"],
        );
    }

    #[test]
    fn labels_names_missing_or_non_array_is_empty() {
        // No labels key at all.
        let none = serde_json::json!({"attributes": {"ome": {"version": "0.5"}}});
        assert!(parse_labels_names(&none).is_empty());
        // labels present but not an array.
        for bad in [
            serde_json::json!("region-c"),
            serde_json::json!({"0": "region-c"}),
            serde_json::json!(7),
            serde_json::json!(null),
        ] {
            assert!(parse_labels_names(&labels_group(bad)).is_empty());
        }
    }

    #[test]
    fn labels_names_dedupes_preserving_first_occurrence() {
        let json = labels_group(serde_json::json!([
            "region-c", "region-a", "region-c", "region-c"
        ]));
        assert_eq!(parse_labels_names(&json), vec!["region-c", "region-a"]);
    }

    #[test]
    fn labels_names_drops_unsafe_and_non_string_entries() {
        // Path-traversal, separators, empty, and non-strings must all be
        // dropped so a name can be safely used as a store-path segment.
        let json = labels_group(serde_json::json!([
            "..",
            "a/b",
            "a\\b",
            "",
            42,
            {"name": "x"},
            "good"
        ]));
        assert_eq!(parse_labels_names(&json), vec!["good"]);
    }

    #[test]
    fn labels_names_caps_oversized_lists() {
        let many: Vec<String> = (0..(MAX_LABEL_GROUPS + 100))
            .map(|i| format!("l{i}"))
            .collect();
        let json = labels_group(serde_json::json!(many));
        assert_eq!(parse_labels_names(&json).len(), MAX_LABEL_GROUPS);
    }

    // --- parse_image_label tests ---

    /// Wrap an `image-label` value in the group envelope the parser reads from.
    fn image_label_group(image_label: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": { "ome": { "version": "0.5", "image-label": image_label } }
        })
    }

    #[test]
    fn image_label_parses_colors_and_source() {
        let json = image_label_group(serde_json::json!({
            "version": "0.5",
            "colors": [
                {"label-value": 2, "rgba": [230, 25, 75, 255]},
                {"label-value": 92801, "rgba": [0, 0, 128, 255]}
            ],
            "source": {"image": "../../"}
        }));
        let meta = parse_image_label(&json);
        assert!(meta.source_declared);
        assert_eq!(meta.colors.len(), 2);
        assert_eq!(
            meta.colors[0],
            LabelColor {
                value: 2,
                rgba: [230, 25, 75, 255]
            }
        );
        // A label value far past u16::MAX is preserved, not truncated.
        assert_eq!(meta.colors[1].value, 92801);
    }

    #[test]
    fn image_label_missing_block_is_default() {
        let json = serde_json::json!({"attributes": {"ome": {"version": "0.5"}}});
        let meta = parse_image_label(&json);
        assert!(meta.colors.is_empty());
        assert!(!meta.source_declared);
    }

    #[test]
    fn image_label_tolerates_missing_colors_and_source() {
        // image-label present but with neither colors nor source.
        let json = image_label_group(serde_json::json!({"version": "0.5"}));
        let meta = parse_image_label(&json);
        assert!(meta.colors.is_empty());
        assert!(!meta.source_declared);
    }

    #[test]
    fn image_label_skips_malformed_color_entries() {
        let json = image_label_group(serde_json::json!({
            "colors": [
                {"label-value": 1, "rgba": [1, 2, 3]},          // wrong rgba len
                {"label-value": 2, "rgba": [1, 2, 3, 300]},     // component > 255
                {"label-value": 3, "rgba": [1, 2, 3, -1]},      // negative component
                {"rgba": [1, 2, 3, 4]},                          // missing label-value
                {"label-value": 4},                              // missing rgba
                {"label-value": 5, "rgba": [10, 20, 30, 40]}    // valid
            ]
        }));
        let meta = parse_image_label(&json);
        assert_eq!(meta.colors.len(), 1);
        assert_eq!(
            meta.colors[0],
            LabelColor {
                value: 5,
                rgba: [10, 20, 30, 40]
            }
        );
    }

    #[test]
    fn image_label_non_array_colors_degrade_to_empty() {
        for bad in [
            serde_json::json!("red"),
            serde_json::json!(5),
            serde_json::json!({"label-value": 1}),
            serde_json::json!(null),
        ] {
            let json = image_label_group(serde_json::json!({"colors": bad}));
            assert!(parse_image_label(&json).colors.is_empty());
        }
    }

    #[test]
    fn image_label_source_without_image_string_is_not_declared() {
        // A `source` object lacking a string `image` does not count.
        let json = image_label_group(serde_json::json!({"source": {"note": "x"}}));
        assert!(!parse_image_label(&json).source_declared);
    }

    #[test]
    fn image_label_caps_oversized_color_tables() {
        let many: Vec<serde_json::Value> = (0..(MAX_LABEL_COLORS + 50))
            .map(|i| serde_json::json!({"label-value": i, "rgba": [1, 2, 3, 4]}))
            .collect();
        let json = image_label_group(serde_json::json!({"colors": many}));
        let colors = parse_image_label(&json).colors;
        assert_eq!(colors.len(), MAX_LABEL_COLORS);
        assert_eq!(colors.capacity(), colors.len());
    }
}
