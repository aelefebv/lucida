//! Shared OME-Zarr parsing helpers.
//!
//! Low-level functions for reading and parsing Zarr / OME-Zarr metadata
//! from an object store. Consumed by [`crate::import`]. Zarr v2 metadata is
//! read here too, rewritten into the v3 form by [`crate::zarr_v2`], so what
//! these functions return never depends on the version.

use std::sync::Arc;

use bytes::Bytes;
use object_store::path::Path;
use serde::Deserialize;

use lucida_content::normalize::normalize_f64_to_5d;
use lucida_content::{ChannelInfo, LabelColor, LabelName, PhysicalSpace};

use crate::ChunkKeyEncoding;
use crate::backend::StoreError;
use crate::cache::CachedStore;
use crate::zarr_v2;

/// Upper bound on label groups parsed from one `labels` list. Guards against
/// oversized/untrusted metadata; far above any realistic label count.
const MAX_LABEL_GROUPS: usize = 4096;

/// Upper bound on color-table entries kept per label. A display palette, not a
/// per-object table, so this is generous while still bounding memory.
const MAX_LABEL_COLORS: usize = 1 << 16;

/// Upper bound on named label values kept per label, as for colors.
const MAX_LABEL_NAMES: usize = 1 << 16;

/// Longest label name kept, in characters; a longer one is cut to this.
const MAX_LABEL_NAME_CHARS: usize = 256;

/// The property keys that name a label value, most specific first. The format
/// sets no key for a name; `class` is the one its own example uses.
const LABEL_NAME_KEYS: [&str; 2] = ["name", "class"];

/// Intermediate per-level metadata parsed from OME multiscales.
#[derive(Debug, Clone)]
pub struct LevelEntry {
    pub path: String,
    pub scale: [f64; 5], // [T, C, Z, Y, X]
}

