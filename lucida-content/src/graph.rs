use std::collections::HashMap;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::entity::Entity;
use crate::id::{DatasetId, EntityId, ImageId, LayoutId};
use crate::image::{Axis, ChannelInfo, GeneratedLevelInfo, LevelGeometry, PinnedAxis};
use crate::image::{ImageSpec, MultiscaleInfo};
use crate::kind::DatasetKind;
use crate::label::{LabelAttachment, LabelSpec};
use crate::layout::LayoutSpec;
use crate::transform::{TransformEdge, VoxelTransform};

/// The complete description of one opened dataset: its entity hierarchy,
/// placement transforms, multiscale images, source layouts, and labels.
///
/// # Wire encoding
///
/// The JSON form is hand-rolled (see the `Serialize`/`Deserialize` impls
/// below) so that its size scales with a dataset's *structure*, not its tile
/// count. A wide collection has tens of thousands of tiles that all share one
/// multiscale description (the format requires it — the importer templates
/// every tile from a representative one) and sit on deterministic 2D
/// placements; repeating that shared metadata per tile is what used to push
/// collection manifests past WebSocket frame limits.
///
/// - Any [`MultiscaleInfo`] value shared by two or more images is emitted
///   once, in a top-level `multiscales` table; each sharing image carries a
///   `multiscale_ref` index instead of an inline `multiscale`. Images with a
///   unique multiscale (every single-image dataset, and any tile that has
///   diverged, e.g. via generated levels) stay inline.
/// - A transform edge that is exactly a pure 2D translation is emitted as
///   `"translation": [tx, ty]` instead of a 16-element matrix.
/// - Whenever either compact construct is present, the manifest leads with a
///   `format_version` marker ([`COMPACT_MANIFEST_FORMAT_VERSION`]). A
///   manifest that uses neither construct omits the marker and is
///   byte-identical to the fully-inline form this encoding replaced. Note
///   that an identity self-edge *is* a pure 2D translation, so byte-identity
///   with the inline form holds only for manifests with no pure-translation
///   edges at all (e.g. anisotropic placement matrices).
///
/// Decoding accepts both the fully-inline form (inline `multiscale`, matrix
/// `transform`) and the compact form, and resolves every reference back into
/// the in-memory model here — consumers always see fully-populated
/// [`ImageSpec`]s and [`TransformEdge`]s through [`DatasetManifest::images`]
/// and [`DatasetManifest::transforms`], and never deal with table lookups.
/// Persisted inline documents therefore keep loading — and re-persist in the
/// compact form on their next write, because the encoder has no inline mode.
/// The reverse is a one-way door: decoders that predate the compact form
/// hard-reject any manifest that uses it.
///
/// The serialization fixed point is the **canonical encoder output**:
/// `encode(decode(x)) == x` byte-for-byte when `x` came out of this encoder.
/// Valid non-canonical inputs decode fine but re-encode canonically rather
/// than byte-identically: duplicate or unreferenced `multiscales` table
/// entries collapse or disappear, inline duplicates move into the table, and
/// because table entries dedup by IEEE equality, scale elements that differ
/// only in zero sign (`-0.0` vs `0.0`) normalize to the first occurrence's
/// representation.
#[derive(Debug, Clone)]
pub struct DatasetManifest {
    pub dataset_id: DatasetId,
    pub name: String,
    pub kind: DatasetKind,
    entities: Vec<Entity>,
    transforms: Vec<TransformEdge>,
    images: Vec<ImageSpec>,
    source_layouts: Vec<LayoutSpec>,
    pub default_layout_id: Option<LayoutId>,
    /// Segmentation labels attached to images in this dataset. Kept separate
    /// from `images` so labels never render as ordinary intensity images.
    /// Label images always inline their own multiscale on the wire: label
    /// discovery is budget-bounded, so the count stays small, and a label's
    /// multiscale legitimately differs from its source image's.
    labels: Vec<LabelSpec>,
}

impl DatasetManifest {
    // All eight args are required identity tiles; the manifest is built once
    // per dataset, so a builder for a single constructor would only add noise.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        dataset_id: DatasetId,
        name: String,
        kind: DatasetKind,
        entities: Vec<Entity>,
        transforms: Vec<TransformEdge>,
        images: Vec<ImageSpec>,
        source_layouts: Vec<LayoutSpec>,
        default_layout_id: Option<LayoutId>,
    ) -> Self {
        Self {
            dataset_id,
            name,
            kind,
            entities,
            transforms,
            images,
            source_layouts,
            default_layout_id,
            labels: Vec::new(),
        }
    }

    /// Attach segmentation labels discovered during import. A consuming builder
    /// so the freshly constructed manifest can be enriched in one expression
    /// without widening the constructor (which has many call sites).
    pub fn with_labels(mut self, labels: Vec<LabelSpec>) -> Self {
        self.labels = labels;
        self
    }

    pub fn entities(&self) -> &[Entity] {
        &self.entities
    }

    pub fn transforms(&self) -> &[TransformEdge] {
        &self.transforms
    }

    pub fn images(&self) -> &[ImageSpec] {
        &self.images
    }

    pub fn images_mut(&mut self) -> &mut [ImageSpec] {
        &mut self.images
    }

    pub fn source_layouts(&self) -> &[LayoutSpec] {
        &self.source_layouts
    }

    /// The stored label specs, each carrying the label's own multiscale image
    /// and color table. This is the rich view a streaming/render path uses to
    /// reach a label's full per-level geometry.
    pub fn label_specs(&self) -> &[LabelSpec] {
        &self.labels
    }

    /// Every label attached to any image in this dataset (standalone or collection),
    /// projected into the lean [`LabelAttachment`] read-view.
    pub fn labels(&self) -> Vec<LabelAttachment> {
        self.labels.iter().map(LabelAttachment::from_spec).collect()
    }
}

