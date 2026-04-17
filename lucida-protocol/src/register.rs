use lucida_content::ContentGraph;
use crate::asset::AssetCatalog;
use crate::fetch::ClientFetchDescriptor;
use serde::{Deserialize, Serialize};

/// Application-level message: a dataset has been imported and should be registered.
/// Carries canonical content, client-visible fetch metadata, and the
/// initial asset catalog snapshot for proxy availability.
/// Does NOT carry server-private binding state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDataset {
    pub content: ContentGraph,
    pub fetch: ClientFetchDescriptor,
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

    fn make_register_dataset() -> RegisterDataset {
        let entity_id = EntityId("img-0".to_string());
        let image_id = ImageId("multiscale-0".to_string());

        let content = ContentGraph::new(
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
                transform: AffineTransform::identity(),
            }],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis { name: "z".to_string(), kind: AxisKind::Space },
                        Axis { name: "y".to_string(), kind: AxisKind::Space },
                        Axis { name: "x".to_string(), kind: AxisKind::Space },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 0.5, 0.5],
                    }],
                    data_type: DataType::Uint16,
                },
            }],
            vec![],
            None,
        );

        let fetch = ClientFetchDescriptor::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });

        RegisterDataset { content, fetch, catalog: AssetCatalog::default() }
    }

    #[test]
    fn register_dataset_round_trip() {
        let reg = make_register_dataset();
        let json = serde_json::to_string_pretty(&reg).unwrap();
        let back: RegisterDataset = serde_json::from_str(&json).unwrap();

        assert_eq!(reg.content.dataset_id, back.content.dataset_id);
        assert_eq!(reg.content.name, back.content.name);
        assert_eq!(reg.content.entities().len(), back.content.entities().len());
        assert_eq!(reg.content.images().len(), back.content.images().len());
        assert_eq!(
            reg.content.images()[0].image_id,
            back.content.images()[0].image_id
        );

        match &back.fetch {
            ClientFetchDescriptor::Proxied(p) => {
                assert_eq!(p.images.len(), 1);
                assert_eq!(
                    p.images[0].image_id,
                    ImageId("multiscale-0".to_string())
                );
            }
            _ => panic!("expected Proxied variant"),
        }
    }

    #[test]
    fn json_top_level_keys() {
        let reg = make_register_dataset();
        let json = serde_json::to_string(&reg).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert!(value.is_object());
        assert!(value.get("content").is_some(), "missing 'content' key");
        assert!(value.get("fetch").is_some(), "missing 'fetch' key");
        assert!(value.get("catalog").is_some(), "missing 'catalog' key");
    }

    #[test]
    fn register_dataset_catalog_round_trip() {
        use crate::asset::ProxyAvailability;
        use lucida_proxy::ProxyKind;

        let mut reg = make_register_dataset();
        reg.catalog = AssetCatalog {
            entries: vec![ProxyAvailability {
                entity_id: EntityId("img-0".into()),
                kinds: vec![ProxyKind::FieldProxy3D],
            }],
        };
        let json = serde_json::to_string(&reg).unwrap();
        let back: RegisterDataset = serde_json::from_str(&json).unwrap();
        assert_eq!(back.catalog.entries.len(), 1);
        assert_eq!(back.catalog.entries[0].entity_id, EntityId("img-0".into()));
        assert_eq!(back.catalog.entries[0].kinds, vec![ProxyKind::FieldProxy3D]);
    }

    #[test]
    fn register_dataset_backward_compat_without_catalog() {
        // Older messages omit 'catalog' — should deserialize with empty default.
        let reg = make_register_dataset();
        let json = serde_json::to_string(&reg).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("catalog");
        let back: RegisterDataset = serde_json::from_value(val).unwrap();
        assert!(back.catalog.entries.is_empty());
    }
}
