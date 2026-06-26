use crate::asset::AssetCatalog;
use crate::fetch::FetchSource;
use lucida_content::DatasetManifest;
use serde::{Deserialize, Serialize};

/// Stable id of a connected client. Mirrors `lucida_core::protocol::ClientId`
/// (also `u64`); defined locally because `lucida-core` depends on
/// `lucida-protocol`, so importing it here would form a dependency cycle. The
/// wire form is identical (a JSON number), so the two are interchangeable
/// across the serde boundary.
pub type ClientId = u64;

/// Application-level event: a dataset has been opened on the server and
/// should be registered by all clients. Carries the canonical dataset
/// manifest, the client-visible fetch source, and the initial asset
/// catalog snapshot for proxy availability. Does NOT carry server-private
/// binding state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetOpened {
    pub manifest: DatasetManifest,
    pub fetch: FetchSource,
    /// Initial asset catalog. `#[serde(default)]` keeps backward compat
    /// with messages that omit the field (older clients/snapshots).
    #[serde(default)]
    pub catalog: AssetCatalog,
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
            catalog: AssetCatalog::default(),
            opener_client_id: None,
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
                footprints: vec![],
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
