use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::model::{GenerationRecord, GenerationStage};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationArtifactLayout {
    pub generation_root: PathBuf,
    pub canonical_cache_root: PathBuf,
    pub preview_root: PathBuf,
    pub tile_root: PathBuf,
    pub brick_root: PathBuf,
}

impl GenerationArtifactLayout {
    #[must_use]
    pub fn for_generation(
        cache_root: impl AsRef<Path>,
        source_id: &str,
        generation_seq: u64,
    ) -> Self {
        let generation_root = cache_root
            .as_ref()
            .join(source_id)
            .join(format!("gen_{generation_seq:08}"));
        Self {
            canonical_cache_root: generation_root.join("canonical.ome.zarr"),
            preview_root: generation_root.join("preview2d"),
            tile_root: generation_root.join("tile2d"),
            brick_root: generation_root.join("brick3d"),
            generation_root,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    pub previous_working_ttl_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionDecision {
    pub keep_generation_seqs: BTreeSet<u64>,
    pub gc_generation_seqs: Vec<u64>,
}

#[must_use]
pub fn decide_retention(
    generations: &BTreeMap<u64, GenerationRecord>,
    latest_working_generation_seq: u64,
    now_unix_seconds: i64,
    policy: RetentionPolicy,
) -> RetentionDecision {
    let mut keep = BTreeSet::new();
    if latest_working_generation_seq > 0 && generations.contains_key(&latest_working_generation_seq)
    {
        keep.insert(latest_working_generation_seq);
    }

    let mut previous_working = latest_working_generation_seq.saturating_sub(1);
    while previous_working > 0 {
        if let Some(previous) = generations.get(&previous_working) {
            if should_keep_previous(previous, now_unix_seconds, policy.previous_working_ttl_secs) {
                keep.insert(previous_working);
            }
            break;
        }
        previous_working = previous_working.saturating_sub(1);
    }

    for (generation_seq, generation) in generations {
        if matches!(generation.stage, GenerationStage::Pinned) {
            keep.insert(*generation_seq);
        }
    }

    let gc_generation_seqs = generations
        .keys()
        .copied()
        .filter(|generation_seq| !keep.contains(generation_seq))
        .collect::<Vec<_>>();

    RetentionDecision {
        keep_generation_seqs: keep,
        gc_generation_seqs,
    }
}

fn should_keep_previous(
    generation: &GenerationRecord,
    now_unix_seconds: i64,
    ttl_seconds: u64,
) -> bool {
    if ttl_seconds == 0 {
        return false;
    }
    if matches!(generation.stage, GenerationStage::Pinned) {
        return true;
    }

    let Ok(updated_at) = OffsetDateTime::parse(&generation.updated_at, &Rfc3339) else {
        return false;
    };
    let age = now_unix_seconds.saturating_sub(updated_at.unix_timestamp());
    age <= ttl_seconds as i64
}

pub fn remove_generation_artifacts(
    cache_root: impl AsRef<Path>,
    source_id: &str,
    generation_seq: u64,
) -> Result<(), std::io::Error> {
    let layout = GenerationArtifactLayout::for_generation(cache_root, source_id, generation_seq);
    if layout.generation_root.exists() {
        fs::remove_dir_all(layout.generation_root)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    use crate::model::{GenerationAvailability, GenerationRecord, GenerationStage};

    use super::{RetentionPolicy, decide_retention};

    fn generation(seq: u64, stage: GenerationStage, updated_at: &str) -> (u64, GenerationRecord) {
        (
            seq,
            GenerationRecord {
                generation_id: format!("gen_{seq:08}"),
                source_id: "src_00000001".to_owned(),
                generation_seq: seq,
                stage,
                progress_percent: 100,
                availability: GenerationAvailability {
                    preview_ready: true,
                    tile2d_ready_lods: vec![0],
                    brick3d_ready_lods: vec![0],
                },
                canonical_cache_path: None,
                preview_path: None,
                tile_manifest_path: None,
                tile_layout: None,
                brick_manifest_path: None,
                detected_at: updated_at.to_owned(),
                updated_at: updated_at.to_owned(),
            },
        )
    }

    #[test]
    fn retention_keeps_latest_recent_previous_and_pinned() {
        let generations = BTreeMap::from([
            generation(1, GenerationStage::Ready, "2026-02-28T10:00:00Z"),
            generation(2, GenerationStage::Pinned, "2026-02-28T11:00:00Z"),
            generation(3, GenerationStage::Ready, "2026-02-28T11:59:45Z"),
            generation(4, GenerationStage::Ready, "2026-02-28T12:00:00Z"),
        ]);
        let now_unix_seconds = OffsetDateTime::parse("2026-02-28T12:01:00Z", &Rfc3339)
            .expect("timestamp should parse")
            .unix_timestamp();

        let decision = decide_retention(
            &generations,
            4,
            now_unix_seconds,
            RetentionPolicy {
                previous_working_ttl_secs: 120,
            },
        );

        assert!(decision.keep_generation_seqs.contains(&4));
        assert!(decision.keep_generation_seqs.contains(&3));
        assert!(decision.keep_generation_seqs.contains(&2));
        assert_eq!(decision.gc_generation_seqs, vec![1]);
    }

    #[test]
    fn retention_drops_previous_when_ttl_elapsed() {
        let generations = BTreeMap::from([
            generation(3, GenerationStage::Ready, "2026-02-28T11:00:00Z"),
            generation(4, GenerationStage::Ready, "2026-02-28T12:00:00Z"),
        ]);
        let now_unix_seconds = OffsetDateTime::parse("2026-02-28T12:02:00Z", &Rfc3339)
            .expect("timestamp should parse")
            .unix_timestamp();

        let decision = decide_retention(
            &generations,
            4,
            now_unix_seconds,
            RetentionPolicy {
                previous_working_ttl_secs: 30,
            },
        );

        assert!(decision.keep_generation_seqs.contains(&4));
        assert_eq!(decision.gc_generation_seqs, vec![3]);
    }
}
