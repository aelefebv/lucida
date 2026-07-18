use crate::ClientId;
use crate::fetch::{FetchSource, WireFormat};
use lucida_content::{DataType, DatasetManifest, ImageId, ImageSpec};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;

/// Application-level event: a dataset has been opened on the server and
/// should be registered by all clients. Carries the canonical dataset
/// manifest and the client-visible fetch source. Does NOT carry server-private
/// binding state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetOpened {
    pub manifest: DatasetManifest,
    pub fetch: FetchSource,
    /// Id of the client that opened this dataset, stamped by the server on
    /// the open path so the broadcast's recipients can tell whether THEY are
    /// the opener. `dataset_opened` is a fan-out broadcast, so the web uses
    /// `opener_client_id == self` to auto-fit the camera only for the opener
    /// and leave co-present peers / followers undisturbed. `None` when there
    /// is no originating client (e.g. server-side workspace restore, or an
    /// older payload that omits the field — `#[serde(default)]` back-compat).
    #[serde(default)]
    pub opener_client_id: Option<ClientId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetOpenedValidationCategory {
    Manifest,
    Duplicate,
    Missing,
    Unexpected,
    Inconsistent,
    Unsupported,
    UnsafePath,
    ResourceLimit,
}

/// Semantic use of a chunk's scalar values at the renderer boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkRole {
    Intensity,
    Label,
}

/// Canonical WebGPU scalar type produced after decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererChunkDataType {
    Uint16,
    Uint32,
}

/// Exact role-aware conversion the web decoder performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkNormalization {
    Uint8ToUint16,
    IdentityUint16,
    Float32UnitToUint16,
    Uint8ToUint32,
    Uint16ToUint32,
    IdentityUint32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RendererChunkFormat {
    pub data_type: RendererChunkDataType,
    pub source_bytes_per_voxel: u8,
    pub gpu_bytes_per_voxel: u8,
    pub normalization: ChunkNormalization,
}