/// Deserialized from a level's zarr.json, or rewritten from its `.zarray`.
#[derive(Debug, Deserialize)]
pub struct ArrayMeta {
    pub shape: Vec<u64>, // N-dimensional (matches axes count)
    pub data_type: String,
    pub chunk_grid: ChunkGrid,
    #[serde(default)]
    pub codecs: Vec<serde_json::Value>,
    #[serde(default)]
    pub fill_value: serde_json::Value,
    #[serde(default)]
    pub chunk_key_encoding: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGrid {
    pub configuration: ChunkGridConfig,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGridConfig {
    pub chunk_shape: Vec<u64>, // N-dimensional (matches axes count)
}

/// Which Zarr version a dataset is stored in. One hierarchy is one version,
/// so the dataset's root decides it for every group and array beneath.
///
/// A hierarchy may also have copied every metadata document into its root:
/// a Zarr v2 `.zmetadata`, or the `consolidated_metadata` a Zarr v3 root
/// `zarr.json` holds inline. A document found there is read from there, as
/// zarr-python reads a consolidated hierarchy, which saves a round trip per
/// group and per level.
#[derive(Debug, Clone)]
pub(crate) enum ZarrFormat {
    V2 { consolidated: Option<Documents> },
    V3 { consolidated: Option<Documents> },
}

/// Consolidated metadata documents, keyed by the object path each copies.
type Documents = Arc<serde_json::Map<String, serde_json::Value>>;

impl ZarrFormat {
    /// The object holding the metadata of the group at `prefix`, or of the
    /// dataset root when `prefix` is empty.
    pub(crate) fn group_key(&self, prefix: &str) -> String {
        let name = match self {
            ZarrFormat::V2 { .. } => ".zattrs",
            ZarrFormat::V3 { .. } => "zarr.json",
        };
        join(prefix, name)
    }

    /// The object holding the metadata of the array at `prefix`.
    fn array_key(&self, prefix: &str) -> String {
        let name = match self {
            ZarrFormat::V2 { .. } => ".zarray",
            ZarrFormat::V3 { .. } => "zarr.json",
        };
        join(prefix, name)
    }

    /// The chunk key encoding a level most likely uses, before its own
    /// metadata says: v3's default, or the nested keys OME-Zarr writes in v2.
    pub(crate) fn likely_chunk_key_encoding(&self) -> ChunkKeyEncoding {
        match self {
            ZarrFormat::V2 { .. } => ChunkKeyEncoding::V2 { separator: '/' },
            ZarrFormat::V3 { .. } => ChunkKeyEncoding::default(),
        }
    }

    /// A group's metadata, as its v3 `zarr.json` would say it.
    pub(crate) fn group_json(
        &self,
        key: &str,
        bytes: &[u8],
    ) -> Result<serde_json::Value, StoreError> {
        let value = serde_json::from_slice(bytes)
            .map_err(|e| StoreError::malformed_metadata(format!("invalid JSON in {key}: {e}")))?;
        Ok(match self {
            ZarrFormat::V2 { .. } => zarr_v2::group(value),
            ZarrFormat::V3 { .. } => value,
        })
    }

    /// The consolidated copy of the document at `key`, if there is one.
    fn consolidated(&self, key: &str) -> Option<Bytes> {
        let document = self.documents()?.get(key)?;
        Some(Bytes::from(serde_json::to_vec(document).ok()?))
    }

    /// The metadata document at `key`: its consolidated copy, or the object.
    pub(crate) async fn document(
        &self,
        store: &CachedStore,
        key: &str,
    ) -> Result<Bytes, object_store::Error> {
        match self.consolidated(key) {
            Some(bytes) => Ok(bytes),
            None => store.get_metadata_bytes(&Path::from(key)).await,
        }
    }

    /// [`Self::document`] for one that may not exist. Consolidated metadata
    /// covers the whole hierarchy, so a document it lacks is absent, as
    /// zarr-python reads it, and costs no read.
    async fn optional_document(
        &self,
        store: &CachedStore,
        key: &str,
    ) -> Result<Option<Bytes>, object_store::Error> {
        match self.documents() {
            Some(_) => Ok(self.consolidated(key)),
            None => store.get_optional_metadata_bytes(&Path::from(key)).await,
        }
    }

    fn documents(&self) -> Option<&Documents> {
        match self {
            ZarrFormat::V2 { consolidated } | ZarrFormat::V3 { consolidated } => {
                consolidated.as_ref()
            }
        }
    }
}

/// The documents of a `.zmetadata`, keyed by object path, or `None` when it
/// is not Zarr v2 consolidated metadata. Consolidation only saves reads, so
/// one that cannot be used is passed over, never fatal.
fn consolidated_documents(bytes: &[u8]) -> Option<serde_json::Map<String, serde_json::Value>> {
    let value: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(e) => {
            tracing::warn!(error = %e, "import.consolidated_metadata.malformed");
            return None;
        }
    };
    if value
        .get("zarr_consolidated_format")
        .and_then(|v| v.as_u64())
        != Some(1)
    {
        tracing::warn!("import.consolidated_metadata.unknown_format");
        return None;
    }
    match value.get("metadata") {
        Some(serde_json::Value::Object(documents)) => Some(documents.clone()),
        _ => {
            tracing::warn!("import.consolidated_metadata.no_documents");
            None
        }
    }
}

/// The documents a Zarr v3 root's inline `consolidated_metadata` copies,
/// keyed by the `zarr.json` each stands for, or `None` when it holds none
/// lucida can use. Its keys are node paths, `A/1/0`, where a document is read
/// as `A/1/0/zarr.json`.
fn inline_consolidated_documents(
    consolidated: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    if consolidated.is_null() {
        return None;
    }
    if consolidated.get("kind").and_then(|v| v.as_str()) != Some("inline") {
        tracing::warn!("import.consolidated_metadata.unknown_format");
        return None;
    }
    let Some(serde_json::Value::Object(nodes)) = consolidated.get("metadata") else {
        tracing::warn!("import.consolidated_metadata.no_documents");
        return None;
    };
    Some(
        nodes
            .iter()
            .map(|(path, document)| (join(path, "zarr.json"), document.clone()))
            .collect(),
    )
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Read the dataset root's group metadata and tell which Zarr version holds
/// it. A v3 root costs the one read it always has, and carries any
/// consolidated metadata inside it. Only a dataset with no `zarr.json` is
/// asked for a v2 `.zattrs`, and for its `.zmetadata` in the same round
/// trip, so a hierarchy that consolidated nothing pays no extra wait for the
/// chance.
pub(crate) async fn read_root(
    store: &Arc<CachedStore>,
) -> Result<(ZarrFormat, serde_json::Value), StoreError> {
    if let Some(bytes) = store
        .get_optional_metadata_bytes(&Path::from("zarr.json"))
        .await?
    {
        let mut root = ZarrFormat::V3 { consolidated: None }.group_json("zarr.json", &bytes)?;
        // The copies can be most of the root's bytes, so the root handed on
        // leaves them out.
        let inline = root
            .as_object_mut()
            .and_then(|object| object.remove("consolidated_metadata"));
        let consolidated =
            inline
                .as_ref()
                .and_then(inline_consolidated_documents)
                .map(|mut documents| {
                    // The copies cover the whole hierarchy, the root included.
                    documents.insert("zarr.json".to_string(), root.clone());
                    Arc::new(documents)
                });
        return Ok((ZarrFormat::V3 { consolidated }, root));
    }
    let (zattrs_key, zmetadata_key) = (Path::from(".zattrs"), Path::from(".zmetadata"));
    let (zattrs, zmetadata) = tokio::join!(
        store.get_optional_metadata_bytes(&zattrs_key),
        store.get_optional_metadata_bytes(&zmetadata_key),
    );
    let consolidated = zmetadata?.and_then(|bytes| consolidated_documents(&bytes));
    let found = consolidated.is_some();
    let format = ZarrFormat::V2 {
        consolidated: consolidated.map(Arc::new),
    };
    let attributes = match zattrs? {
        Some(bytes) => bytes,
        None => match format.consolidated(".zattrs") {
            Some(bytes) => bytes,
            // A consolidated group with no attributes is still a group.
            None if found => Bytes::from_static(b"{}"),
            None => {
                return Err(StoreError::missing_metadata(
                    "no zarr.json (Zarr v3) or .zattrs (Zarr v2) at the dataset root",
                ));
            }
        },
    };
    let root = format.group_json(".zattrs", &attributes)?;
    Ok((format, root))
}

/// Read and parse the metadata of the group at `prefix`.
pub(crate) async fn read_group(
    store: &Arc<CachedStore>,
    format: &ZarrFormat,
    prefix: &str,
) -> Result<serde_json::Value, StoreError> {
    let key = format.group_key(prefix);
    let bytes = format.document(store, &key).await?;
    format.group_json(&key, &bytes)
}

/// Upper bound on attribute keys echoed back in a missing-block error. Enough
/// to identify what a group actually carries without pasting an arbitrarily
/// large key list into a message.
const MAX_REPORTED_ATTRIBUTE_KEYS: usize = 12;

/// Upper bound on the length of a single echoed attribute key. Key *names* are
/// untrusted too, not just their count — without this one multi-megabyte name
/// would land verbatim in an error string.
const MAX_REPORTED_KEY_CHARS: usize = 64;

/// The attribute map a group's OME blocks are read from, plus the dotted path
/// naming it for diagnostics.
struct AttributeScope<'a> {
    path: &'static str,
    map: &'a serde_json::Map<String, serde_json::Value>,
}

/// Pick the single attribute map that owns this group's OME blocks.
///
/// OME-Zarr 0.5 nests every block under `attributes.ome`; 0.4, and Zarr v3
/// writers that predate the 0.5 layout, put the same keys at the top level.
/// Both are read. The choice is made once per group, never per block: an
/// object `attributes.ome` is the sole source, so a stray top-level key
/// cannot satisfy a 0.5 block. A non-object `ome` falls back to the top
/// level. `None` only when there is no `attributes` object.
fn ome_scope(root_json: &serde_json::Value) -> Option<AttributeScope<'_>> {
    let attributes = root_json.get("attributes")?.as_object()?;
    Some(match attributes.get("ome").and_then(|v| v.as_object()) {
        Some(ome) => AttributeScope {
            path: "attributes.ome",
            map: ome,
        },
        None => AttributeScope {
            path: "attributes",
            map: attributes,
        },
    })
}

