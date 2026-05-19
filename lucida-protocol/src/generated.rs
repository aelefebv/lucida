use lucida_content::{GeneratedLevelInfo, ImageId, LevelGeometry};
use serde::{Deserialize, Serialize};

/// Runtime availability state for server-generated pyramid levels.
///
/// This is intentionally separate from document commands: the server owns
/// generated metadata/readiness and clients merge it into their local runtime
/// view of a dataset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeneratedAvailabilitySnapshot {
    #[serde(default)]
    pub levels: Vec<GeneratedLevelAvailability>,
    #[serde(default)]
    pub chunks: Vec<GeneratedChunkStatusUpdate>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeneratedAvailabilityDelta {
    #[serde(default)]
    pub levels: Vec<GeneratedLevelAvailability>,
    #[serde(default)]
    pub chunks: Vec<GeneratedChunkStatusUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedLevelAvailability {
    pub image_id: ImageId,
    pub info: GeneratedLevelInfo,
    pub level: LevelGeometry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<GeneratedLevelSummary>,
}

/// Level-level counts are telemetry only. Clients must use per-chunk status
/// for readiness decisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedLevelSummary {
    pub total_chunks: u64,
    pub ready_chunks: u64,
    pub pending_chunks: u64,
    pub failed_chunks: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedChunkStatusUpdate {
    pub image_id: ImageId,
    pub level_index: u32,
    pub key: String,
    pub status: GeneratedChunkStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratedChunkStatus {
    Pending,
    Unavailable,
    FailedTransient,
    FailedPermanent,
    Ready,
}

impl GeneratedAvailabilitySnapshot {
    pub fn apply_delta(&mut self, delta: GeneratedAvailabilityDelta) {
        for level in delta.levels {
            upsert_level(&mut self.levels, level);
        }
        for chunk in delta.chunks {
            upsert_chunk(&mut self.chunks, chunk);
        }
    }
}

fn upsert_level(
    levels: &mut Vec<GeneratedLevelAvailability>,
    incoming: GeneratedLevelAvailability,
) {
    if let Some(existing) = levels.iter_mut().find(|level| {
        level.image_id == incoming.image_id && level.info.level_index == incoming.info.level_index
    }) {
        *existing = incoming;
    } else {
        levels.push(incoming);
    }
}

fn upsert_chunk(
    chunks: &mut Vec<GeneratedChunkStatusUpdate>,
    incoming: GeneratedChunkStatusUpdate,
) {
    if let Some(existing) = chunks.iter_mut().find(|chunk| {
        chunk.image_id == incoming.image_id
            && chunk.level_index == incoming.level_index
            && chunk.key == incoming.key
    }) {
        *existing = incoming;
    } else {
        chunks.push(incoming);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::{GeneratedLevelProvenance, GeneratedLevelRole};

    fn level_availability() -> GeneratedLevelAvailability {
        GeneratedLevelAvailability {
            image_id: ImageId("img-1".into()),
            info: GeneratedLevelInfo {
                level_index: 2,
                role: GeneratedLevelRole::Coarse,
                provenance: GeneratedLevelProvenance {
                    generator: "test-generator".into(),
                    config_id: "coarse-128".into(),
                    source_content_id: Some("src".into()),
                },
            },
            level: LevelGeometry {
                level_index: 2,
                shape: [1, 1, 1, 64, 64],
                chunk_shape: [1, 1, 1, 64, 64],
                grid_shape: [1, 1, 1, 1, 1],
                scale: [1.0, 1.0, 1.0, 8.0, 8.0],
            },
            summary: Some(GeneratedLevelSummary {
                total_chunks: 1,
                ready_chunks: 0,
                pending_chunks: 1,
                failed_chunks: 0,
            }),
        }
    }

    #[test]
    fn generated_availability_round_trips_status_names() {
        let delta = GeneratedAvailabilityDelta {
            levels: vec![level_availability()],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 2,
                key: "2/0/0/0/0/0".into(),
                status: GeneratedChunkStatus::FailedTransient,
                message: Some("temporary".into()),
            }],
        };

        let json = serde_json::to_string(&delta).unwrap();
        assert!(json.contains("\"failed_transient\""));
        let back: GeneratedAvailabilityDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.levels[0].info.level_index,
            delta.levels[0].info.level_index
        );
        assert_eq!(back.chunks[0].status, GeneratedChunkStatus::FailedTransient);
    }

    #[test]
    fn applying_delta_upserts_level_and_chunk() {
        let mut snapshot = GeneratedAvailabilitySnapshot::default();
        snapshot.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level_availability()],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 2,
                key: "2/0/0/0/0/0".into(),
                status: GeneratedChunkStatus::Pending,
                message: None,
            }],
        });
        snapshot.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![GeneratedLevelAvailability {
                summary: None,
                ..level_availability()
            }],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 2,
                key: "2/0/0/0/0/0".into(),
                status: GeneratedChunkStatus::Ready,
                message: None,
            }],
        });

        assert_eq!(snapshot.levels.len(), 1);
        assert_eq!(snapshot.levels[0].summary, None);
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].status, GeneratedChunkStatus::Ready);
    }
}