// ---------------------------------------------------------------------------
// Wire encoding (see the type-level docs on `DatasetManifest`)
// ---------------------------------------------------------------------------

/// Value of the `format_version` marker emitted whenever a manifest uses a
/// compact construct (a shared `multiscales` table or a `translation` edge).
/// Absence of the marker means the document is in the original fully-inline
/// form, which every decoder generation reads; presence means an
/// inline-form-only decoder will hard-reject it. Today's consumers ignore the
/// value — it exists so future readers and tooling can recognize a document's
/// format generation without probing for compact fields — and it plays no
/// part in reference resolution.
pub const COMPACT_MANIFEST_FORMAT_VERSION: u32 = 2;

/// Hash a [`MultiscaleInfo`] consistently with its `PartialEq`: equal values
/// must hash equal, so `f64` scale elements are normalized through IEEE
/// equality first (`-0.0 == 0.0` but their bits differ). Used only to bucket
/// dedup candidates — every hash hit is confirmed with a full `==` before two
/// images share a table entry, so a weak hash costs comparisons, never
/// correctness.
fn multiscale_dedup_hash(info: &MultiscaleInfo) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // `-0.0` hashes as `0.0` so IEEE-equal scales land in one bucket. NaN
    // hashes by payload, which is sound: NaN never equals anything, so no
    // equality class is split — NaN-scaled entries simply never dedup.
    fn write_f64(state: &mut impl Hasher, value: f64) {
        let normalized = if value == 0.0 { 0.0f64 } else { value };
        state.write_u64(normalized.to_bits());
    }

    let mut state = DefaultHasher::new();
    info.axes.hash(&mut state);
    info.levels.len().hash(&mut state);
    for level in &info.levels {
        level.level_index.hash(&mut state);
        level.shape.hash(&mut state);
        level.chunk_shape.hash(&mut state);
        level.grid_shape.hash(&mut state);
        for element in level.scale {
            write_f64(&mut state, element);
        }
    }
    info.coarse_level_index.hash(&mut state);
    info.generated_levels.hash(&mut state);
    info.data_type.hash(&mut state);
    info.pinned_axes.hash(&mut state);
    info.channel_infos.hash(&mut state);
    state.finish()
}

/// Multiscale values shared by ≥ 2 images, in first-appearance order, plus a
/// per-image reference (`Some(table index)` for sharing images, `None` for
/// images whose multiscale is unique and stays inline).
struct SharedMultiscales<'a> {
    table: Vec<&'a MultiscaleInfo>,
    refs: Vec<Option<u32>>,
}

impl<'a> SharedMultiscales<'a> {
    fn build(images: &'a [ImageSpec]) -> Self {
        // (first occurrence, share count) per distinct multiscale, in
        // first-appearance order — the order the table is emitted in, so it
        // must depend only on the image sequence, never on hash iteration.
        // The hash buckets keep this O(images): each image costs one hash
        // plus (collisions aside) at most one deep equality check, where a
        // linear scan over distinct values would go quadratic on a manifest
        // whose multiscales have all diverged. This runs on every persist
        // and broadcast of the manifest.
        let mut distinct: Vec<(&'a MultiscaleInfo, usize)> = Vec::new();
        let mut distinct_by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
        let mut membership: Vec<usize> = Vec::with_capacity(images.len());
        for image in images {
            let bucket = distinct_by_hash
                .entry(multiscale_dedup_hash(&image.multiscale))
                .or_default();
            match bucket
                .iter()
                .copied()
                .find(|&index| *distinct[index].0 == image.multiscale)
            {
                Some(index) => {
                    distinct[index].1 += 1;
                    membership.push(index);
                }
                None => {
                    distinct.push((&image.multiscale, 1));
                    bucket.push(distinct.len() - 1);
                    membership.push(distinct.len() - 1);
                }
            }
        }

        let mut table = Vec::new();
        let mut table_index_by_distinct: Vec<Option<u32>> = Vec::with_capacity(distinct.len());
        for (info, count) in &distinct {
            if *count >= 2 {
                table.push(*info);
                table_index_by_distinct.push(Some((table.len() - 1) as u32));
            } else {
                table_index_by_distinct.push(None);
            }
        }
        let refs = membership
            .into_iter()
            .map(|distinct_index| table_index_by_distinct[distinct_index])
            .collect();
        Self { table, refs }
    }
}

/// `transforms` as serialized inside a manifest: pure 2D translations become
/// `"translation": [tx, ty]`, everything else keeps the full matrix form.
struct TransformsWire<'a>(&'a [TransformEdge]);

impl Serialize for TransformsWire<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(TransformEdgeWireRef))
    }
}

struct TransformEdgeWireRef<'a>(&'a TransformEdge);

impl Serialize for TransformEdgeWireRef<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("TransformEdge", 3)?;
        state.serialize_field("from", &self.0.from)?;
        state.serialize_field("to", &self.0.to)?;
        match self.0.transform.as_voxel_translation_2d() {
            Some(translation) => state.serialize_field("translation", &translation)?,
            None => state.serialize_field("transform", &self.0.transform)?,
        }
        state.end()
    }
}

/// `images` as serialized inside a manifest: shared multiscales become
/// `multiscale_ref` indexes into the manifest's `multiscales` table.
struct ImagesWire<'a> {
    images: &'a [ImageSpec],
    refs: &'a [Option<u32>],
}

impl Serialize for ImagesWire<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(
            self.images
                .iter()
                .zip(self.refs)
                .map(|(image, table_ref)| ImageSpecWireRef { image, table_ref }),
        )
    }
}