/// Resolve one OME metadata block (`multiscales`, `omero`, `plate`, …) from a
/// `zarr.json` value, from whichever attribute placement [`ome_scope`] selects
/// for the group.
pub(crate) fn resolve_ome_block<'a>(
    root_json: &'a serde_json::Value,
    block: &str,
) -> Option<&'a serde_json::Value> {
    ome_scope(root_json)?.map.get(block)
}

/// Which kind of dataset a root holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    Image,
    Collection,
}

/// What a dataset root's group metadata says it holds: a collection when it
/// lays out tiles (OME `plate`), else an image when it carries multiscales.
/// `None` for a group with neither, which does not open as a dataset.
pub(crate) fn root_kind(root_json: &serde_json::Value) -> Option<RootKind> {
    if resolve_ome_block(root_json, "plate").is_some() {
        Some(RootKind::Collection)
    } else if resolve_ome_block(root_json, "multiscales").is_some() {
        Some(RootKind::Image)
    } else {
        None
    }
}

/// Explain a missing OME metadata block in terms a user can act on: which
/// placements were checked, and what the group actually carries instead.
///
/// `block` is the unqualified key (e.g. `multiscales`). Untrusted-input safe:
/// the echoed key list is bounded both in count
/// ([`MAX_REPORTED_ATTRIBUTE_KEYS`], with the remainder counted rather than
/// silently dropped) and in per-key length ([`MAX_REPORTED_KEY_CHARS`]).
pub(crate) fn describe_missing_ome_block(root_json: &serde_json::Value, block: &str) -> String {
    let v2 = root_json.get("zarr_format").and_then(|v| v.as_u64()) == Some(2);
    let mut msg = if v2 {
        format!(
            "no OME-Zarr {block} metadata in .zattrs: expected a top-level `{block}` key \
             (OME-NGFF 0.4)"
        )
    } else {
        format!(
            "no OME-Zarr {block} metadata in zarr.json: expected `attributes.ome.{block}` \
             (OME-Zarr 0.5) or `attributes.{block}` (0.4-style placement)"
        )
    };

    if root_json.get("node_type").and_then(|v| v.as_str()) == Some("array") {
        msg.push_str(&format!(
            "; this path is a Zarr array, not a group — point at the parent group that \
             carries the {block} metadata"
        ));
        return msg;
    }

    // Report the keys actually present, in whichever scope was searched, so the
    // user can see what the group does carry.
    let Some(scope) = ome_scope(root_json) else {
        msg.push_str("; this group has no attributes at all");
        return msg;
    };

    let scope_name = if v2 { ".zattrs" } else { scope.path };
    if scope.map.is_empty() {
        msg.push_str(&format!("; {scope_name} is empty"));
        return msg;
    }

    let shown: Vec<String> = scope
        .map
        .keys()
        .take(MAX_REPORTED_ATTRIBUTE_KEYS)
        .map(|key| truncate_for_message(key))
        .collect();
    msg.push_str(&format!("; {scope_name} has: {}", shown.join(", ")));
    if let Some(rest) = scope.map.len().checked_sub(MAX_REPORTED_ATTRIBUTE_KEYS)
        && rest > 0
    {
        msg.push_str(&format!(" (+{rest} more)"));
    }
    msg
}

/// Clamp one untrusted key to [`MAX_REPORTED_KEY_CHARS`] characters, marking
/// any elision. Counts characters, not bytes, so it never splits a UTF-8
/// sequence.
fn truncate_for_message(key: &str) -> String {
    if key.chars().count() <= MAX_REPORTED_KEY_CHARS {
        return key.to_string();
    }
    let head: String = key.chars().take(MAX_REPORTED_KEY_CHARS).collect();
    format!("{head}…")
}

/// Parsed OME multiscales metadata.
#[derive(Debug)]
pub(crate) struct ParsedMultiscales {
    pub axes_names: Vec<String>,
    pub level_entries: Vec<LevelEntry>,
    /// The multiscale's `type`: the method the writer used to derive each
    /// coarser level, kept verbatim. `None` when the writer declared none or
    /// left it blank.
    pub downsampling_method: Option<String>,
    /// The units the axes name and where level 0's origin sits.
    pub space: PhysicalSpace,
}

