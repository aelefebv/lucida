//! Detect pyramid levels that are declared but have no chunks written.
//!
//! A Zarr level whose chunks were never written is legal: a missing chunk
//! reads as `fill_value`, so the level is fully declared and entirely empty.
//! The viewer then serves a correct-by-spec, all-zero level and the screen
//! goes black with nothing said about it — a partially-written export read as
//! genuinely dark data. Nothing rendered is wrong, but the reading a user
//! takes from it is, which is the failure `intention.md` names.
//!
//! Proving a level is empty would mean listing its whole chunk prefix, which
//! is far too many requests on the remote-first open path. What this module
//! does instead is a **relative** test that costs one small request per
//! level, issued concurrently so the whole check is a single round trip:
//!
//! 1. probe the origin chunk (`.../c/0/0/…`) of every declared level, then
//! 2. call a level unwritten only when its origin is absent **while some
//!    sibling level whose origin chunk covers a smaller-or-equal patch of
//!    source space has its origin present**.
//!
//! On an unsharded level the probe is a HEAD of the origin chunk's object.
//! On a sharded level that object is the origin shard, and a shard can be
//! there while the origin inner chunk inside it was never written. The probe
//! reads the shard's index instead and asks it about the origin inner
//! chunk. Stopping at the shard object would err both ways: a shard written
//! everywhere but its first inner chunk would clear the level, and it would
//! stand as a witness against a coarser level whose origin patch its data
//! never reached. Either probe is a metadata read, because the question is
//! about the dataset's shape and is asked while the open is resolving it.
//!
//! Step 2's footprint condition is what makes one probe trustworthy. Every
//! level's origin chunk starts at the same corner, but they do not span the
//! same amount of source space: a level with 2048-wide chunks covers 2048
//! source pixels at its origin, while a half-scale level with 256-wide chunks
//! covers only 512. So a *bigger* origin chunk missing while a *smaller* one
//! inside it holds data is a contradiction — the data proven to exist in the
//! smaller patch must also lie in the bigger one, and only an export that
//! stopped early explains its absence. The reverse tells us nothing: a
//! sparse dataset whose first signal falls outside the smaller patch is
//! legitimately missing that chunk, and accusing it would fire on healthy
//! data.
//!
//! A dataset with no chunk at any origin — including every metadata-only
//! fixture in this repo's own tests — stays silent for the same reason:
//! absence everywhere is not evidence of a partial write.

use std::sync::Arc;

use futures_util::future::join_all;
use object_store::path::Path;

use crate::cache::CachedStore;
use crate::import_types::{ImportWarning, ImportWarningKind};
use crate::shard::{self, ShardLayout};

/// What the probe needs to know about one declared level.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProbeTarget {
    /// The level's store path segment, from its multiscale `datasets` entry.
    /// Usually the level index as a string, but the format does not require it.
    pub path: String,
    /// How many coordinates an on-disk chunk key for this level carries — one
    /// per axis of the level's own array, which is what the key is built from.
    pub axis_count: usize,
    /// How much source space this level's origin chunk spans, per canonical
    /// axis: the chunk's extent in voxels scaled into the shared coordinate
    /// space all levels are expressed in. On a sharded level the chunk is
    /// the inner chunk, which is what the probe asks about.
    pub origin_footprint: [f64; 5],
    /// How this level packs chunks into shards, or `None` when each chunk is
    /// an object of its own.
    pub shard: Option<ShardLayout>,
}

/// Whether a level's origin chunk is there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OriginChunk {
    Present,
    Absent,
    /// The probe failed short of a clean not-found — a throttled store, or a
    /// permission configuration that answers a missing key with an error. The
    /// level is neither accused nor cleared.
    Unknown,
}

/// The store path of a level's origin chunk: one `0` per on-disk axis, under
/// the Zarr v3 `c/` chunk prefix. Every coordinate is zero, so the wire's
/// voxel-vs-grid distinction for `t`/`c` (see [`crate::chunk_key_to_store_path`])
/// cannot change the answer and no chunk shape is needed here. On a sharded
/// level the same path names the origin shard, the one that holds the
/// origin inner chunk at its first index position.
fn origin_chunk_path(base_prefix: &str, level_path: &str, axis_count: usize) -> String {
    let coords = vec!["0"; axis_count].join("/");
    if base_prefix.is_empty() {
        format!("{level_path}/c/{coords}")
    } else {
        format!("{base_prefix}/{level_path}/c/{coords}")
    }
}

