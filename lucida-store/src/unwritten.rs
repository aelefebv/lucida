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
//! does instead is a **relative** test that costs one HEAD per level, issued
//! concurrently so the whole check is a single round trip:
//!
//! 1. probe the origin chunk (`.../c/0/0/…`) of every declared level, then
//! 2. call a level unwritten only when its origin is absent **while at least
//!    one sibling level's origin is present**.
//!
//! Step 2 is what makes one probe trustworthy. Levels cover the same extent,
//! so genuinely sparse data is sparse at the same spatial origin on every
//! level; a level bare while its sibling is populated is an export that
//! stopped early. A dataset with no chunks at any origin — including every
//! metadata-only fixture in this repo's own tests — stays silent, because
//! absence everywhere is not evidence of a partial write.

use std::sync::Arc;

use futures_util::future::join_all;
use object_store::path::Path;

use crate::cache::CachedStore;
use crate::import_types::{ImportWarning, ImportWarningKind};
use crate::parse::LevelEntry;

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
/// cannot change the answer and no chunk shape is needed here.
pub(crate) fn origin_chunk_path(base_prefix: &str, level_path: &str, axis_count: usize) -> String {
    let coords = vec!["0"; axis_count].join("/");
    if base_prefix.is_empty() {
        format!("{level_path}/c/{coords}")
    } else {
        format!("{base_prefix}/{level_path}/c/{coords}")
    }
}

/// Probe every level's origin chunk concurrently — N requests, one round trip.
pub(crate) async fn probe_level_origins(
    store: &Arc<CachedStore>,
    base_prefix: &str,
    level_entries: &[LevelEntry],
    axis_count: usize,
) -> Vec<OriginChunk> {
    let probes = level_entries.iter().map(|entry| {
        let path = Path::from(origin_chunk_path(base_prefix, &entry.path, axis_count));
        let store = Arc::clone(store);
        async move {
            match store.probe_exists(&path).await {
                Ok(true) => OriginChunk::Present,
                Ok(false) => OriginChunk::Absent,
                Err(_) => OriginChunk::Unknown,
            }
        }
    });
    join_all(probes).await
}

/// The indices of levels that look unwritten: origin absent while a sibling's
/// origin is present. Empty when no level's origin was found, so a store we
/// could not read from — and a dataset that is simply sparse at the origin
/// everywhere — accuses nothing.
pub(crate) fn unwritten_level_indices(probes: &[OriginChunk]) -> Vec<usize> {
    if !probes.contains(&OriginChunk::Present) {
        return Vec::new();
    }
    probes
        .iter()
        .enumerate()
        .filter(|(_, p)| **p == OriginChunk::Absent)
        .map(|(index, _)| index)
        .collect()
}

/// One aggregated warning naming every level that looks unwritten.
///
/// Aggregated rather than one-per-level for the same reason
/// [`ImportWarningKind::UnreadableTileGeometry`] is: whatever stopped an
/// export short usually leaves several levels bare at once, and a warning per
/// level would bury the open trail.
pub(crate) fn unwritten_levels_warning(
    target: &str,
    level_entries: &[LevelEntry],
    indices: &[usize],
) -> Option<ImportWarning> {
    if indices.is_empty() {
        return None;
    }
    let named: Vec<String> = indices
        .iter()
        .map(|index| match level_entries.get(*index) {
            Some(entry) if entry.path != index.to_string() => {
                format!("{index} ({})", entry.path)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(paths: &[&str]) -> Vec<LevelEntry> {
        paths
            .iter()
            .map(|p| LevelEntry {
                path: (*p).to_string(),
                scale: [1.0; 5],
            })
            .collect()
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

    #[test]
    fn a_bare_level_beside_a_populated_one_is_unwritten() {
        // Issue #904's dataset: level 0 declared with zero chunks, level 1 full.
        let probes = [OriginChunk::Absent, OriginChunk::Present];
        assert_eq!(unwritten_level_indices(&probes), vec![0]);
    }

    #[test]
    fn no_origin_anywhere_accuses_nothing() {
        // Sparse at the origin on every level, or a metadata-only fixture.
        let probes = [OriginChunk::Absent, OriginChunk::Absent];
        assert!(unwritten_level_indices(&probes).is_empty());
    }

    #[test]
    fn a_fully_populated_pyramid_is_quiet() {
        let probes = [OriginChunk::Present, OriginChunk::Present];
        assert!(unwritten_level_indices(&probes).is_empty());
    }

    #[test]
    fn an_unreadable_probe_is_neither_accused_nor_clearing() {
        let probes = [OriginChunk::Unknown, OriginChunk::Present];
        assert!(unwritten_level_indices(&probes).is_empty());

        // Unknown alone cannot license an accusation against a bare sibling.
        let probes = [OriginChunk::Absent, OriginChunk::Unknown];
        assert!(unwritten_level_indices(&probes).is_empty());
    }

    #[test]
    fn warning_names_every_bare_level_in_one_message() {
        let entries = entries(&["0", "1", "2"]);
        let warning = unwritten_levels_warning("ds", &entries, &[0, 1]).unwrap();
        assert_eq!(warning.kind, ImportWarningKind::UnwrittenLevel);
        assert_eq!(warning.target, "ds");
        assert!(warning.message.contains("levels 0, 1 have no chunks"));
    }

    #[test]
    fn warning_names_a_non_numeric_level_path_alongside_its_index() {
        let entries = entries(&["full", "half"]);
        let warning = unwritten_levels_warning("ds", &entries, &[0]).unwrap();
        assert!(warning.message.contains("level 0 (full) has no chunks"));
    }

    #[test]
    fn no_bare_levels_yields_no_warning() {
        let entries = entries(&["0", "1"]);
        assert!(unwritten_levels_warning("ds", &entries, &[]).is_none());
    }
}