/// Parse OME multiscales from a root zarr.json value.
/// `error_prefix` is prepended to error messages (e.g., "A/1/0: " for collections).
pub(crate) fn parse_multiscales(
    root_json: &serde_json::Value,
    error_prefix: &str,
) -> Result<ParsedMultiscales, StoreError> {
    let multiscales = resolve_ome_block(root_json, "multiscales")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            StoreError::missing_metadata(format!(
                "{error_prefix}{}",
                describe_missing_ome_block(root_json, "multiscales")
            ))
        })?;

    let ms = multiscales.first().ok_or_else(|| {
        StoreError::malformed_metadata(format!("{error_prefix}multiscales array is empty"))
    })?;

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
        .ok_or_else(|| {
            StoreError::malformed_metadata(format!("{error_prefix}no datasets in multiscales"))
        })?;

    // A scale on the multiscale itself applies after each level's own, so it
    // multiplies every level's.
    let shared_scale = declared_scale(ms, &axes_names);
    let shared_translation = declared_translation(ms, &axes_names);

    let mut level_entries: Vec<LevelEntry> = Vec::new();
    let mut origin = [0.0; 3];
    for ds in datasets_arr {
        let path = ds
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                StoreError::malformed_metadata(format!("{error_prefix}dataset entry missing path"))
            })?
            .to_string();

        let own = declared_scale(ds, &axes_names); // [T, C, Z, Y, X]
        let scale = std::array::from_fn(|axis| own[axis] * shared_scale[axis]);
        if level_entries.is_empty() {
            // The multiscale's transforms apply after level 0's, so its scale
            // stretches level 0's translation before its own is added.
            let own = declared_translation(ds, &axes_names);
            origin = std::array::from_fn(|i| {
                let axis = i + 2;
                own[axis] * shared_scale[axis] + shared_translation[axis]
            });
        }
        level_entries.push(LevelEntry { path, scale });
    }

    if level_entries.is_empty() {
        return Err(StoreError::malformed_metadata(format!(
            "{error_prefix}no levels found"
        )));
    }

    let downsampling_method = ms
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let space = PhysicalSpace {
        units: ["z", "y", "x"].map(|name| axis_unit(&axes_json, name)),
        origin,
    };

    Ok(ParsedMultiscales {
        axes_names,
        level_entries,
        downsampling_method,
        space,
    })
}

/// The unit the axis called `name` declares, or `None` when it declares none.
fn axis_unit(axes_json: &[serde_json::Value], name: &str) -> Option<String> {
    axes_json
        .iter()
        .find(|axis| {
            axis.get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })?
        .get("unit")?
        .as_str()
        .map(str::trim)
        .filter(|unit| !unit.is_empty())
        .map(str::to_string)
}

/// The `scale` transform among `node`'s `coordinateTransformations`, as
/// `[T, C, Z, Y, X]`, or all ones when it declares none.
fn declared_scale(node: &serde_json::Value, axes_names: &[String]) -> [f64; 5] {
    let mut scale = [1.0_f64; 5];
    for ct in node
        .get("coordinateTransformations")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        if ct.get("type").and_then(|v| v.as_str()) == Some("scale")
            && let Some(s) = ct.get("scale").and_then(|v| v.as_array())
        {
            let raw: Vec<f64> = s.iter().filter_map(|v| v.as_f64()).collect();
            scale = normalize_f64_to_5d(&raw, axes_names, 1.0);
        }
    }
    scale
}

/// The `translation` transform among `node`'s `coordinateTransformations`, as
/// `[T, C, Z, Y, X]`, or all zeros when it declares none.
fn declared_translation(node: &serde_json::Value, axes_names: &[String]) -> [f64; 5] {
    let mut translation = [0.0_f64; 5];
    for ct in node
        .get("coordinateTransformations")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        if ct.get("type").and_then(|v| v.as_str()) == Some("translation")
            && let Some(t) = ct.get("translation").and_then(|v| v.as_array())
        {
            let raw: Vec<f64> = t.iter().filter_map(|v| v.as_f64()).collect();
            if raw.len() == axes_names.len() && raw.iter().all(|v| v.is_finite()) {
                translation = normalize_f64_to_5d(&raw, axes_names, 0.0);
            }
        }
    }
    translation
}