struct ImageSpecWireRef<'a> {
    image: &'a ImageSpec,
    table_ref: &'a Option<u32>,
}

impl Serialize for ImageSpecWireRef<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("ImageSpec", 3)?;
        state.serialize_field("image_id", &self.image.image_id)?;
        state.serialize_field("owner", &self.image.owner)?;
        match self.table_ref {
            Some(index) => state.serialize_field("multiscale_ref", index)?,
            None => state.serialize_field("multiscale", &self.image.multiscale)?,
        }
        state.end()
    }
}

impl Serialize for DatasetManifest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let shared = SharedMultiscales::build(&self.images);
        let compact = !shared.table.is_empty()
            || self
                .transforms
                .iter()
                .any(|edge| edge.transform.as_voxel_translation_2d().is_some());
        let field_count = 8
            + usize::from(compact)
            + usize::from(!shared.table.is_empty())
            + usize::from(!self.labels.is_empty());
        let mut state = serializer.serialize_struct("DatasetManifest", field_count)?;
        // Leads the object, and only when a compact construct follows, so
        // marker presence is exactly "an inline-form-only decoder cannot
        // read this document" (see COMPACT_MANIFEST_FORMAT_VERSION).
        if compact {
            state.serialize_field("format_version", &COMPACT_MANIFEST_FORMAT_VERSION)?;
        }
        state.serialize_field("dataset_id", &self.dataset_id)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("kind", &self.kind)?;
        state.serialize_field("entities", &self.entities)?;
        state.serialize_field("transforms", &TransformsWire(&self.transforms))?;
        // Omitted entirely when nothing is shared; together with the absent
        // marker this keeps a manifest that also has no pure-translation
        // edges byte-identical to the fully-inline wire form.
        if !shared.table.is_empty() {
            state.serialize_field("multiscales", &shared.table)?;
        }
        state.serialize_field(
            "images",
            &ImagesWire {
                images: &self.images,
                refs: &shared.refs,
            },
        )?;
        state.serialize_field("source_layouts", &self.source_layouts)?;
        state.serialize_field("default_layout_id", &self.default_layout_id)?;
        // Omitted when empty, byte-compatible with pre-labels output.
        if !self.labels.is_empty() {
            state.serialize_field("labels", &self.labels)?;
        }
        state.end()
    }
}

/// Decode-side bounds on shared-table expansion. Resolving a `multiscale_ref`
/// clones the referenced table entry into its image, so a small compact
/// document could otherwise direct the decoder to materialize a huge
/// in-memory model (one bloated table entry referenced by thousands of
/// images). The per-entry caps are far above anything the importer produces
/// (cf. the metadata caps in `lucida-store/src/parse.rs`); the expansion cap
/// keeps the materialized total at or below what the same manifest could
/// have carried fully inline through the largest accepted socket message
/// (256 MiB), so a reference can never amplify past what the inline form
/// already expresses. Inline entries are exempt: they cost their own input
/// bytes exactly once.
const MAX_TABLE_ENTRY_LEVELS: usize = 1024;
const MAX_TABLE_ENTRY_CHANNEL_INFOS: usize = 4096;
const MAX_REF_EXPANSION_BYTES: u64 = 256 * 1024 * 1024;

/// Approximate in-memory footprint of one resolved clone of a shared table
/// entry, counting the string bytes and per-element struct sizes that
/// dominate a bloated entry. Precision does not matter — the cap this feeds
/// sits orders of magnitude above realistic manifests — but every unbounded
/// field contributes, so none of them can carry bloat unweighed.
fn multiscale_expansion_bytes(info: &MultiscaleInfo) -> u64 {
    use std::mem::size_of;
    let string_bytes = info
        .axes
        .iter()
        .map(|axis| axis.name.len())
        .chain(info.pinned_axes.iter().map(|axis| axis.name.len()))
        .chain(
            info.channel_infos
                .iter()
                .map(|channel| channel.label.len() + channel.color.as_deref().map_or(0, str::len)),
        )
        .chain(info.generated_levels.iter().map(|level| {
            level.provenance.generator.len()
                + level.provenance.config_id.len()
                + level
                    .provenance
                    .source_content_id
                    .as_deref()
                    .map_or(0, str::len)
        }))
        .sum::<usize>();
    let element_bytes = size_of::<MultiscaleInfo>()
        + info.axes.len() * size_of::<Axis>()
        + info.levels.len() * size_of::<LevelGeometry>()
        + info.generated_levels.len() * size_of::<GeneratedLevelInfo>()
        + info.pinned_axes.len() * size_of::<PinnedAxis>()
        + info.channel_infos.len() * size_of::<ChannelInfo>();
    (string_bytes + element_bytes) as u64
}

/// The decode-side wire shape: every compact field is optional so both the
/// fully-inline form (inline `multiscale`, matrix `transform`) and the
/// compact form deserialize; `TryFrom` resolves references and rejects
/// entries that carry neither (or both) representations.
#[derive(Deserialize)]
struct DatasetManifestWire {
    /// Compact-format marker ([`COMPACT_MANIFEST_FORMAT_VERSION`]); absent on
    /// fully-inline documents. Deliberately unread: decoding is driven by
    /// which fields each entry carries, not by the marker, so a document
    /// marked with an unrecognized future version still decodes as far as
    /// its fields allow — and fails loudly on constructs this decoder does
    /// not know, entry by entry.
    #[serde(default)]
    #[allow(dead_code)]
    format_version: Option<u32>,
    dataset_id: DatasetId,
    name: String,
    kind: DatasetKind,
    entities: Vec<Entity>,
    transforms: Vec<TransformEdgeWire>,
    #[serde(default)]
    multiscales: Vec<MultiscaleInfo>,
    images: Vec<ImageSpecWire>,
    source_layouts: Vec<LayoutSpec>,
    default_layout_id: Option<LayoutId>,
    #[serde(default)]
    labels: Vec<LabelSpec>,
}

