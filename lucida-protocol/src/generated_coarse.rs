use std::collections::BTreeMap;

use lucida_content::{GeneratedLevelInfo, ImageId, LevelGeometry};
use serde::{Deserialize, Serialize};

use crate::diagnostics::FailureDescriptor;

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

/// Runtime indexes and wire snapshots share the same hard ceilings. Once an
/// index reaches a ceiling, updates to already-admitted keys still replace the
/// current value, while new keys are rejected. This first-admitted policy is
/// deterministic, keeps hot status transitions useful, and prevents a stream
/// of unique keys from turning either server runtime state or a snapshot into
/// an unbounded allocation.
pub const MAX_GENERATED_RUNTIME_LEVELS: usize = 4_096;
pub const MAX_GENERATED_RUNTIME_CHUNKS: usize = 65_536;
pub const MAX_GENERATED_SNAPSHOT_LEVELS: usize = MAX_GENERATED_RUNTIME_LEVELS;
pub const MAX_GENERATED_SNAPSHOT_CHUNKS: usize = MAX_GENERATED_RUNTIME_CHUNKS;

#[derive(Debug, Clone, Default)]
pub struct GeneratedAvailabilityIndex {
    // BTreeMap gives snapshots stable order without cloning and sorting the
    // entire index before applying a wire limit.
    levels: BTreeMap<(String, u32), GeneratedLevelAvailability>,
    chunks: BTreeMap<(String, u32, String), GeneratedChunkStatusUpdate>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GeneratedIndexApplyStats {
    pub level_writes: usize,
    pub chunk_writes: usize,
    pub level_rejections: usize,
    pub chunk_rejections: usize,
}

impl GeneratedAvailabilityIndex {
    pub fn from_snapshot(snapshot: GeneratedAvailabilitySnapshot) -> Self {
        let mut index = Self::default();
        index.apply_delta(GeneratedAvailabilityDelta {
            levels: snapshot.levels,
            chunks: snapshot.chunks,
        });
        index
    }

    /// O(number of incoming records * log(runtime ceiling)).
    ///
    /// Levels are installed first so a delta may register a level and its
    /// first statuses atomically. A chunk is admitted only when its canonical
    /// key belongs to the exact registered image, level, and grid.
    pub fn apply_delta(&mut self, delta: GeneratedAvailabilityDelta) -> GeneratedIndexApplyStats {
        self.apply_delta_with_limits(
            delta,
            MAX_GENERATED_RUNTIME_LEVELS,
            MAX_GENERATED_RUNTIME_CHUNKS,
        )
    }

    /// Apply a delta while honoring caller-provided ceilings no larger than
    /// the protocol runtime bounds. Existing keys remain updatable at a full
    /// ceiling; only admission of new keys consumes capacity.
    pub fn apply_delta_with_limits(
        &mut self,
        delta: GeneratedAvailabilityDelta,
        max_levels: usize,
        max_chunks: usize,
    ) -> GeneratedIndexApplyStats {
        let max_levels = max_levels.min(MAX_GENERATED_RUNTIME_LEVELS);
        let max_chunks = max_chunks.min(MAX_GENERATED_RUNTIME_CHUNKS);
        let mut stats = GeneratedIndexApplyStats {
            level_writes: delta.levels.len(),
            chunk_writes: delta.chunks.len(),
            level_rejections: 0,
            chunk_rejections: 0,
        };
        for level in delta.levels {
            let key = (level.image_id.0.clone(), level.info.level_index);
            if !registered_level_is_valid(&level)
                || (!self.levels.contains_key(&key) && self.levels.len() >= max_levels)
            {
                stats.level_rejections += 1;
                continue;
            }
            self.levels.insert(key, level);
        }
        for chunk in delta.chunks {
            let key = (
                chunk.image_id.0.clone(),
                chunk.level_index,
                chunk.key.clone(),
            );
            if !self.chunk_key_is_registered(&chunk.image_id, chunk.level_index, &chunk.key)
                || (!self.chunks.contains_key(&key) && self.chunks.len() >= max_chunks)
            {
                stats.chunk_rejections += 1;
                continue;
            }
            self.chunks.insert(key, chunk);
        }
        stats
    }