/// Probe every level's origin chunk concurrently — N requests, one round trip.
/// An unsharded level is a HEAD of the origin chunk; a sharded level is a
/// read of the origin shard's index, for the reasons in the module doc.
async fn probe_level_origins(
    store: &Arc<CachedStore>,
    base_prefix: &str,
    targets: &[ProbeTarget],
) -> Vec<OriginChunk> {
    let probes = targets.iter().map(|target| {
        let path = Path::from(origin_chunk_path(
            base_prefix,
            &target.path,
            target.axis_count,
        ));
        let store = Arc::clone(store);
        let shard = target.shard.as_ref();
        async move {
            let written = match shard {
                None => store.probe_exists(&path).await,
                Some(layout) => shard::inner_chunk_written(&store, layout, &path, 0).await,
            };
            match written {
                Ok(true) => OriginChunk::Present,
                Ok(false) => OriginChunk::Absent,
                Err(_) => OriginChunk::Unknown,
            }
        }
    });
    join_all(probes).await
}

/// Whether `outer`'s origin chunk spans at least as much source space as
/// `inner`'s on every axis — i.e. whatever `inner`'s origin chunk holds must
/// also lie inside `outer`'s.
///
/// Compared with a relative tolerance because the scales come from the store
/// as floats and a level written at exactly 2× can arrive as `1.9999999`.
fn covers(outer: &[f64; 5], inner: &[f64; 5]) -> bool {
    outer
        .iter()
        .zip(inner.iter())
        .all(|(o, i)| *o >= *i - i.abs() * 1e-9)
}

/// The indices of levels that look unwritten: origin absent while some level
/// whose origin chunk it contains has data.
pub(crate) fn unwritten_level_indices(
    targets: &[ProbeTarget],
    probes: &[OriginChunk],
) -> Vec<usize> {
    let present: Vec<&ProbeTarget> = targets
        .iter()
        .zip(probes.iter())
        .filter(|(_, probe)| **probe == OriginChunk::Present)
        .map(|(target, _)| target)
        .collect();
    if present.is_empty() {
        return Vec::new();
    }
    targets
        .iter()
        .zip(probes.iter())
        .enumerate()
        .filter(|(_, (target, probe))| {
            **probe == OriginChunk::Absent
                && present
                    .iter()
                    .any(|witness| covers(&target.origin_footprint, &witness.origin_footprint))
        })
        .map(|(index, _)| index)
        .collect()
}

/// One aggregated warning naming every level that looks unwritten.
///
/// Aggregated rather than one-per-level for the same reason
/// [`ImportWarningKind::UnreadableTileGeometry`] is: whatever stopped an
/// export short usually leaves several levels bare at once, and a warning per
/// level would bury the open trail.
fn unwritten_levels_warning(
    target: &str,
    targets: &[ProbeTarget],
    indices: &[usize],
) -> Option<ImportWarning> {
    if indices.is_empty() {
        return None;
    }
    let named: Vec<String> = indices
        .iter()
        .map(|index| match targets.get(*index) {
            Some(level) if level.path != index.to_string() => {
                format!("{index} ({})", level.path)
            }
            _ => index.to_string(),
        })
        .collect();
    let (subject, verb) = if named.len() == 1 {
        ("level", "has")
    } else {
        ("levels", "have")
    };
    Some(ImportWarning {
        kind: ImportWarningKind::UnwrittenLevel,
        target: target.to_string(),
        message: format!(
            "{target}: {subject} {} {verb} no chunks written — the source declares the {subject} \
             but its data was never exported, so it reads as fill and renders as an empty, \
             all-zero image. Coarser levels of this dataset do have data. View a level that was \
             written, or re-export the source.",
            named.join(", "),
        ),
    })
}