/// Parse per-channel display info from the OME `omero.channels` block of a
/// root (or tile) `zarr.json` value.
///
/// Generic and safe on untrusted input: the block is optional and often
/// wrong, so this never panics, errors, or mislabels.
///
/// - A missing or non-array `channels` → empty `Vec` (caller falls back to `Channel n`).
/// - A usable label is a non-blank string, and a usable color a non-blank
///   string, carried verbatim.
/// - Results stay aligned to channel index: a channel with a color but no
///   label, or with neither in the middle, gets the `Channel n` fallback
///   label, counted from 1 like every other channel name, so later entries
///   still line up. A trailing run with neither is dropped, and no usable
///   label or color at all → empty.
///
/// Not reconciled against the C-axis size: parse stays a pure function of
/// the metadata, and the web falls back per index beyond the list.
pub(crate) fn parse_omero_channels(root_json: &serde_json::Value) -> Vec<ChannelInfo> {
    let Some(channels) = resolve_ome_block(root_json, "omero")
        .and_then(|omero| omero.get("channels"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    let usable = |entry: &serde_json::Value, key: &str| {
        entry
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let parsed: Vec<(Option<String>, Option<String>)> = channels
        .iter()
        .map(|entry| (usable(entry, "label"), usable(entry, "color")))
        .collect();

    // The web falls back per index, so there's nothing to keep past the last
    // channel that declares something.
    let Some(last) = parsed
        .iter()
        .rposition(|(label, color)| label.is_some() || color.is_some())
    else {
        return Vec::new();
    };

    parsed
        .into_iter()
        .take(last + 1)
        .enumerate()
        .map(|(i, (label, color))| ChannelInfo {
            label: label.unwrap_or_else(|| format!("Channel {}", i + 1)),
            color,
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
    Parsed(serde_json::Value),
    /// The object could not be used: the read failed with an error other
    /// than NotFound, or the bytes were not valid JSON. Logged, never fatal.
    Unusable,
}

/// Read and parse the metadata of a group that may not exist, without
/// treating absence or corruption as an error.
///
/// Detects optional child groups (e.g. a `labels/` group). A missing object
/// is the common case and yields [`OptionalZarrJson::Absent`] silently; a
/// present-but-corrupt object (bad JSON) or any other storage error yields
/// [`OptionalZarrJson::Unusable`] with a logged warning. Optional metadata
/// must never fail the whole import — the caller proceeds either way, but can
/// tell a definitive miss from an anomaly.
pub(crate) async fn read_optional_group(
    store: &Arc<CachedStore>,
    format: &ZarrFormat,
    prefix: &str,
) -> OptionalZarrJson {
    let path = format.group_key(prefix);
    match format.optional_document(store, &path).await {
        Ok(Some(bytes)) => match format.group_json(&path, &bytes) {
            Ok(value) => OptionalZarrJson::Parsed(value),
            Err(e) => {
                tracing::warn!(path = %path, error = %e, "import.optional_metadata.malformed");
                OptionalZarrJson::Unusable
            }
        },
        Ok(None) => OptionalZarrJson::Absent,
        Err(e) => {
            tracing::warn!(path = %path, error = %e, "import.optional_metadata.unreadable");
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
/// Generic and untrusted-input safe: a missing/non-array `labels` yields an
/// empty `Vec`; non-string or unsafe entries are dropped; duplicate names are
/// deduped (first occurrence wins, order preserved); and the count is capped at
/// [`MAX_LABEL_GROUPS`]. The returned names are safe to use as store-path
/// segments.
pub(crate) fn parse_labels_names(labels_group_json: &serde_json::Value) -> Vec<String> {
    let Some(entries) = resolve_ome_block(labels_group_json, "labels").and_then(|v| v.as_array())
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
    /// Names from the property table, in declared order; empty when it names none.
    pub names: Vec<LabelName>,
    /// Whether `image-label.source.image` was present (a declared back-pointer
    /// to the source intensity image).
    pub source_declared: bool,
}

/// Parse the `attributes.ome.image-label` block of a label group's zarr.json.
///
/// Generic and untrusted-input safe: a missing `image-label` yields the default
/// (no colors, no declared source). Each color entry must carry an integer
/// `label-value` (kept as `i64` — never truncated, since ids exceed 16 bits)
/// and an `rgba` array of exactly four `0..=255` integers; malformed entries
/// are skipped individually and the kept count is capped at
/// [`MAX_LABEL_COLORS`]. Of `properties`, only each entry's name is kept
/// (see [`parse_label_name`]).
pub(crate) fn parse_image_label(label_group_json: &serde_json::Value) -> ImageLabelMeta {
    let Some(image_label) = resolve_ome_block(label_group_json, "image-label") else {
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
                .collect()
        })
        .unwrap_or_default();

    let names = image_label
        .get("properties")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(parse_label_name)
                .take(MAX_LABEL_NAMES)
                .collect()
        })
        .unwrap_or_default();

    ImageLabelMeta {
        colors,
        names,
        source_declared,
    }
}

/// The name one `image-label.properties` entry gives its integer `label-value`:
/// the first non-blank string under [`LABEL_NAME_KEYS`]. `None` drops the entry.
fn parse_label_name(entry: &serde_json::Value) -> Option<LabelName> {
    let value = entry.get("label-value")?.as_i64()?;
    let name = LABEL_NAME_KEYS
        .iter()
        .filter_map(|key| entry.get(*key)?.as_str())
        .map(str::trim)
        .find(|name| !name.is_empty())?;
    Some(LabelName {
        value,
        name: name.chars().take(MAX_LABEL_NAME_CHARS).collect(),
    })
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
///
/// The levels are read concurrently, so a pyramid costs one round trip of
/// wall time rather than one per level.
pub(crate) async fn read_level_metas(
    store: &Arc<CachedStore>,
    format: &ZarrFormat,
    base_prefix: &str,
    level_entries: &[LevelEntry],
) -> Result<Vec<ArrayMeta>, StoreError> {
    let reads = level_entries.iter().map(|entry| {
        let level = join(base_prefix, &entry.path);
        async move {
            let level_bytes = format.document(store, &format.array_key(&level)).await?;
            match format {
                ZarrFormat::V2 { .. } => zarr_v2::array_meta(&level_bytes),
                ZarrFormat::V3 { .. } => {
                    serde_json::from_slice::<ArrayMeta>(&level_bytes).map_err(|e| e.to_string())
                }
            }
            .map_err(|e| StoreError::malformed_metadata(format!("{level}: {e}")))
        }
    });
    futures_util::future::try_join_all(reads).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consolidated_metadata_is_used_only_when_it_is_what_it_says() {
        let documents = consolidated_documents(
            br#"{"zarr_consolidated_format": 1, "metadata": {"0/.zarray": {"shape": [1]}}}"#,
        )
        .unwrap();
        assert_eq!(documents["0/.zarray"]["shape"], serde_json::json!([1]));
        for unusable in [
            &b"not json"[..],
            br#"{"zarr_consolidated_format": 2, "metadata": {}}"#,
            br#"{"zarr_consolidated_format": 1}"#,
        ] {
            assert!(consolidated_documents(unusable).is_none());
        }
    }

    /// A document the consolidated copy holds is read from it; one it lacks
    /// is absent without a read, as zarr-python reads a consolidated
    /// hierarchy.
    #[tokio::test]
    async fn a_consolidated_hierarchy_answers_from_its_copy() {
        let store = Arc::new(CachedStore::new(
            Arc::new(object_store::memory::InMemory::new()),
            1 << 20,
        ));
        let documents = consolidated_documents(
            br#"{"zarr_consolidated_format": 1, "metadata": {"A/.zattrs": {"well": {}}}}"#,
        );
        let format = ZarrFormat::V2 {
            consolidated: documents.map(Arc::new),
        };
        let group = read_group(&store, &format, "A").await.unwrap();
        assert!(group["attributes"]["well"].is_object());
        assert!(matches!(
            read_optional_group(&store, &format, "A/labels").await,
            OptionalZarrJson::Absent
        ));
        assert_eq!(store.stats().source_reads, 0);
    }

    #[test]
    fn inline_consolidated_metadata_is_keyed_by_the_documents_it_copies() {
        let consolidated = serde_json::json!({
            "kind": "inline",
            "must_understand": false,
            "metadata": {"A": {"node_type": "group"}, "A/1/0": {"node_type": "array"}}
        });
        let documents = inline_consolidated_documents(&consolidated).unwrap();
        assert_eq!(documents["A/zarr.json"]["node_type"], "group");
        assert_eq!(documents["A/1/0/zarr.json"]["node_type"], "array");
        for unusable in [
            serde_json::json!(null),
            serde_json::json!({"kind": "external", "metadata": {}}),
            serde_json::json!({"kind": "inline"}),
            serde_json::json!({"kind": "inline", "metadata": []}),
        ] {
            assert!(
                inline_consolidated_documents(&unusable).is_none(),
                "{unusable}"
            );
        }
    }

    /// A v3 root's inline copies answer for the hierarchy, and the root
    /// handed back no longer carries them.
    #[tokio::test]
    async fn a_consolidated_v3_root_answers_from_its_copy() {
        let memory = Arc::new(object_store::memory::InMemory::new());
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {"version": "0.5"}},
            "consolidated_metadata": {
                "kind": "inline",
                "must_understand": false,
                "metadata": {"A": {"zarr_format": 3, "node_type": "group", "attributes": {"ome": {"well": {}}}}}
            }
        });
        use object_store::ObjectStoreExt;
        memory
            .put(
                &Path::from("zarr.json"),
                serde_json::to_vec(&root).unwrap().into(),
            )
            .await
            .unwrap();
        let store = Arc::new(CachedStore::new(memory, 1 << 20));

        let (format, root) = read_root(&store).await.unwrap();
        assert!(root.get("consolidated_metadata").is_none());
        assert!(root["attributes"]["ome"].is_object());
        let reads = store.stats().source_reads;
        assert_eq!(read_group(&store, &format, "").await.unwrap(), root);
        let group = read_group(&store, &format, "A").await.unwrap();
        assert!(group["attributes"]["ome"]["well"].is_object());
        assert!(matches!(
            read_optional_group(&store, &format, "A/labels").await,
            OptionalZarrJson::Absent
        ));
        assert_eq!(store.stats().source_reads, reads);
    }

    /// A scale on the multiscale itself multiplies each level's own.
    #[test]
    fn a_multiscale_wide_scale_multiplies_every_level_s() {
        let group = zarr_v2::group(serde_json::json!({
            "multiscales": [{
                "version": "0.4",
                "axes": [{"name": "y", "type": "space"}, {"name": "x", "type": "space"}],
                "datasets": [
                    {"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [1.0, 1.0]}]},
                    {"path": "1", "coordinateTransformations": [{"type": "scale", "scale": [2.0, 2.0]}]}
                ],
                "coordinateTransformations": [{"type": "scale", "scale": [0.5, 3.0]}]
            }]
        }));
        let parsed = parse_multiscales(&group, "").unwrap();
        assert_eq!(parsed.level_entries[0].scale, [1.0, 1.0, 1.0, 0.5, 3.0]);
        assert_eq!(parsed.level_entries[1].scale, [1.0, 1.0, 1.0, 1.0, 6.0]);
    }

    #[test]
    fn a_missing_block_in_zarr_v2_metadata_is_explained_in_its_terms() {
        let group = zarr_v2::group(serde_json::json!({"other": 1}));
        let message = describe_missing_ome_block(&group, "multiscales");
        assert!(message.contains(".zattrs"), "{message}");
        assert!(message.contains("OME-NGFF 0.4"), "{message}");
        assert!(message.contains("has: other"), "{message}");
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
        assert_eq!(parsed.downsampling_method, None);
        assert!(parsed.space.is_unset());
    }

    #[test]
    fn parse_multiscales_reads_units_and_the_level_zero_origin() {
        let root_json = serde_json::json!({
            "attributes": {
                "ome": {
                    "multiscales": [{
                        "axes": [
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space", "unit": "nanometer"},
                            {"name": "y", "type": "space", "unit": "micrometer"},
                            {"name": "x", "type": "space", "unit": " micrometer "}
                        ],
                        "datasets": [
                            {
                                "path": "0",
                                "coordinateTransformations": [
                                    {"type": "scale", "scale": [1.0, 2.0, 0.5, 0.5]},
                                    {"type": "translation", "translation": [0.0, 3.0, 10.0, 20.0]}
                                ]
                            },
                            {
                                "path": "1",
                                "coordinateTransformations": [
                                    {"type": "scale", "scale": [1.0, 4.0, 1.0, 1.0]},
                                    {"type": "translation", "translation": [0.0, 99.0, 99.0, 99.0]}
                                ]
                            }
                        ],
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1.0, 1.0, 2.0, 2.0]},
                            {"type": "translation", "translation": [0.0, 0.0, 1.0, -1.0]}
                        ]
                    }]
                }
            }
        });

        let parsed = parse_multiscales(&root_json, "").unwrap();

        assert_eq!(
            parsed.space.units,
            [
                Some("nanometer".to_string()),
                Some("micrometer".to_string()),
                Some("micrometer".to_string()),
            ]
        );
        // Level 0's translation, stretched by the multiscale's scale, plus the
        // multiscale's own translation. Coarser levels' translations are not
        // the image's origin.
        assert_eq!(parsed.space.origin, [3.0, 21.0, 39.0]);
    }

    fn multiscales_with_type(type_value: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "version": "0.5",
                        "type": type_value,
                        "axes": [
                            {"name": "y", "type": "space"},
                            {"name": "x", "type": "space"}
                        ],
                        "datasets": [{"path": "0"}]
                    }]
                }
            }
        })
    }

    #[test]
    fn parse_multiscales_keeps_the_declared_downsampling_method() {
        let parsed = parse_multiscales(&multiscales_with_type("gaussian".into()), "").unwrap();
        assert_eq!(parsed.downsampling_method.as_deref(), Some("gaussian"));
    }

    #[test]
    fn parse_multiscales_trims_the_downsampling_method_and_drops_a_blank_one() {
        let padded = parse_multiscales(&multiscales_with_type("  mean ".into()), "").unwrap();
        assert_eq!(padded.downsampling_method.as_deref(), Some("mean"));

        let blank = parse_multiscales(&multiscales_with_type("   ".into()), "").unwrap();
        assert_eq!(blank.downsampling_method, None);

        let not_a_string = parse_multiscales(&multiscales_with_type(7.into()), "").unwrap();
        assert_eq!(not_a_string.downsampling_method, None);
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

    #[test]
    fn parse_multiscales_missing_error_names_both_placements_and_found_keys() {
        // The message must tell a user what was looked for and what the group
        // actually carries, not just that a pointer missed.
        let root_json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"acquisition": {}, "producer": "somewriter"}
        });
        let msg = parse_multiscales(&root_json, "").unwrap_err().to_string();
        assert!(
            msg.contains("attributes.ome.multiscales"),
            "must name the 0.5 placement: {msg}",
        );
        assert!(
            msg.contains("attributes.multiscales"),
            "must name the 0.4-style placement: {msg}",
        );
        assert!(
            msg.contains("acquisition") && msg.contains("producer"),
            "must list the attribute keys that are present: {msg}",
        );
    }

    #[test]
    fn parse_multiscales_missing_error_reports_empty_attributes() {
        let root_json =
            serde_json::json!({"zarr_format": 3, "node_type": "group", "attributes": {}});
        let msg = parse_multiscales(&root_json, "").unwrap_err().to_string();
        assert!(
            msg.contains("attributes is empty"),
            "an attribute-less group should say so plainly: {msg}",
        );
    }

    #[test]
    fn parse_multiscales_missing_error_distinguishes_no_attributes_from_empty_ones() {
        // No `attributes` key at all is a different state from an attributes
        // object that happens to be empty, and neither may be reported as the
        // other.
        let absent = serde_json::json!({"zarr_format": 3, "node_type": "group"});
        let msg = parse_multiscales(&absent, "").unwrap_err().to_string();
        assert!(
            msg.contains("no attributes at all"),
            "a group with no attributes key should say so: {msg}",
        );

        // An `ome` namespace that exists but is empty must report the namespace
        // as empty, not claim the group has no attributes.
        let empty_ome = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {}, "producer": "somewriter"}
        });
        let msg = parse_multiscales(&empty_ome, "").unwrap_err().to_string();
        assert!(
            msg.contains("attributes.ome is empty"),
            "an empty ome namespace should be named as such: {msg}",
        );
        assert!(
            !msg.contains("no attributes at all"),
            "the group does have attributes; must not claim otherwise: {msg}",
        );
    }

    #[test]
    fn parse_multiscales_missing_error_counts_keys_beyond_the_cap() {
        // A truncated list must not read as an exhaustive one.
        let attrs: serde_json::Map<String, serde_json::Value> = (0..(MAX_REPORTED_ATTRIBUTE_KEYS
            + 5))
            .map(|i| (format!("k{i:02}"), serde_json::json!(i)))
            .collect();
        let root_json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": attrs
        });
        let msg = parse_multiscales(&root_json, "").unwrap_err().to_string();
        assert!(msg.contains("(+5 more)"), "must count the remainder: {msg}");
    }

    #[test]
    fn parse_multiscales_missing_error_clamps_an_oversized_key() {
        // Key names are untrusted too: one huge name must not be echoed whole.
        let huge = "k".repeat(50_000);
        let root_json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {huge.clone(): 1}
        });
        let msg = parse_multiscales(&root_json, "").unwrap_err().to_string();
        assert!(
            !msg.contains(&huge),
            "must not echo the whole key: {}",
            msg.len()
        );
        assert!(msg.contains('…'), "must mark the elision: {msg}");
        assert!(msg.len() < 500, "message must stay bounded: {}", msg.len());
    }

    #[test]
    fn parse_multiscales_missing_error_flags_a_zarr_array() {
        // Pointing at an array instead of its parent group is a common
        // mistake; the message should say which way to go.
        let root_json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [10, 10],
            "attributes": {}
        });
        let msg = parse_multiscales(&root_json, "").unwrap_err().to_string();
        assert!(
            msg.contains("array"),
            "must say the path is a Zarr array: {msg}",
        );
        assert!(
            msg.contains("group"),
            "must point the user at the parent group: {msg}",
        );
    }

    #[test]
    fn missing_block_message_names_the_block_it_was_asked_about() {
        // The diagnostic serves every OME block, so no wording may hardcode
        // `multiscales` — a collection's missing `plate` must read as `plate`.
        let array = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "attributes": {}
        });
        let msg = describe_missing_ome_block(&array, "plate");
        assert!(msg.contains("attributes.ome.plate"), "{msg}");
        assert!(
            msg.contains("the plate metadata"),
            "the array hint must name the requested block, not multiscales: {msg}",
        );
        assert!(!msg.contains("multiscale"), "{msg}");
    }

    /// A Zarr v3 group written with the OME-Zarr 0.4 top-level attribute
    /// placement: `attributes.multiscales` rather than
    /// `attributes.ome.multiscales`. Produced by writers that adopted Zarr v3
    /// while keeping the 0.4 metadata conventions.
    #[test]
    fn parse_multiscales_accepts_top_level_placement() {
        let root_json = serde_json::json!({
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
                }]
            }
        });

        let parsed = parse_multiscales(&root_json, "").unwrap();

        assert_eq!(parsed.axes_names, vec!["m", "p", "t", "z", "c", "y", "x"]);
        assert_eq!(parsed.level_entries.len(), 2);
        // Non-canonical m/p contribute no scale; y/x pick up the level-1 8x.
        assert_eq!(parsed.level_entries[0].scale, [1.0, 1.0, 1.0, 1.0, 1.0]);
        assert_eq!(parsed.level_entries[1].scale, [1.0, 1.0, 1.0, 8.0, 8.0]);
    }

    #[test]
    fn ome_namespace_wins_over_top_level_when_both_present() {
        // A conformant 0.5 group is read from `ome` even if stray top-level
        // keys of the same name exist — the namespace is never mixed.
        let root_json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "multiscales": [{
                    "axes": [{"name": "y"}, {"name": "x"}],
                    "datasets": [{"path": "stale"}]
                }],
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "axes": [{"name": "y"}, {"name": "x"}],
                        "datasets": [{"path": "current"}]
                    }]
                }
            }
        });
        let parsed = parse_multiscales(&root_json, "").unwrap();
        assert_eq!(parsed.level_entries[0].path, "current");
    }

    #[test]
    fn non_object_ome_falls_back_to_top_level() {
        // Defensive: a junk `ome` value must not shadow readable 0.4-style
        // attributes.
        let root_json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": "0.4",
                "multiscales": [{
                    "axes": [{"name": "y"}, {"name": "x"}],
                    "datasets": [{"path": "0"}]
                }]
            }
        });
        let parsed = parse_multiscales(&root_json, "").unwrap();
        assert_eq!(parsed.level_entries[0].path, "0");
    }

    #[test]
    fn omero_channels_read_from_top_level_placement() {
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "multiscales": [],
                "omero": {"channels": [{"label": "Ch A"}, {"label": "Ch B"}]}
            }
        });
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].label, "Ch A");
        assert_eq!(infos[1].label, "Ch B");
    }

    #[test]
    fn labels_names_read_from_top_level_placement() {
        let json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"labels": ["region-a", "region-b"]}
        });
        assert_eq!(parse_labels_names(&json), vec!["region-a", "region-b"]);
    }

    #[test]
    fn image_label_read_from_top_level_placement() {
        let json = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "image-label": {
                    "colors": [{"label-value": 7, "rgba": [1, 2, 3, 4]}],
                    "source": {"image": "../../"}
                }
            }
        });
        let meta = parse_image_label(&json);
        assert!(meta.source_declared);
        assert_eq!(
            meta.colors,
            vec![LabelColor {
                value: 7,
                rgba: [1, 2, 3, 4]
            }]
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
                {"color": "  "},
                {"label": 42},
                "not-an-object",
                42
            ]
        }));
        assert!(
            parse_omero_channels(&root).is_empty(),
            "no usable label or color anywhere must fully fall back to Channel n (empty list)",
        );
    }

    #[test]
    fn omero_channels_keep_a_color_without_a_label() {
        // A color alone is worth keeping, in the middle and at the end, and
        // its channel takes the positional label.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "First"},
                {"color": "00FF00"},
                {},
                {"color": "FF00FF"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 4);
        assert_eq!(infos[0].label, "First");
        assert_eq!(infos[0].color, None);
        assert_eq!(infos[1].label, "Channel 2");
        assert_eq!(infos[1].color.as_deref(), Some("00FF00"));
        assert_eq!(infos[2].label, "Channel 3");
        assert_eq!(infos[2].color, None);
        assert_eq!(infos[3].label, "Channel 4");
        assert_eq!(infos[3].color.as_deref(), Some("FF00FF"));
    }

    #[test]
    fn omero_channels_with_only_colors_are_kept() {
        let root = root_with_omero(serde_json::json!({
            "channels": [{"color": "00FFFF"}, {"color": "FFFFFF"}]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].label, "Channel 1");
        assert_eq!(infos[0].color.as_deref(), Some("00FFFF"));
        assert_eq!(infos[1].label, "Channel 2");
        assert_eq!(infos[1].color.as_deref(), Some("FFFFFF"));
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
        // Index 1 has no usable label but index 2 does: index 1 must be
        // filled with the positional fallback so "Third" still maps to index 2.
        let root = root_with_omero(serde_json::json!({
            "channels": [
                {"label": "First"},
                {"label": "   "},
                {"label": "Third"}
            ]
        }));
        let infos = parse_omero_channels(&root);
        assert_eq!(infos.len(), 3);
        assert_eq!(infos[0].label, "First");
        assert_eq!(infos[1].label, "Channel 2"); // counted from 1, alignment preserved
        assert_eq!(infos[1].color, None);
        assert_eq!(infos[2].label, "Third");
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
    fn image_label_reads_names_from_properties() {
        let long = "n".repeat(MAX_LABEL_NAME_CHARS + 10);
        let json = image_label_group(serde_json::json!({
            "properties": [
                {"label-value": 1, "name": "region one", "class": "ignored"},
                {"label-value": 92801, "class": " far region "},
                {"label-value": 3, "name": "  ", "class": "blank name falls through"},
                {"label-value": 4, "area": 1200},          // no name
                {"label-value": 5, "name": 7},             // not a string
                {"name": "no value"},                      // missing label-value
                {"label-value": 1.5, "name": "fractional"}, // not an integer
                {"label-value": 6, "name": long}
            ]
        }));
        let names = parse_image_label(&json).names;
        assert_eq!(
            names[..3],
            [
                LabelName {
                    value: 1,
                    name: "region one".into()
                },
                LabelName {
                    value: 92801,
                    name: "far region".into()
                },
                LabelName {
                    value: 3,
                    name: "blank name falls through".into()
                },
            ]
        );
        assert_eq!(names.len(), 4);
        assert_eq!(names[3].value, 6);
        assert_eq!(names[3].name.chars().count(), MAX_LABEL_NAME_CHARS);
    }

    #[test]
    fn image_label_without_properties_names_nothing() {
        let json = image_label_group(serde_json::json!({"properties": "none"}));
        assert!(parse_image_label(&json).names.is_empty());
        let json = image_label_group(serde_json::json!({"version": "0.5"}));
        assert!(parse_image_label(&json).names.is_empty());
    }

    #[test]
    fn image_label_caps_oversized_color_tables() {
        let many: Vec<serde_json::Value> = (0..(MAX_LABEL_COLORS + 50))
            .map(|i| serde_json::json!({"label-value": i, "rgba": [1, 2, 3, 4]}))
            .collect();
        let json = image_label_group(serde_json::json!({"colors": many}));
        assert_eq!(parse_image_label(&json).colors.len(), MAX_LABEL_COLORS);
    }
}