    pub fn snapshot(&self) -> GeneratedAvailabilitySnapshot {
        self.snapshot_with_limits(MAX_GENERATED_SNAPSHOT_LEVELS, MAX_GENERATED_SNAPSHOT_CHUNKS)
    }

    pub fn snapshot_with_limits(
        &self,
        max_levels: usize,
        max_chunks: usize,
    ) -> GeneratedAvailabilitySnapshot {
        let levels = self.levels.values().take(max_levels).cloned().collect();
        let chunks = self.chunks.values().take(max_chunks).cloned().collect();
        GeneratedAvailabilitySnapshot { levels, chunks }
    }

    pub fn level(
        &self,
        image_id: &ImageId,
        level_index: u32,
    ) -> Option<&GeneratedLevelAvailability> {
        self.levels.get(&(image_id.0.clone(), level_index))
    }

    pub fn chunk(
        &self,
        image_id: &ImageId,
        level_index: u32,
        key: &str,
    ) -> Option<&GeneratedChunkStatusUpdate> {
        self.chunks
            .get(&(image_id.0.clone(), level_index, key.to_string()))
    }

    /// Whether `key` is canonical and lies inside the exact registered grid.
    pub fn chunk_key_is_registered(&self, image_id: &ImageId, level_index: u32, key: &str) -> bool {
        let Some(level) = self.level(image_id, level_index) else {
            return false;
        };
        chunk_key_belongs_to_level(key, level)
    }

    pub fn levels(&self) -> impl Iterator<Item = &GeneratedLevelAvailability> {
        self.levels.values()
    }

    pub fn chunks(&self) -> impl Iterator<Item = &GeneratedChunkStatusUpdate> {
        self.chunks.values()
    }