/// Authoritative server-side dtype/role support matrix for the web renderer.
pub fn renderer_chunk_format(role: ChunkRole, source: DataType) -> Option<RendererChunkFormat> {
    use ChunkNormalization::*;
    use RendererChunkDataType::*;
    match (role, source) {
        (ChunkRole::Intensity, DataType::Uint8) => Some(RendererChunkFormat {
            data_type: Uint16,
            source_bytes_per_voxel: 1,
            gpu_bytes_per_voxel: 2,
            normalization: Uint8ToUint16,
        }),
        (ChunkRole::Intensity, DataType::Uint16) => Some(RendererChunkFormat {
            data_type: Uint16,
            source_bytes_per_voxel: 2,
            gpu_bytes_per_voxel: 2,
            normalization: IdentityUint16,
        }),
        (ChunkRole::Intensity, DataType::Float32) => Some(RendererChunkFormat {
            data_type: Uint16,
            source_bytes_per_voxel: 4,
            gpu_bytes_per_voxel: 2,
            normalization: Float32UnitToUint16,
        }),
        (ChunkRole::Label, DataType::Uint8) => Some(RendererChunkFormat {
            data_type: Uint32,
            source_bytes_per_voxel: 1,
            gpu_bytes_per_voxel: 4,
            normalization: Uint8ToUint32,
        }),
        (ChunkRole::Label, DataType::Uint16) => Some(RendererChunkFormat {
            data_type: Uint32,
            source_bytes_per_voxel: 2,
            gpu_bytes_per_voxel: 4,
            normalization: Uint16ToUint32,
        }),
        (ChunkRole::Label, DataType::Uint32) => Some(RendererChunkFormat {
            data_type: Uint32,
            source_bytes_per_voxel: 4,
            gpu_bytes_per_voxel: 4,
            normalization: IdentityUint32,
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy)]
struct ExpectedImage {
    data_type: DataType,
    role: ChunkRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenedValidationError {
    pub category: DatasetOpenedValidationCategory,
    pub path: String,
    pub message: String,
}

impl DatasetOpenedValidationError {
    fn new(
        category: DatasetOpenedValidationCategory,
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

impl fmt::Display for DatasetOpenedValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} ({:?})", self.path, self.message, self.category)
    }
}

impl std::error::Error for DatasetOpenedValidationError {}

impl DatasetOpened {
    /// Validate the manifest and its fetch contract as one admission unit.
    pub fn validate(&self) -> Result<(), DatasetOpenedValidationError> {
        if let Err(errors) = self.manifest.validate() {
            let first = errors
                .errors()
                .first()
                .expect("validation error is nonempty");
            return Err(DatasetOpenedValidationError::new(
                DatasetOpenedValidationCategory::Manifest,
                format!("manifest.{}", first.path),
                first.message.clone(),
            ));
        }

        let mut expected = HashMap::<&str, ExpectedImage>::new();
        for (index, image) in self.manifest.images().iter().enumerate() {
            validate_renderer_image(
                &format!("manifest.images[{index}]"),
                image,
                ChunkRole::Intensity,
            )?;
            expected.insert(
                image.image_id.0.as_str(),
                ExpectedImage {
                    data_type: image.multiscale.data_type,
                    role: ChunkRole::Intensity,
                },
            );
        }
        for (index, label) in self.manifest.label_specs().iter().enumerate() {
            validate_renderer_image(
                &format!("manifest.labels[{index}].image"),
                &label.image,
                ChunkRole::Label,
            )?;
            expected.insert(
                label.image.image_id.0.as_str(),
                ExpectedImage {
                    data_type: label.image.multiscale.data_type,
                    role: ChunkRole::Label,
                },
            );
        }
        if expected.len() > lucida_content::validation::MAX_MANIFEST_IMAGES {
            return Err(DatasetOpenedValidationError::new(
                DatasetOpenedValidationCategory::ResourceLimit,
                "fetch.images",
                "fetch image count exceeds admission limit",
            ));
        }

        let mut seen = HashSet::with_capacity(expected.len());
        let FetchSource::Proxied(descriptor) = &self.fetch;
        for (index, image) in descriptor.images.iter().enumerate() {
            validate_fetch_image(
                index,
                &image.image_id,
                &image.wire_format,
                &expected,
                &mut seen,
            )?;
        }

        if let Some(missing) = expected.keys().find(|id| !seen.contains(**id)) {
            return Err(DatasetOpenedValidationError::new(
                DatasetOpenedValidationCategory::Missing,
                "fetch.images",
                format!("manifest image '{missing}' has no fetch descriptor"),
            ));
        }
        Ok(())
    }
}

fn validate_fetch_image(
    index: usize,
    image_id: &ImageId,
    wire_format: &WireFormat,
    expected: &HashMap<&str, ExpectedImage>,
    seen: &mut HashSet<String>,
) -> Result<(), DatasetOpenedValidationError> {
    let path = format!("fetch.images[{index}]");
    if !seen.insert(image_id.0.clone()) {
        return Err(DatasetOpenedValidationError::new(
            DatasetOpenedValidationCategory::Duplicate,
            format!("{path}.image_id"),
            format!("duplicate fetch image '{}'", image_id.0),
        ));
    }
    let data_type = expected.get(image_id.0.as_str()).ok_or_else(|| {
        DatasetOpenedValidationError::new(
            DatasetOpenedValidationCategory::Unexpected,
            format!("{path}.image_id"),
            format!("unknown manifest image '{}'", image_id.0),
        )
    })?;
    if wire_data_type(wire_format) != data_type.data_type {
        return Err(DatasetOpenedValidationError::new(
            DatasetOpenedValidationCategory::Inconsistent,
            format!("{path}.wire_format.data_type"),
            "wire dtype differs from manifest dtype",
        ));
    }
    if renderer_chunk_format(data_type.role, wire_data_type(wire_format)).is_none() {
        return Err(DatasetOpenedValidationError::new(
            DatasetOpenedValidationCategory::Unsupported,
            format!("{path}.wire_format.data_type"),
            "wire dtype is not supported for this image role",
        ));
    }
    Ok(())
}

fn validate_renderer_image(
    path: &str,
    image: &ImageSpec,
    role: ChunkRole,
) -> Result<(), DatasetOpenedValidationError> {
    if renderer_chunk_format(role, image.multiscale.data_type).is_none() {
        return Err(DatasetOpenedValidationError::new(
            DatasetOpenedValidationCategory::Unsupported,
            format!("{path}.multiscale.data_type"),
            format!(
                "{:?} is not supported for {:?} chunks by the web renderer",
                image.multiscale.data_type, role
            ),
        ));
    }
    for (index, level) in image.multiscale.levels.iter().enumerate() {
        if level.chunk_shape[0] != 1 || level.chunk_shape[1] != 1 {
            return Err(DatasetOpenedValidationError::new(
                DatasetOpenedValidationCategory::Unsupported,
                format!("{path}.multiscale.levels[{index}].chunk_shape"),
                "renderer requires independently addressable T/C chunks (chunk extents must be 1)",
            ));
        }
        if role == ChunkRole::Label && level.shape[1] != 1 {
            return Err(DatasetOpenedValidationError::new(
                DatasetOpenedValidationCategory::Unsupported,
                format!("{path}.multiscale.levels[{index}].shape[1]"),
                "label images must have exactly one channel",
            ));
        }
    }
    Ok(())
}

fn wire_data_type(format: &WireFormat) -> DataType {
    match format {
        WireFormat::Raw { data_type }
        | WireFormat::Lz4 { data_type }
        | WireFormat::Zstd { data_type } => *data_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::{ProxiedFetchDescriptor, ProxiedImageSpec, WireFormat};
    use lucida_content::*;

    fn make_dataset_opened() -> DatasetOpened {
        let entity_id = EntityId("img-0".to_string());
        let image_id = ImageId("multiscale-0".to_string());

        let manifest = DatasetManifest::new(
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
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
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
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });

        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }

    #[test]
    fn dataset_opened_round_trip() {
        let event = make_dataset_opened();
        event.validate().unwrap();
        let json = serde_json::to_string_pretty(&event).unwrap();
        let back: DatasetOpened = serde_json::from_str(&json).unwrap();

        assert_eq!(event.manifest.dataset_id, back.manifest.dataset_id);
        assert_eq!(event.manifest.name, back.manifest.name);
        assert_eq!(
            event.manifest.entities().len(),
            back.manifest.entities().len()
        );
        assert_eq!(event.manifest.images().len(), back.manifest.images().len());
        assert_eq!(
            event.manifest.images()[0].image_id,
            back.manifest.images()[0].image_id
        );

        let FetchSource::Proxied(p) = &back.fetch;
        assert_eq!(p.images.len(), 1);
        assert_eq!(p.images[0].image_id, ImageId("multiscale-0".to_string()));
    }

    #[test]
    fn dataset_opened_validation_rejects_duplicate_fetch_and_dtype_drift() {
        let mut duplicate = make_dataset_opened();
        let FetchSource::Proxied(descriptor) = &mut duplicate.fetch;
        descriptor.images.push(descriptor.images[0].clone());
        assert_eq!(
            duplicate.validate().unwrap_err().category,
            DatasetOpenedValidationCategory::Duplicate
        );

        let mut drift = make_dataset_opened();
        let FetchSource::Proxied(descriptor) = &mut drift.fetch;
        descriptor.images[0].wire_format = WireFormat::Raw {
            data_type: DataType::Uint8,
        };
        assert_eq!(
            drift.validate().unwrap_err().category,
            DatasetOpenedValidationCategory::Inconsistent
        );
    }

    #[test]
    fn renderer_dtype_matrix_is_admitted_or_rejected_before_open() {
        for data_type in [DataType::Uint8, DataType::Uint16, DataType::Float32] {
            let mut opened = make_dataset_opened();
            opened.manifest.images_mut()[0].multiscale.data_type = data_type;
            let FetchSource::Proxied(fetch) = &mut opened.fetch;
            fetch.images[0].wire_format = WireFormat::Raw { data_type };
            opened.validate().unwrap();
        }

        for data_type in [DataType::Uint32, DataType::Float64] {
            let mut opened = make_dataset_opened();
            opened.manifest.images_mut()[0].multiscale.data_type = data_type;
            let FetchSource::Proxied(fetch) = &mut opened.fetch;
            fetch.images[0].wire_format = WireFormat::Raw { data_type };
            let error = opened.validate().unwrap_err();
            assert_eq!(error.category, DatasetOpenedValidationCategory::Unsupported);
            assert_eq!(error.path, "manifest.images[0].multiscale.data_type");
        }
    }

    #[test]
    fn unsigned_label_dtypes_share_one_uint32_renderer_contract() {
        for data_type in [DataType::Uint8, DataType::Uint16, DataType::Uint32] {
            let mut opened = make_dataset_opened();
            let source = opened.manifest.images()[0].clone();
            let mut label_image = source.clone();
            label_image.image_id = ImageId("label-image".into());
            label_image.multiscale.data_type = data_type;
            opened.manifest = opened.manifest.with_labels(vec![LabelSpec {
                name: "regions".into(),
                source_image_id: source.image_id,
                image: label_image,
                colors: vec![LabelColor {
                    value: 42,
                    rgba: [1, 2, 3, 255],
                }],
                source_declared: true,
            }]);
            let FetchSource::Proxied(fetch) = &mut opened.fetch;
            fetch.images.push(ProxiedImageSpec {
                image_id: ImageId("label-image".into()),
                wire_format: WireFormat::Raw { data_type },
            });

            opened.validate().unwrap();
            let format = renderer_chunk_format(ChunkRole::Label, data_type).unwrap();
            assert_eq!(format.data_type, RendererChunkDataType::Uint32);
            assert_eq!(format.gpu_bytes_per_voxel, 4);
        }
    }

    #[test]
    fn packed_time_or_channel_chunks_reject_before_open() {
        for axis in [0, 1] {
            let mut opened = make_dataset_opened();
            let level = &mut opened.manifest.images_mut()[0].multiscale.levels[0];
            level.shape[axis] = 2;
            level.chunk_shape[axis] = 2;
            level.grid_shape[axis] = 1;
            let error = opened.validate().unwrap_err();
            assert_eq!(error.category, DatasetOpenedValidationCategory::Unsupported);
            assert!(error.path.ends_with("chunk_shape"));
        }
    }

    #[test]
    fn json_top_level_keys() {
        let event = make_dataset_opened();
        let json = serde_json::to_string(&event).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert!(value.is_object());
        assert!(value.get("manifest").is_some(), "missing 'manifest' key");
        assert!(value.get("fetch").is_some(), "missing 'fetch' key");
    }

    #[test]
    fn dataset_opened_opener_client_id_round_trip() {
        // A stamped opener id survives a full serde round-trip and lands on the
        // wire as a plain JSON number under `opener_client_id`.
        let mut event = make_dataset_opened();
        event.opener_client_id = Some(7);
        let json = serde_json::to_string(&event).unwrap();

        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            val.get("opener_client_id").and_then(|v| v.as_u64()),
            Some(7),
            "opener_client_id should serialize as a JSON number"
        );

        let back: DatasetOpened = serde_json::from_str(&json).unwrap();
        assert_eq!(back.opener_client_id, Some(7));
    }

    #[test]
    fn dataset_opened_opener_client_id_none_round_trip() {
        // The default/no-opener case round-trips as None.
        let event = make_dataset_opened();
        assert_eq!(event.opener_client_id, None);
        let json = serde_json::to_string(&event).unwrap();
        let back: DatasetOpened = serde_json::from_str(&json).unwrap();
        assert_eq!(back.opener_client_id, None);
    }

    #[test]
    fn dataset_opened_backward_compat_without_opener_client_id() {
        // Older payloads (pre-origin-aware servers) omit `opener_client_id`
        // entirely — `#[serde(default)]` must deserialize it as None rather
        // than failing, so a stale client/server can still interop.
        let event = make_dataset_opened();
        let json = serde_json::to_string(&event).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("opener_client_id");
        assert!(
            val.get("opener_client_id").is_none(),
            "precondition: field removed from payload"
        );
        let back: DatasetOpened = serde_json::from_value(val).unwrap();
        assert_eq!(back.opener_client_id, None);
    }
}
