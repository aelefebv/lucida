use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use lucida_content::{DatasetManifest, GeneratedLevelRole, ImageId};
use lucida_protocol::{
    GeneratedAvailabilityDelta, GeneratedAvailabilitySnapshot, GeneratedChunkStatus,
    GeneratedChunkStatusUpdate, GeneratedLevelAvailability,
};

#[derive(Debug, Clone)]
pub enum DerivedChunkLookup {
    Ready(Vec<u8>),
    Status {
        status: GeneratedChunkStatus,
        message: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DerivedChunkKey {
    image_id: ImageId,
    level_index: u32,
    key: String,
}

#[derive(Debug, Clone)]
struct DerivedChunkEntry {
    status: GeneratedChunkStatus,
    message: Option<String>,
    bytes: Option<Vec<u8>>,
}

#[derive(Debug, Default)]
struct DerivedChunkState {
    availability: GeneratedAvailabilitySnapshot,
    chunks: HashMap<DerivedChunkKey, DerivedChunkEntry>,
}

/// In-memory runtime registry for generated levels and seeded fake chunks.
///
/// Durable cache materialization lands in the next slice. This registry still
/// gives the server a source-aware resolver contract now: generated level keys
/// do not hit source storage, and unready generated chunks return explicit
/// statuses instead of disappearing as timeouts.
#[derive(Debug, Clone, Default)]
pub struct DerivedChunkCache {
    inner: Arc<Mutex<DerivedChunkState>>,
}

impl DerivedChunkCache {
    pub fn new(snapshot: GeneratedAvailabilitySnapshot) -> Self {
        let cache = Self::default();
        cache.replace_snapshot(snapshot);
        cache
    }

    pub fn snapshot(&self) -> GeneratedAvailabilitySnapshot {
        self.inner.lock().unwrap().availability.clone()
    }

    pub fn replace_snapshot(&self, snapshot: GeneratedAvailabilitySnapshot) {
        let mut state = self.inner.lock().unwrap();
        state.availability = snapshot.clone();
        state.chunks.clear();
        for chunk in snapshot.chunks {
            let key = DerivedChunkKey {
                image_id: chunk.image_id,
                level_index: chunk.level_index,
                key: chunk.key,
            };
            state.chunks.insert(
                key,
                DerivedChunkEntry {
                    status: chunk.status,
                    message: chunk.message,
                    bytes: None,
                },
            );
        }
    }

    pub fn apply_delta(&self, delta: GeneratedAvailabilityDelta) {
        let mut state = self.inner.lock().unwrap();
        state.availability.apply_delta(delta.clone());
        for chunk in delta.chunks {
            let key = DerivedChunkKey {
                image_id: chunk.image_id,
                level_index: chunk.level_index,
                key: chunk.key,
            };
            state
                .chunks
                .entry(key)
                .and_modify(|entry| {
                    entry.status = chunk.status;
                    entry.message = chunk.message.clone();
                    if chunk.status != GeneratedChunkStatus::Ready {
                        entry.bytes = None;
                    }
                })
                .or_insert(DerivedChunkEntry {
                    status: chunk.status,
                    message: chunk.message,
                    bytes: None,
                });
        }
    }

    pub fn upsert_level(&self, level: GeneratedLevelAvailability) {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: vec![],
        });
    }

    pub fn set_chunk_status(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        status: GeneratedChunkStatus,
        message: Option<String>,
    ) {
        self.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id,
                level_index,
                key,
                status,
                message,
            }],
        });
    }

    pub fn seed_ready_chunk(
        &self,
        image_id: ImageId,
        level_index: u32,
        key: String,
        bytes: Vec<u8>,
    ) {
        let mut state = self.inner.lock().unwrap();
        state.availability.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: image_id.clone(),
                level_index,
                key: key.clone(),
                status: GeneratedChunkStatus::Ready,
                message: None,
            }],
        });
        state.chunks.insert(
            DerivedChunkKey {
                image_id,
                level_index,
                key,
            },
            DerivedChunkEntry {
                status: GeneratedChunkStatus::Ready,
                message: None,
                bytes: Some(bytes),
            },
        );
    }

    pub fn is_generated_level(&self, image_id: &ImageId, level_index: u32) -> bool {
        self.inner
            .lock()
            .unwrap()
            .availability
            .levels
            .iter()
            .any(|level| level.image_id == *image_id && level.info.level_index == level_index)
    }

    pub fn lookup(&self, image_id: &ImageId, level_index: u32, key: &str) -> DerivedChunkLookup {
        let state = self.inner.lock().unwrap();
        let chunk_key = DerivedChunkKey {
            image_id: image_id.clone(),
            level_index,
            key: key.to_string(),
        };
        if let Some(entry) = state.chunks.get(&chunk_key) {
            if entry.status == GeneratedChunkStatus::Ready {
                if let Some(bytes) = &entry.bytes {
                    return DerivedChunkLookup::Ready(bytes.clone());
                }
                return DerivedChunkLookup::Status {
                    status: GeneratedChunkStatus::Unavailable,
                    message: Some("generated chunk marked ready but bytes are unavailable".into()),
                };
            }
            return DerivedChunkLookup::Status {
                status: entry.status,
                message: entry.message.clone(),
            };
        }

        if state
            .availability
            .levels
            .iter()
            .any(|level| level.image_id == *image_id && level.info.level_index == level_index)
        {
            return DerivedChunkLookup::Status {
                status: GeneratedChunkStatus::Pending,
                message: None,
            };
        }

        DerivedChunkLookup::Status {
            status: GeneratedChunkStatus::Unavailable,
            message: Some("generated level is not registered".into()),
        }
    }
}