/// Probe one multiscale geometry's declared levels and describe any that were
/// never written. The whole check is one round trip and one warning.
pub(crate) async fn warn_unwritten_levels(
    store: &Arc<CachedStore>,
    base_prefix: &str,
    target: &str,
    targets: &[ProbeTarget],
) -> Option<ImportWarning> {
    let probes = probe_level_origins(store, base_prefix, targets).await;
    let indices = unwritten_level_indices(targets, &probes);
    unwritten_levels_warning(target, targets, &indices)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A level whose origin chunk spans `edge` source units on y and x.
    fn target(path: &str, axis_count: usize, edge: f64) -> ProbeTarget {
        ProbeTarget {
            path: path.to_string(),
            axis_count,
            origin_footprint: [1.0, 1.0, 1.0, edge, edge],
            shard: None,
        }
    }

    #[test]
    fn origin_path_emits_one_zero_per_on_disk_axis() {
        // The real fixture behind issue #904: 7 axes (m, p, t, z, c, y, x).
        assert_eq!(origin_chunk_path("", "1", 7), "1/c/0/0/0/0/0/0/0");
        assert_eq!(origin_chunk_path("", "0", 5), "0/c/0/0/0/0/0");
    }

    #[test]
    fn origin_path_is_scoped_by_the_collection_tile_prefix() {
        assert_eq!(origin_chunk_path("A/1/0", "2", 3), "A/1/0/2/c/0/0/0");
    }

    /// Issue #904's dataset to scale: level 0 declared with 2048-wide chunks
    /// and no data, level 1 written with 256-wide chunks at 2× (512 source
    /// units). Level 0's origin chunk contains level 1's, so level 1 holding
    /// data proves level 0 should have some.
    #[test]
    fn a_bare_level_containing_a_populated_one_is_unwritten() {
        let targets = [target("0", 7, 2048.0), target("1", 7, 512.0)];
        let probes = [OriginChunk::Absent, OriginChunk::Present];
        assert_eq!(unwritten_level_indices(&targets, &probes), vec![0]);
    }

    /// The converse proves nothing. A level whose origin chunk covers only a
    /// small patch can legitimately have no data there while a coarser level's
    /// much larger origin chunk catches signal further out — ordinary sparse
    /// data, not a partial write.
    #[test]
    fn a_bare_level_inside_a_populated_one_is_not_accused() {
        let targets = [target("0", 7, 2048.0), target("1", 7, 512.0)];
        let probes = [OriginChunk::Present, OriginChunk::Absent];
        assert!(unwritten_level_indices(&targets, &probes).is_empty());
    }

    /// Equal footprints still contradict each other, which is the common
    /// pyramid shape: chunk size held constant while the scale doubles.
    #[test]
    fn equal_footprints_still_accuse() {
        let targets = [target("0", 5, 256.0), target("1", 5, 256.0)];
        let probes = [OriginChunk::Absent, OriginChunk::Present];
        assert_eq!(unwritten_level_indices(&targets, &probes), vec![0]);
    }

    /// Scales arrive from the store as floats; a level written at exactly 2×
    /// must not escape on a rounding wobble.
    #[test]
    fn a_float_wobble_in_the_scale_does_not_hide_a_bare_level() {
        let targets = [target("0", 5, 511.99999999), target("1", 5, 512.0)];
        let probes = [OriginChunk::Absent, OriginChunk::Present];
        assert_eq!(unwritten_level_indices(&targets, &probes), vec![0]);
    }

    #[test]
    fn no_origin_anywhere_accuses_nothing() {
        // Sparse at the origin on every level, or a metadata-only fixture.
        let targets = [target("0", 5, 2048.0), target("1", 5, 512.0)];
        let probes = [OriginChunk::Absent, OriginChunk::Absent];
        assert!(unwritten_level_indices(&targets, &probes).is_empty());
    }

    #[test]
    fn a_fully_populated_pyramid_is_quiet() {
        let targets = [target("0", 5, 2048.0), target("1", 5, 512.0)];
        let probes = [OriginChunk::Present, OriginChunk::Present];
        assert!(unwritten_level_indices(&targets, &probes).is_empty());
    }

    #[test]
    fn an_unreadable_probe_is_neither_accused_nor_clearing() {
        let targets = [target("0", 5, 2048.0), target("1", 5, 512.0)];
        assert!(
            unwritten_level_indices(&targets, &[OriginChunk::Unknown, OriginChunk::Present])
                .is_empty()
        );
        // Unknown alone cannot license an accusation against a bare sibling.
        assert!(
            unwritten_level_indices(&targets, &[OriginChunk::Absent, OriginChunk::Unknown])
                .is_empty()
        );
    }

    /// A single-level pyramid has no witness, so it is never accused.
    #[test]
    fn a_lone_level_is_never_accused() {
        let targets = [target("0", 5, 2048.0)];
        assert!(unwritten_level_indices(&targets, &[OriginChunk::Absent]).is_empty());
    }

    #[test]
    fn warning_names_every_bare_level_in_one_message() {
        let targets = [
            target("0", 5, 2048.0),
            target("1", 5, 1024.0),
            target("2", 5, 512.0),
        ];
        let warning = unwritten_levels_warning("ds", &targets, &[0, 1]).unwrap();
        assert_eq!(warning.kind, ImportWarningKind::UnwrittenLevel);
        assert_eq!(warning.target, "ds");
        assert!(warning.message.contains("levels 0, 1 have no chunks"));
    }

    #[test]
    fn warning_names_a_non_numeric_level_path_alongside_its_index() {
        let targets = [target("full", 5, 2048.0), target("half", 5, 1024.0)];
        let warning = unwritten_levels_warning("ds", &targets, &[0]).unwrap();
        assert!(warning.message.contains("level 0 (full) has no chunks"));
    }

    #[test]
    fn no_bare_levels_yields_no_warning() {
        let targets = [target("0", 5, 2048.0)];
        assert!(unwritten_levels_warning("ds", &targets, &[]).is_none());
    }
}