    pub fn level_count(&self) -> usize {
        self.levels.len()
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }
}

fn registered_level_is_valid(level: &GeneratedLevelAvailability) -> bool {
    level.info.level_index == level.level.level_index
        && level
            .level
            .chunk_shape
            .iter()
            .zip(level.level.grid_shape.iter())
            .all(|(chunk, grid)| *chunk > 0 && *grid > 0)
}

fn chunk_key_belongs_to_level(key: &str, level: &GeneratedLevelAvailability) -> bool {
    let mut parts = key.split('/');
    let Some(level_index) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let Some(t) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(c) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(z) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(y) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(x) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let grid = level.level.grid_shape;
    level_index == level.info.level_index
        && t < grid[0]
        && c < grid[1]
        && z < grid[2]
        && y < grid[3]
        && x < grid[4]
        && key == format!("{level_index}/{t}/{c}/{z}/{y}/{x}")
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
    pub failure: Option<FailureDescriptor>,
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
                failure: Some(FailureDescriptor::new(
                    crate::diagnostics::FailureCode::StorageBackend,
                    true,
                )),
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
        assert_eq!(
            back.chunks[0].failure.as_ref().map(|failure| failure.kind),
            Some(crate::diagnostics::FailureCode::StorageBackend),
        );
        assert!(back.chunks[0].failure.as_ref().unwrap().retryable);
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
                failure: None,
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
                failure: None,
                message: None,
            }],
        });

        assert_eq!(snapshot.levels.len(), 1);
        assert_eq!(snapshot.levels[0].summary, None);
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].status, GeneratedChunkStatus::Ready);
    }

    #[test]
    fn keyed_index_deduplicates_and_materializes_deterministically_with_bounds() {
        let mut index = GeneratedAvailabilityIndex::default();
        let mut level = level_availability();
        level.level.shape[4] = 3;
        level.level.grid_shape[4] = 3;
        index.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: vec![],
        });
        for key in ["2/0/0/0/0/2", "2/0/0/0/0/0", "2/0/0/0/0/1"] {
            index.apply_delta(GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![GeneratedChunkStatusUpdate {
                    image_id: ImageId("img-1".into()),
                    level_index: 2,
                    key: key.into(),
                    status: GeneratedChunkStatus::Pending,
                    failure: None,
                    message: None,
                }],
            });
        }
        index.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: vec![GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 2,
                key: "2/0/0/0/0/1".into(),
                status: GeneratedChunkStatus::Ready,
                failure: None,
                message: None,
            }],
        });

        assert_eq!(index.chunk_count(), 3);
        let snapshot = index.snapshot_with_limits(0, 2);
        assert!(snapshot.levels.is_empty());
        assert_eq!(snapshot.chunks.len(), 2);
        assert_eq!(snapshot.chunks[0].key, "2/0/0/0/0/0");
        assert_eq!(snapshot.chunks[1].key, "2/0/0/0/0/1");
        assert_eq!(snapshot.chunks[1].status, GeneratedChunkStatus::Ready);
    }

    #[test]
    fn one_hundred_thousand_transitions_have_linear_keyed_work_and_bounded_snapshot() {
        let mut index = GeneratedAvailabilityIndex::default();
        let mut level = level_availability();
        level.level.shape = [1, 1, 1, 100, 1_000];
        level.level.grid_shape = [1, 1, 1, 100, 1_000];
        index.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: vec![],
        });
        let mut writes = 0usize;
        for batch in 0..100 {
            let chunks = (0..1_000)
                .map(|offset| GeneratedChunkStatusUpdate {
                    image_id: ImageId("img-1".into()),
                    level_index: 2,
                    key: format!("2/0/0/0/{batch}/{offset}"),
                    status: GeneratedChunkStatus::Ready,
                    failure: None,
                    message: None,
                })
                .collect();
            writes += index
                .apply_delta(GeneratedAvailabilityDelta {
                    levels: vec![],
                    chunks,
                })
                .chunk_writes;
        }
        assert_eq!(writes, 100_000, "one keyed write per transition");
        assert_eq!(index.chunk_count(), MAX_GENERATED_RUNTIME_CHUNKS);
        assert_eq!(index.snapshot().chunks.len(), MAX_GENERATED_SNAPSHOT_CHUNKS);
    }

    #[test]
    fn malformed_noncanonical_and_out_of_grid_keys_never_enter_runtime_state() {
        let mut index = GeneratedAvailabilityIndex::from_snapshot(GeneratedAvailabilitySnapshot {
            levels: vec![level_availability()],
            chunks: vec![],
        });
        let invalid = [
            "garbage",
            "2/0/0/0/0",
            "2/0/0/0/0/0/0",
            "2/00/0/0/0/0",
            "3/0/0/0/0/0",
            "2/1/0/0/0/0",
            "2/0/1/0/0/0",
            "2/0/0/1/0/0",
            "2/0/0/0/1/0",
            "2/0/0/0/0/1",
        ];
        let stats = index.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: invalid
                .into_iter()
                .map(|key| GeneratedChunkStatusUpdate {
                    image_id: ImageId("img-1".into()),
                    level_index: 2,
                    key: key.into(),
                    status: GeneratedChunkStatus::FailedPermanent,
                    failure: None,
                    message: None,
                })
                .collect(),
        });

        assert_eq!(stats.chunk_rejections, invalid.len());
        assert_eq!(index.chunk_count(), 0);
        assert!(index.snapshot().chunks.is_empty());
    }

    #[test]
    fn snapshot_limit_is_applied_before_values_are_cloned() {
        let mut index = GeneratedAvailabilityIndex::default();
        let mut level = level_availability();
        level.level.shape[4] = 16;
        level.level.grid_shape[4] = 16;
        index.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: vec![],
        });
        index.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: (0..16)
                .map(|x| GeneratedChunkStatusUpdate {
                    image_id: ImageId("img-1".into()),
                    level_index: 2,
                    key: format!("2/0/0/0/0/{x}"),
                    status: GeneratedChunkStatus::Pending,
                    failure: None,
                    message: Some("retained".repeat(1_024)),
                })
                .collect(),
        });

        let snapshot = index.snapshot_with_limits(0, 2);
        assert_eq!(snapshot.chunks.len(), 2);
        assert_eq!(snapshot.chunks[0].key, "2/0/0/0/0/0");
        assert_eq!(snapshot.chunks[1].key, "2/0/0/0/0/1");
    }
}