pub fn merge_generated_availability_into_manifest(
    manifest: &mut DatasetManifest,
    availability: &GeneratedAvailabilitySnapshot,
) {
    for level in &availability.levels {
        let Some(image) = manifest
            .images_mut()
            .iter_mut()
            .find(|image| image.image_id == level.image_id)
        else {
            continue;
        };

        if let Some(existing) = image
            .multiscale
            .levels
            .iter_mut()
            .find(|existing| existing.level_index == level.level.level_index)
        {
            *existing = level.level.clone();
        } else {
            let insert_at = level.level.level_index as usize;
            if insert_at <= image.multiscale.levels.len() {
                image
                    .multiscale
                    .levels
                    .insert(insert_at, level.level.clone());
            } else {
                image.multiscale.levels.push(level.level.clone());
            }
        }

        if let Some(existing) = image
            .multiscale
            .generated_levels
            .iter_mut()
            .find(|existing| existing.level_index == level.info.level_index)
        {
            *existing = level.info.clone();
        } else {
            image.multiscale.generated_levels.push(level.info.clone());
        }

        if level.info.role == GeneratedLevelRole::Coarse {
            image.multiscale.coarse_level_index = Some(level.info.level_index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::{
        Axis, AxisKind, DataType, DatasetId, DatasetKind, Entity, EntityId, EntityKind,
        EntityLabels, GeneratedLevelInfo, GeneratedLevelProvenance, LevelGeometry, MultiscaleInfo,
    };

    fn generated_level() -> GeneratedLevelAvailability {
        GeneratedLevelAvailability {
            image_id: ImageId("img-1".into()),
            info: GeneratedLevelInfo {
                level_index: 1,
                role: GeneratedLevelRole::Coarse,
                provenance: GeneratedLevelProvenance::default(),
            },
            level: LevelGeometry {
                level_index: 1,
                shape: [1, 1, 1, 64, 64],
                chunk_shape: [1, 1, 1, 64, 64],
                grid_shape: [1, 1, 1, 1, 1],
                scale: [1.0, 1.0, 1.0, 4.0, 4.0],
            },
            summary: None,
        }
    }

    fn source_manifest() -> DatasetManifest {
        let entity_id = EntityId("entity-1".into());
        DatasetManifest::new(
            DatasetId("ds-1".into()),
            "test".into(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels::default(),
            }],
            vec![],
            vec![lucida_content::ImageSpec {
                image_id: ImageId("img-1".into()),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".into(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".into(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".into(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 1, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 1, 2, 2],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                },
            }],
            vec![],
            None,
        )
    }

    #[test]
    fn generated_level_without_chunk_status_is_pending() {
        let cache = DerivedChunkCache::default();
        cache.upsert_level(generated_level());

        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Status { status, .. } => {
                assert_eq!(status, GeneratedChunkStatus::Pending);
            }
            DerivedChunkLookup::Ready(_) => panic!("expected pending"),
        }
    }

    #[test]
    fn seeded_ready_chunk_returns_bytes() {
        let cache = DerivedChunkCache::default();
        cache.upsert_level(generated_level());
        cache.seed_ready_chunk(
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        );

        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Ready(bytes) => assert_eq!(bytes, vec![1, 2, 3, 4]),
            DerivedChunkLookup::Status { status, .. } => {
                panic!("expected ready, got {status:?}");
            }
        }
    }

    #[test]
    fn explicit_statuses_are_returned() {
        let cache = DerivedChunkCache::default();
        cache.upsert_level(generated_level());
        for status in [
            GeneratedChunkStatus::Unavailable,
            GeneratedChunkStatus::FailedTransient,
            GeneratedChunkStatus::FailedPermanent,
        ] {
            cache.set_chunk_status(
                ImageId("img-1".into()),
                1,
                "1/0/0/0/0/0".into(),
                status,
                Some("status".into()),
            );
            match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
                DerivedChunkLookup::Status { status: got, .. } => assert_eq!(got, status),
                DerivedChunkLookup::Ready(_) => panic!("expected status"),
            }
        }
    }

    #[test]
    fn availability_merges_into_client_visible_manifest() {
        let mut manifest = source_manifest();
        let snapshot = GeneratedAvailabilitySnapshot {
            levels: vec![generated_level()],
            chunks: vec![],
        };

        merge_generated_availability_into_manifest(&mut manifest, &snapshot);

        let multiscale = &manifest.images()[0].multiscale;
        assert_eq!(multiscale.levels.len(), 2);
        assert_eq!(multiscale.generated_levels.len(), 1);
        assert_eq!(multiscale.coarse_level_index, Some(1));
    }
}
