use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::entity::Entity;
use crate::id::{DatasetId, EntityId, ImageId, LayoutId};
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
///   diverged, e.g. via generated levels) stay inline, so those payloads are
///   byte-identical to the historical output.
/// - A transform edge that is exactly a pure 2D translation is emitted as
///   `"translation": [tx, ty]` instead of a 16-element matrix.
///
/// Decoding accepts both the historical form (inline `multiscale`, matrix
/// `transform`) and the compact form, and resolves every reference back into
/// the in-memory model here — consumers always see fully-populated
/// [`ImageSpec`]s and [`TransformEdge`]s through [`DatasetManifest::images`]
/// and [`DatasetManifest::transforms`], and never deal with table lookups.
/// Persisted documents written before this encoding therefore keep loading,
/// and re-encoding a decoded manifest is stable (the compact form re-encodes
/// to itself byte-for-byte).
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
        // first-appearance order. The distinct count is tiny in practice (one
        // per collection, plus any diverged tiles), so a linear scan per image
        // beats hashing the full nested structure.
        let mut distinct: Vec<(&'a MultiscaleInfo, usize)> = Vec::new();
        let mut membership: Vec<usize> = Vec::with_capacity(images.len());
        for image in images {
            match distinct
                .iter()
                .position(|(info, _)| *info == &image.multiscale)
            {
                Some(index) => {
                    distinct[index].1 += 1;
                    membership.push(index);
                }
                None => {
                    distinct.push((&image.multiscale, 1));
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
        let field_count =
            8 + usize::from(!shared.table.is_empty()) + usize::from(!self.labels.is_empty());
        let mut state = serializer.serialize_struct("DatasetManifest", field_count)?;
        state.serialize_field("dataset_id", &self.dataset_id)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("kind", &self.kind)?;
        state.serialize_field("entities", &self.entities)?;
        state.serialize_field("transforms", &TransformsWire(&self.transforms))?;
        // Omitted entirely when nothing is shared, which keeps single-image
        // manifests byte-identical to the historical wire form.
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

/// The decode-side wire shape: every compact field is optional so both the
/// historical form (inline `multiscale`, matrix `transform`) and the compact
/// form deserialize; `TryFrom` resolves references and rejects entries that
/// carry neither (or both) representations.
#[derive(Deserialize)]
struct DatasetManifestWire {
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
        let images = wire
            .images
            .into_iter()
            .map(|image| {
                let multiscale = match (image.multiscale, image.multiscale_ref) {
                    (Some(multiscale), None) => multiscale,
                    (None, Some(index)) => {
                        multiscales.get(index as usize).cloned().ok_or_else(|| {
                            format!(
                                "image {} references shared multiscale {index}, but the \
                                 manifest declares {} shared multiscale(s)",
                                image.image_id,
                                multiscales.len(),
                            )
                        })?
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
}
