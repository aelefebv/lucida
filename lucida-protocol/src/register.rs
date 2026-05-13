use crate::asset::AssetCatalog;
use crate::fetch::FetchSource;
use lucida_content::DatasetManifest;
use serde::{Deserialize, Serialize};

/// Application-level event: a dataset has been opened on the server and
/// should be registered by all clients. Carries the canonical dataset
/// manifest, the client-visible fetch source, and the initial asset
/// catalog snapshot for proxy availability. Does NOT carry server-private
/// binding state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetOpened {
    pub manifest: DatasetManifest,
    pub fetch: FetchSource,
    /// Initial asset catalog. Empty in S3 — populated by S5.
    /// `#[serde(default)]` keeps backward compat with messages that omit
    /// the field (older clients/snapshots).
    #[serde(default)]
    pub catalog: AssetCatalog,
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
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
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
            catalog: AssetCatalog::default(),
        }
    }

    #[test]
    fn dataset_opened_round_trip() {
        let event = make_dataset_opened();
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

        match &back.fetch {
            FetchSource::Proxied(p) => {
                assert_eq!(p.images.len(), 1);
                assert_eq!(p.images[0].image_id, ImageId("multiscale-0".to_string()));
            }
            _ => panic!("expected Proxied variant"),
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
        assert!(value.get("catalog").is_some(), "missing 'catalog' key");
    }

    #[test]
    fn dataset_opened_catalog_round_trip() {
        use crate::asset::ProxyAvailability;
        use lucida_proxy::ProxyKind;

        let mut event = make_dataset_opened();
        event.catalog = AssetCatalog {
            entries: vec![ProxyAvailability {
                entity_id: EntityId("img-0".into()),
                kinds: vec![ProxyKind::FieldProxy3D],
            }],
        };
        let json = serde_json::to_string(&event).unwrap();
        let back: DatasetOpened = serde_json::from_str(&json).unwrap();
        assert_eq!(back.catalog.entries.len(), 1);
        assert_eq!(back.catalog.entries[0].entity_id, EntityId("img-0".into()));
        assert_eq!(back.catalog.entries[0].kinds, vec![ProxyKind::FieldProxy3D]);
    }

    #[test]
    fn dataset_opened_backward_compat_without_catalog() {
        // Older messages omit 'catalog' — should deserialize with empty default.
        let event = make_dataset_opened();
        let json = serde_json::to_string(&event).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("catalog");
        let back: DatasetOpened = serde_json::from_value(val).unwrap();
        assert!(back.catalog.entries.is_empty());
    }
}