#[derive(Deserialize)]
struct TransformEdgeWire {
    from: EntityId,
    to: EntityId,
    #[serde(default)]
    transform: Option<VoxelTransform>,
    #[serde(default)]
    translation: Option<[f64; 2]>,
}

#[derive(Deserialize)]
struct ImageSpecWire {
    image_id: ImageId,
    owner: EntityId,
    #[serde(default)]
    multiscale: Option<MultiscaleInfo>,
    #[serde(default)]
    multiscale_ref: Option<u32>,
}

impl TryFrom<DatasetManifestWire> for DatasetManifest {
    type Error = String;

    fn try_from(wire: DatasetManifestWire) -> Result<Self, String> {
        let transforms = wire
            .transforms
            .into_iter()
            .map(|edge| {
                let transform = match (edge.transform, edge.translation) {
                    (Some(transform), None) => transform,
                    (None, Some([tx, ty])) => VoxelTransform::from_voxel_translation_2d(tx, ty),
                    (Some(_), Some(_)) => {
                        return Err(format!(
                            "transform edge {} -> {} carries both a transform and a translation",
                            edge.from, edge.to,
                        ));
                    }
                    (None, None) => {
                        return Err(format!(
                            "transform edge {} -> {} carries neither a transform nor a translation",
                            edge.from, edge.to,
                        ));
                    }
                };
                Ok(TransformEdge {
                    from: edge.from,
                    to: edge.to,
                    transform,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        let multiscales = wire.multiscales;
        for (index, info) in multiscales.iter().enumerate() {
            if info.levels.len() > MAX_TABLE_ENTRY_LEVELS {
                return Err(format!(
                    "shared multiscale {index} declares {} levels, which exceeds the decode \
                     limit of {MAX_TABLE_ENTRY_LEVELS}",
                    info.levels.len(),
                ));
            }
            if info.channel_infos.len() > MAX_TABLE_ENTRY_CHANNEL_INFOS {
                return Err(format!(
                    "shared multiscale {index} declares {} channel entries, which exceeds the \
                     decode limit of {MAX_TABLE_ENTRY_CHANNEL_INFOS}",
                    info.channel_infos.len(),
                ));
            }
        }
        let entry_expansion_bytes: Vec<u64> =
            multiscales.iter().map(multiscale_expansion_bytes).collect();
        let mut expanded_bytes: u64 = 0;
        let images = wire
            .images
            .into_iter()
            .map(|image| {
                let multiscale = match (image.multiscale, image.multiscale_ref) {
                    (Some(multiscale), None) => multiscale,
                    (None, Some(index)) => {
                        let entry = multiscales.get(index as usize).ok_or_else(|| {
                            format!(
                                "image {} references shared multiscale {index}, but the \
                                 manifest declares {} shared multiscale(s)",
                                image.image_id,
                                multiscales.len(),
                            )
                        })?;
                        expanded_bytes =
                            expanded_bytes.saturating_add(entry_expansion_bytes[index as usize]);
                        if expanded_bytes > MAX_REF_EXPANSION_BYTES {
                            return Err(format!(
                                "resolving image {}'s multiscale_ref would expand the shared \
                                 multiscale table past the decode limit of \
                                 {MAX_REF_EXPANSION_BYTES} bytes",
                                image.image_id,
                            ));
                        }
                        entry.clone()
                    }
                    (Some(_), Some(_)) => {
                        return Err(format!(
                            "image {} carries both an inline multiscale and a multiscale_ref",
                            image.image_id,
                        ));
                    }
                    (None, None) => {
                        return Err(format!(
                            "image {} carries neither a multiscale nor a multiscale_ref",
                            image.image_id,
                        ));
                    }
                };
                Ok(ImageSpec {
                    image_id: image.image_id,
                    owner: image.owner,
                    multiscale,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        Ok(DatasetManifest {
            dataset_id: wire.dataset_id,
            name: wire.name,
            kind: wire.kind,
            entities: wire.entities,
            transforms,
            images,
            source_layouts: wire.source_layouts,
            default_layout_id: wire.default_layout_id,
            labels: wire.labels,
        })
    }
}

impl<'de> Deserialize<'de> for DatasetManifest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = DatasetManifestWire::deserialize(deserializer)?;
        wire.try_into().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::{EntityKind, EntityLabels};
    use crate::id::{EntityId, ImageId};
    use crate::image::{Axis, AxisKind, DataType, LevelGeometry, MultiscaleInfo};
    use crate::transform::VoxelTransform;

    fn make_single_image_graph() -> DatasetManifest {
        let entity_id = EntityId("img-0".to_string());
        let image_id = ImageId("multiscale-0".to_string());

        DatasetManifest::new(
            DatasetId("ds-test".to_string()),
            "test dataset".to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some("image.tiff".to_string()),
                    ..Default::default()
                },
            }],
            vec![TransformEdge {
                from: entity_id.clone(),
                to: entity_id.clone(),
                transform: VoxelTransform::identity(),
            }],
            vec![ImageSpec {
                image_id,
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 0.5, 0.5],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        )
    }

    #[test]
    fn serde_round_trip() {
        let graph = make_single_image_graph();
        let json = serde_json::to_string_pretty(&graph).unwrap();
        let back: DatasetManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(graph.dataset_id, back.dataset_id);
        assert_eq!(graph.name, back.name);
        assert_eq!(graph.entities().len(), back.entities().len());
        assert_eq!(graph.entities()[0].id, back.entities()[0].id);
        assert_eq!(graph.entities()[0].kind, back.entities()[0].kind);
        assert_eq!(graph.images().len(), back.images().len());
        assert_eq!(graph.images()[0].image_id, back.images()[0].image_id);
        assert_eq!(
            graph.images()[0].multiscale.data_type,
            back.images()[0].multiscale.data_type
        );
        assert_eq!(
            graph.images()[0].multiscale.levels[0].shape,
            back.images()[0].multiscale.levels[0].shape
        );
        assert_eq!(graph.transforms().len(), back.transforms().len());
        assert_eq!(graph.transforms()[0].from, back.transforms()[0].from);
        assert_eq!(graph.default_layout_id, back.default_layout_id);
    }

    fn sample_label_spec() -> crate::label::LabelSpec {
        crate::label::LabelSpec {
            name: "region-b".to_string(),
            source_image_id: ImageId("multiscale-0".to_string()),
            image: ImageSpec {
                image_id: ImageId("multiscale-0:label:region-b".to_string()),
                // Shares the source image's owning entity for placement.
                owner: EntityId("img-0".to_string()),
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 30, 85, 87],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 30, 1, 1],
                        scale: [1.0, 1.0, 1.0, 4.0, 4.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint32,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            },
            colors: vec![crate::label::LabelColor {
                value: 92801,
                rgba: [1, 2, 3, 255],
            }],
            source_declared: true,
        }
    }

    #[test]
    fn serde_round_trip_with_labels() {
        let graph = make_single_image_graph().with_labels(vec![sample_label_spec()]);
        let json = serde_json::to_string_pretty(&graph).unwrap();
        let back: DatasetManifest = serde_json::from_str(&json).unwrap();

        // The stored spec (label's own image + colors) survives intact.
        assert_eq!(back.label_specs().len(), 1);
        let spec = &back.label_specs()[0];
        assert_eq!(spec.name, "region-b");
        assert_eq!(spec.source_image_id, ImageId("multiscale-0".to_string()));
        assert_eq!(spec.image.multiscale.data_type, DataType::Uint32);
        assert_eq!(
            spec.image.multiscale.levels[0].scale,
            [1.0, 1.0, 1.0, 4.0, 4.0]
        );
        assert_eq!(spec.colors.len(), 1);
        // A label value beyond u16 survives the JSON round trip untouched.
        assert_eq!(spec.colors[0].value, 92801);
        assert!(spec.source_declared);

        // The projected read-view is intact, including the source entity used
        // for placement.
        let labels = back.labels();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].source_entity_id, EntityId("img-0".to_string()));
        assert_eq!(labels[0].data_type, DataType::Uint32);
        assert_eq!(labels[0].level0_scale, [1.0, 1.0, 1.0, 4.0, 4.0]);
    }

    #[test]
    fn label_less_manifest_omits_labels_and_defaults() {
        let graph = make_single_image_graph();
        let value = serde_json::to_value(&graph).unwrap();
        // skip_serializing_if keeps the wire byte-identical to pre-labels output.
        assert!(
            value.get("labels").is_none(),
            "label-less manifest must not emit a `labels` key, got: {value}",
        );

        // A manifest JSON written before labels existed (no `labels` key) still
        // deserializes, defaulting to no labels.
        let back: DatasetManifest = serde_json::from_value(value).unwrap();
        assert!(back.label_specs().is_empty());
        assert!(back.labels().is_empty());
    }

    fn collection_multiscale() -> MultiscaleInfo {
        MultiscaleInfo {
            axes: vec![
                Axis {
                    name: "c".to_string(),
                    kind: AxisKind::Channel,
                },
                Axis {
                    name: "y".to_string(),
                    kind: AxisKind::Space,
                },
                Axis {
                    name: "x".to_string(),
                    kind: AxisKind::Space,
                },
            ],
            levels: vec![
                LevelGeometry {
                    level_index: 0,
                    shape: [1, 4, 1, 2048, 2048],
                    chunk_shape: [1, 1, 1, 512, 512],
                    grid_shape: [1, 4, 1, 4, 4],
                    scale: [1.0, 1.0, 1.0, 0.65, 0.65],
                },
                LevelGeometry {
                    level_index: 1,
                    shape: [1, 4, 1, 1024, 1024],
                    chunk_shape: [1, 1, 1, 512, 512],
                    grid_shape: [1, 4, 1, 2, 2],
                    scale: [1.0, 1.0, 1.0, 1.3, 1.3],
                },
            ],
            coarse_level_index: Some(1),
            generated_levels: vec![],
            data_type: DataType::Uint16,
            pinned_axes: vec![],
            channel_infos: vec![
                crate::image::ChannelInfo {
                    label: "Channel 0".to_string(),
                    color: Some("00FF00".to_string()),
                },
                crate::image::ChannelInfo {
                    label: "Channel 1".to_string(),
                    color: None,
                },
            ],
        }
    }

    /// A synthetic wide collection shaped like the importer's output:
    /// one entity per group and tile, one grid-translation edge per tile,
    /// and one image per tile that clones the representative multiscale.
    fn make_collection_graph(group_count: usize, tiles_per_group: usize) -> DatasetManifest {
        let dataset = "wds-9c41";
        let multiscale = collection_multiscale();
        let mut entities = Vec::new();
        let mut transforms = Vec::new();
        let mut images = Vec::new();
        for group in 0..group_count {
            let group_path = format!("A/{group}");
            let group_id = EntityId(format!("{dataset}:group:{group_path}"));
            entities.push(Entity {
                id: group_id.clone(),
                kind: EntityKind::Group,
                parent: None,
                labels: EntityLabels {
                    name: Some(format!("A/{group}")),
                    group_row: Some("A".to_string()),
                    group_column: Some(format!("{group}")),
                    row_index: Some(0),
                    column_index: Some(group as u32),
                    ..Default::default()
                },
            });
            for tile in 0..tiles_per_group {
                let prefix = format!("{group_path}/{tile}");
                let tile_id = EntityId(format!("{dataset}:tile:{prefix}"));
                entities.push(Entity {
                    id: tile_id.clone(),
                    kind: EntityKind::Tile,
                    parent: Some(group_id.clone()),
                    labels: EntityLabels {
                        name: Some(format!("Tile {tile}")),
                        tile_index: Some(tile as u32),
                        ..Default::default()
                    },
                });
                transforms.push(TransformEdge {
                    from: tile_id.clone(),
                    to: group_id.clone(),
                    transform: VoxelTransform::from_voxel_translation_2d(
                        (tile as f64) * 2048.0,
                        0.0,
                    ),
                });
                images.push(ImageSpec {
                    image_id: ImageId(format!("{dataset}:image:{prefix}")),
                    owner: tile_id,
                    multiscale: multiscale.clone(),
                });
            }
        }
        DatasetManifest::new(
            DatasetId(dataset.to_string()),
            "wide-collection.zarr".to_string(),
            DatasetKind::Collection {
                rows: vec!["A".to_string()],
                columns: (0..group_count).map(|c| format!("{c}")).collect(),
                positioning_mode: crate::PositioningMode::Derived,
                has_explicit_positions: false,
            },
            entities,
            transforms,
            images,
            vec![],
            None,
        )
    }

    #[test]
    fn collection_wire_encodes_shared_metadata_once() {
        let graph = make_collection_graph(4, 25);
        let value = serde_json::to_value(&graph).unwrap();

        let table = value
            .get("multiscales")
            .and_then(|v| v.as_array())
            .expect("shared multiscale table present");
        assert_eq!(table.len(), 1, "one shared multiscale for all tiles");

        let images = value["images"].as_array().unwrap();
        assert_eq!(images.len(), 100);
        for image in images {
            assert!(
                image.get("multiscale").is_none(),
                "sharing image must not inline its multiscale: {image}",
            );
            assert_eq!(image["multiscale_ref"], serde_json::json!(0));
        }

        let transforms = value["transforms"].as_array().unwrap();
        assert_eq!(transforms.len(), 100);
        for edge in transforms {
            assert!(
                edge.get("transform").is_none(),
                "grid placement must use the compact translation form: {edge}",
            );
            assert_eq!(edge["translation"].as_array().unwrap().len(), 2);
        }
    }

    #[test]
    fn collection_wire_bytes_scale_with_structure_not_tiles() {
        // Marginal cost per additional tile must stay in the shared-once
        // regime: identity + placement only, no repeated multiscale or
        // matrix. (Inline, one tile costs ~900 bytes of multiscale alone.)
        let small = serde_json::to_string(&make_collection_graph(4, 5)).unwrap();
        let large = serde_json::to_string(&make_collection_graph(4, 105)).unwrap();
        let added_tiles = 4 * 100;
        let per_tile = (large.len() - small.len()) / added_tiles;
        assert!(
            per_tile <= 300,
            "marginal manifest bytes per tile too high: {per_tile} > 300",
        );
    }

    #[test]
    fn collection_wire_round_trip_is_lossless_and_stable() {
        let graph = make_collection_graph(3, 7);
        let encoded = serde_json::to_string(&graph).unwrap();
        let decoded: DatasetManifest = serde_json::from_str(&encoded).unwrap();

        // Structurally identical after one round trip.
        assert_eq!(decoded.dataset_id, graph.dataset_id);
        assert_eq!(decoded.entities().len(), graph.entities().len());
        assert_eq!(decoded.images(), graph.images());
        assert_eq!(decoded.transforms(), graph.transforms());
        assert_eq!(
            serde_json::to_value(&decoded).unwrap(),
            serde_json::to_value(&graph).unwrap(),
        );

        // And the encoding is a fixed point: encode(decode(x)) == x.
        let re_encoded = serde_json::to_string(&decoded).unwrap();
        assert_eq!(re_encoded, encoded);
    }

    #[test]
    fn legacy_manifest_with_inline_metadata_still_deserializes() {
        // The exact shape servers wrote before the shared-once encoding:
        // per-image inline multiscale and full matrix transforms. Persisted
        // workspace documents replay this form on every rejoin.
        let legacy = serde_json::json!({
            "dataset_id": "wds-legacy",
            "name": "persisted.zarr",
            "kind": "Single",
            "entities": [
                {"id": "img-0", "kind": "Image", "parent": null, "labels": {"name": "persisted.zarr"}}
            ],
            "transforms": [
                {
                    "from": "img-0",
                    "to": "img-0",
                    "transform": {"matrix": [
                        1.0, 0.0, 0.0, 0.0,
                        0.0, 1.0, 0.0, 0.0,
                        0.0, 0.0, 1.0, 0.0,
                        128.0, -64.0, 0.0, 1.0
                    ]}
                }
            ],
            "images": [
                {
                    "image_id": "multiscale-0",
                    "owner": "img-0",
                    "multiscale": {
                        "axes": [
                            {"name": "y", "kind": "Space"},
                            {"name": "x", "kind": "Space"}
                        ],
                        "levels": [{
                            "level_index": 0,
                            "shape": [1, 1, 1, 256, 256],
                            "chunk_shape": [1, 1, 1, 128, 128],
                            "grid_shape": [1, 1, 1, 2, 2],
                            "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                        }],
                        "data_type": "Uint16"
                    }
                }
            ],
            "source_layouts": [],
            "default_layout_id": null
        });
        let back: DatasetManifest = serde_json::from_value(legacy).unwrap();
        assert_eq!(back.images().len(), 1);
        assert_eq!(back.images()[0].multiscale.levels[0].shape[3], 256);
        assert_eq!(
            back.transforms()[0].transform.as_voxel_translation_2d(),
            Some([128.0, -64.0]),
        );
    }

    #[test]
    fn unique_multiscales_stay_inline_and_omit_the_table() {
        let graph = make_single_image_graph();
        let value = serde_json::to_value(&graph).unwrap();
        assert!(
            value.get("multiscales").is_none(),
            "no shared table for a single-image manifest, got: {value}",
        );
        let image = &value["images"][0];
        assert!(image.get("multiscale").is_some());
        assert!(image.get("multiscale_ref").is_none());
    }

    #[test]
    fn manifest_wire_rejects_bad_image_entries() {
        let mut value = serde_json::to_value(make_collection_graph(1, 3)).unwrap();

        // Reference past the shared table.
        value["images"][0]["multiscale_ref"] = serde_json::json!(7);
        let err = serde_json::from_value::<DatasetManifest>(value.clone()).unwrap_err();
        assert!(err.to_string().contains("references shared multiscale 7"));

        // Neither inline nor reference.
        value["images"][0]
            .as_object_mut()
            .unwrap()
            .remove("multiscale_ref");
        let err = serde_json::from_value::<DatasetManifest>(value).unwrap_err();
        assert!(
            err.to_string()
                .contains("neither a multiscale nor a multiscale_ref")
        );
    }

    #[test]
    fn manifest_wire_rejects_bad_transform_entries() {
        let mut value = serde_json::to_value(make_collection_graph(1, 2)).unwrap();

        // Both forms at once is ambiguous.
        value["transforms"][0]["transform"] =
            serde_json::to_value(VoxelTransform::identity()).unwrap();
        let err = serde_json::from_value::<DatasetManifest>(value.clone()).unwrap_err();
        assert!(
            err.to_string()
                .contains("both a transform and a translation")
        );

        // Neither form fails.
        {
            let edge = value["transforms"][0].as_object_mut().unwrap();
            edge.remove("transform");
            edge.remove("translation");
        }
        let err = serde_json::from_value::<DatasetManifest>(value).unwrap_err();
        assert!(
            err.to_string()
                .contains("neither a transform nor a translation")
        );
    }

    #[test]
    fn non_translation_transforms_keep_the_matrix_form() {
        let mut graph = make_single_image_graph();
        // A z-scaling placement is not a pure 2D translation.
        let mut matrix = *VoxelTransform::identity().matrix();
        matrix[10] = 2.0;
        graph.transforms[0].transform = VoxelTransform::from_voxel_matrix(matrix);

        let value = serde_json::to_value(&graph).unwrap();
        let edge = &value["transforms"][0];
        assert!(edge.get("translation").is_none());
        assert_eq!(edge["transform"]["matrix"][10], serde_json::json!(2.0));

        let back: DatasetManifest = serde_json::from_value(value).unwrap();
        assert_eq!(back.transforms()[0].transform.matrix()[10], 2.0);
    }

    /// A single-image manifest whose only edge is NOT a pure 2D translation,
    /// so the encoder uses no compact construct at all.
    fn make_matrix_only_graph() -> DatasetManifest {
        let mut graph = make_single_image_graph();
        let mut matrix = *VoxelTransform::identity().matrix();
        matrix[10] = 2.0;
        graph.transforms[0].transform = VoxelTransform::from_voxel_matrix(matrix);
        graph
    }

    #[test]
    fn format_version_marker_tracks_compact_constructs() {
        // Shared table → marker.
        let collection = serde_json::to_value(make_collection_graph(2, 3)).unwrap();
        assert_eq!(
            collection["format_version"],
            serde_json::json!(COMPACT_MANIFEST_FORMAT_VERSION),
        );

        // A pure-translation edge alone triggers the marker too — an
        // identity self-edge is a pure 2D translation — even with every
        // multiscale inline.
        let single = serde_json::to_value(make_single_image_graph()).unwrap();
        assert!(single.get("multiscales").is_none());
        assert_eq!(
            single["format_version"],
            serde_json::json!(COMPACT_MANIFEST_FORMAT_VERSION),
        );

        // No compact construct → no marker: the document stays
        // byte-compatible with the fully-inline form.
        let value = serde_json::to_value(make_matrix_only_graph()).unwrap();
        assert!(
            value.get("format_version").is_none(),
            "inline-form manifest must not carry a marker, got: {value}",
        );
    }

    #[test]
    fn format_version_marker_is_tolerated_and_ignored_on_decode() {
        // The marker plays no role in resolution: a document carrying an
        // unrecognized future version still decodes from its fields.
        let mut value = serde_json::to_value(make_matrix_only_graph()).unwrap();
        value["format_version"] = serde_json::json!(9);
        let back: DatasetManifest = serde_json::from_value(value).unwrap();
        assert_eq!(back.images().len(), 1);
    }

    #[test]
    fn dedup_keeps_first_appearance_order_with_mixed_sharing() {
        // Interleave two shared values and a unique one: the table lists the
        // shared values in first-appearance order, refs point through it,
        // and the unique value stays inline in place.
        let mut graph = make_collection_graph(1, 5);
        let base = graph.images()[0].multiscale.clone();
        let mut second = base.clone();
        second.levels[0].scale[3] = 0.7;
        let mut unique = base.clone();
        unique.levels[0].scale[3] = 0.9;
        graph.images_mut()[1].multiscale = second.clone();
        graph.images_mut()[3].multiscale = unique;
        graph.images_mut()[4].multiscale = second;

        let value = serde_json::to_value(&graph).unwrap();
        let table = value["multiscales"].as_array().unwrap();
        assert_eq!(table.len(), 2);
        assert_eq!(table[0]["levels"][0]["scale"][3], serde_json::json!(0.65));
        assert_eq!(table[1]["levels"][0]["scale"][3], serde_json::json!(0.7));
        let images = value["images"].as_array().unwrap();
        assert_eq!(images[0]["multiscale_ref"], serde_json::json!(0));
        assert_eq!(images[1]["multiscale_ref"], serde_json::json!(1));
        assert_eq!(images[2]["multiscale_ref"], serde_json::json!(0));
        assert!(images[3].get("multiscale_ref").is_none());
        assert!(images[3].get("multiscale").is_some());
        assert_eq!(images[4]["multiscale_ref"], serde_json::json!(1));
    }

    #[test]
    fn shared_table_dedups_ieee_equal_scale_representations() {
        // Two multiscales identical up to the sign of a zero scale element:
        // IEEE-equal, so they dedup into ONE table entry and the second
        // image re-encodes with the first occurrence's bits. Locks the
        // dedup-hash normalization — if -0.0 hashed differently from 0.0,
        // equal values would silently stop sharing.
        let mut graph = make_collection_graph(1, 2);
        graph.images_mut()[0].multiscale.levels[0].scale[0] = 0.0;
        graph.images_mut()[1].multiscale.levels[0].scale[0] = -0.0;
        assert_eq!(graph.images()[0].multiscale, graph.images()[1].multiscale);

        let value = serde_json::to_value(&graph).unwrap();
        assert_eq!(value["multiscales"].as_array().unwrap().len(), 1);
        assert_eq!(value["images"][0]["multiscale_ref"], serde_json::json!(0));
        assert_eq!(value["images"][1]["multiscale_ref"], serde_json::json!(0));

        let decoded: DatasetManifest = serde_json::from_value(value).unwrap();
        assert_eq!(
            decoded.images()[1].multiscale.levels[0].scale[0].to_bits(),
            0.0f64.to_bits(),
        );
    }

    #[test]
    fn manifest_wire_rejects_bloated_table_entries() {
        let mut value = serde_json::to_value(make_collection_graph(1, 3)).unwrap();
        let channels: Vec<serde_json::Value> = (0..=MAX_TABLE_ENTRY_CHANNEL_INFOS)
            .map(|i| serde_json::json!({"label": format!("Ch {i}")}))
            .collect();
        value["multiscales"][0]["channel_infos"] = serde_json::Value::Array(channels);
        let err = serde_json::from_value::<DatasetManifest>(value).unwrap_err();
        assert!(err.to_string().contains("channel entries"));

        let mut value = serde_json::to_value(make_collection_graph(1, 3)).unwrap();
        let level = value["multiscales"][0]["levels"][0].clone();
        let levels: Vec<serde_json::Value> = (0..=MAX_TABLE_ENTRY_LEVELS)
            .map(|_| level.clone())
            .collect();
        value["multiscales"][0]["levels"] = serde_json::Value::Array(levels);
        let err = serde_json::from_value::<DatasetManifest>(value).unwrap_err();
        assert!(err.to_string().contains("levels"));
    }

    #[test]
    fn manifest_wire_rejects_absurd_ref_expansion() {
        // A few hundred KiB of compact input must not direct the decoder to
        // materialize hundreds of MiB: one large-but-per-entry-legal table
        // entry (1024 levels, ~170 KiB per clone) referenced by 1,700 images
        // crosses the total expansion cap.
        let level = serde_json::json!({
            "level_index": 0,
            "shape": [1, 1, 1, 256, 256],
            "chunk_shape": [1, 1, 1, 128, 128],
            "grid_shape": [1, 1, 1, 2, 2],
            "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
        });
        let entry = serde_json::json!({
            "axes": [
                {"name": "y", "kind": "Space"},
                {"name": "x", "kind": "Space"}
            ],
            "levels": (0..MAX_TABLE_ENTRY_LEVELS).map(|_| level.clone()).collect::<Vec<_>>(),
            "data_type": "Uint16"
        });
        let images: Vec<serde_json::Value> = (0..1700)
            .map(|i| {
                serde_json::json!({
                    "image_id": format!("img-{i}"),
                    "owner": "tile-0",
                    "multiscale_ref": 0
                })
            })
            .collect();
        let manifest = serde_json::json!({
            "format_version": 2,
            "dataset_id": "wds-bloat",
            "name": "bloat.zarr",
            "kind": "Single",
            "entities": [],
            "transforms": [],
            "multiscales": [entry],
            "images": images,
            "source_layouts": [],
            "default_layout_id": null
        });
        let err = serde_json::from_value::<DatasetManifest>(manifest).unwrap_err();
        assert!(
            err.to_string().contains("past the decode limit"),
            "expected the expansion cap to reject, got: {err}",
        );
    }

    #[test]
    fn realistic_wide_manifest_decodes_within_bounds() {
        // The widest realistic shape — hundreds of groups, tens of thousands
        // of tiles, one shared multiscale — must sail through the decode
        // expansion caps and round-trip intact.
        let graph = make_collection_graph(216, 99);
        let encoded = serde_json::to_string(&graph).unwrap();
        let decoded: DatasetManifest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.images().len(), 216 * 99);
        assert_eq!(decoded.images(), graph.images());
    }
}
