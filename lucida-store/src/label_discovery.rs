//! Bounded label discovery for OME-Zarr images and collections.
//!
//! Discovery is deliberately separate from the main importer: it owns the
//! sampled/exhaustive policy, anomaly-triggered expansion cap, deterministic
//! probe scheduling, and the dataset-wide retained-label budget. Building a
//! label's multiscale geometry remains in `import`, after this module has
//! admitted its index entry and charged the shared budget.

use std::ops::Range;

use futures_util::stream::StreamExt;

use crate::import::METADATA_FETCH_CONCURRENCY;
use crate::import_types::{ImportWarning, ImportWarningKind};
use crate::metadata::MetadataReader;
use crate::parse;

/// Sampled discovery is worthwhile only when it avoids at least this many
/// metadata reads. Smaller collections retain exhaustive discovery.
pub(super) const LABEL_PROBE_SAMPLING_MIN_SKIPPED: usize = 64;

/// Operator override for complete per-tile label-index probing.
pub(super) const EXHAUSTIVE_LABEL_DISCOVERY_ENV: &str = "LUCIDA_EXHAUSTIVE_LABEL_DISCOVERY";

/// Bound anomaly-triggered full-group expansions. A listed label always
/// expands its group; this cap applies only to unusable indexes.
pub(super) const MAX_UNUSABLE_GROUP_EXPANSIONS: usize = 4;

pub(super) const UNUSABLE_INDEX_WARNING_EXAMPLES: usize = 3;

/// Dataset-wide ceilings prevent individually valid label indexes from
/// accumulating unbounded retained state across a large collection.
pub(super) const MAX_LABELS_PER_DATASET: usize = 1 << 16;
pub(super) const MAX_LABEL_COLORS_PER_DATASET: usize = 1 << 20;

/// Read the environment override once at the import boundary.
pub(super) fn exhaustive_label_discovery_forced() -> bool {
    std::env::var(EXHAUSTIVE_LABEL_DISCOVERY_ENV)
        .map(|value| !value.is_empty() && value != "0")
        .unwrap_or(false)
}

/// Exhaustive unless sampling saves enough reads to justify incomplete
/// discovery, or the operator explicitly requested completeness.
pub(super) fn use_exhaustive_label_probes(
    total_tiles: usize,
    sample_count: usize,
    force_exhaustive: bool,
) -> bool {
    force_exhaustive || total_tiles < sample_count.saturating_add(LABEL_PROBE_SAMPLING_MIN_SKIPPED)
}

/// First and last tile in every non-empty declared group, in group order.
pub(super) fn sample_probe_indices(group_spans: &[Range<usize>]) -> Vec<usize> {
    let mut indices = Vec::with_capacity(group_spans.len() * 2);
    for span in group_spans {
        if span.is_empty() {
            continue;
        }
        indices.push(span.start);
        if span.end - span.start > 1 {
            indices.push(span.end - 1);
        }
    }
    indices
}

/// Remaining retained-label budget shared by every image in one import.
pub(super) struct LabelBudget {
    pub(super) labels_remaining: usize,
    pub(super) colors_remaining: usize,
}

/// Import-wide admission for parsed label-index names. Each admitted name is
/// already a safe path segment of at most 255 bytes, so bounding the count also
/// bounds retained string bytes. This budget is deliberately charged before a
/// probe result is stored in a per-tile slot; completed probes waiting inside
/// the ordered concurrency buffer are the only full vectors not yet charged.
pub(super) struct ParsedLabelBudget {
    names_remaining: usize,
    dropped_names: usize,
}

impl ParsedLabelBudget {
    pub(super) fn new(max_names: usize) -> Self {
        Self {
            names_remaining: max_names,
            dropped_names: 0,
        }
    }

    fn admit(&mut self, probed: &mut ProbedLabels) {
        let retained = probed.names.len().min(self.names_remaining);
        self.names_remaining -= retained;
        self.dropped_names = self
            .dropped_names
            .saturating_add(probed.names.len().saturating_sub(retained));
        // `Vec::truncate` would drop the strings but retain each tile's original
        // high-cardinality allocation. Rebuild the admitted prefix so discarded
        // vectors release their backing storage before entering the tile table.
        let names = std::mem::take(&mut probed.names).into_vec();
        probed.names = names
            .into_iter()
            .take(retained)
            .collect::<Vec<_>>()
            .into_boxed_slice();
    }

    pub(super) fn dropped_names(&self) -> usize {
        self.dropped_names
    }
}

impl LabelBudget {
    pub(super) fn new() -> Self {
        Self::with_limits(MAX_LABELS_PER_DATASET, MAX_LABEL_COLORS_PER_DATASET)
    }

    pub(super) fn with_limits(labels_remaining: usize, colors_remaining: usize) -> Self {
        Self {
            labels_remaining,
            colors_remaining,
        }
    }
}

/// One image's labels index after the bounded metadata probe, before any
/// label multiscale is built.
#[derive(Default)]
pub(super) struct ProbedLabels {
    pub(super) names: Box<[String]>,
    pub(super) index: LabelIndexState,
}

/// What the index probe established. `Unusable` is intentionally distinct
/// from a clean absence so sampling can expand suspicious groups safely.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum LabelIndexState {
    #[default]
    Absent,
    Listed,
    Unusable,
}

/// Aggregate unusable indexes into one bounded diagnostic rather than one
/// warning per tile when a backing-store permission or throttle fails broadly.
pub(super) fn unusable_label_index_warning(
    dataset_id: &str,
    unusable: usize,
    examples: &[String],
) -> ImportWarning {
    let noun = if unusable == 1 {
        "label index"
    } else {
        "label indexes"
    };
    let examples = examples
        .iter()
        .take(UNUSABLE_INDEX_WARNING_EXAMPLES)
        .map(|prefix| format!("{prefix:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    ImportWarning {
        kind: ImportWarningKind::UnusableLabelIndex,
        target: dataset_id.to_string(),
        message: format!(
            "{unusable} {noun} could not be read or held no usable label names \
             (e.g. {examples}); label discovery may be incomplete. A store \
             permission or throttling issue may be the cause. Set \
             {EXHAUSTIVE_LABEL_DISCOVERY_ENV}=1 to probe every tile.",
        ),
    }
}

/// Probe exactly one small labels index. Per-label metadata is deliberately
/// deferred until the importer applies the shared retained-label budget.
pub(super) async fn probe_labels_for_image(
    metadata: &MetadataReader,
    base_prefix: &str,
) -> ProbedLabels {
    let labels_prefix = if base_prefix.is_empty() {
        "labels".to_string()
    } else {
        format!("{base_prefix}/labels")
    };

    let labels_json =
        match parse::read_optional_zarr_json(metadata, &format!("{labels_prefix}/zarr.json")).await
        {
            parse::OptionalZarrJson::Parsed(value) => value,
            parse::OptionalZarrJson::Absent => {
                return ProbedLabels {
                    names: Box::default(),
                    index: LabelIndexState::Absent,
                };
            }
            parse::OptionalZarrJson::Unusable => {
                return ProbedLabels {
                    names: Box::default(),
                    index: LabelIndexState::Unusable,
                };
            }
        };

    let names = parse::parse_labels_names(&labels_json);
    let index = if names.is_empty() {
        LabelIndexState::Unusable
    } else {
        LabelIndexState::Listed
    };
    ProbedLabels {
        names: names.into_boxed_slice(),
        index,
    }
}

/// Fill selected tile slots with bounded concurrency. Completion order never
/// changes retained order because each result returns to its declared index.
pub(super) async fn probe_labels_for_tiles(
    metadata: &MetadataReader,
    tile_prefixes: &[String],
    indices: Vec<usize>,
    probed_labels: &mut [Option<ProbedLabels>],
    parsed_budget: &mut ParsedLabelBudget,
) {
    // `buffered` keeps admission in declared-index order while still running a
    // bounded number of reads concurrently. `buffer_unordered` would let store
    // timing choose which tile consumes the aggregate name budget.
    let mut probe_stream = futures_util::stream::iter(indices.into_iter().map(|index| {
        let metadata = metadata.clone();
        let prefix = tile_prefixes[index].clone();
        async move {
            let probed = probe_labels_for_image(&metadata, &prefix).await;
            (index, probed)
        }
    }))
    .buffered(METADATA_FETCH_CONCURRENCY);
    while let Some((index, mut probed)) = probe_stream.next().await {
        parsed_budget.admit(&mut probed);
        probed_labels[index] = Some(probed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_keeps_small_collections_exhaustive() {
        let samples = 4;
        assert!(use_exhaustive_label_probes(
            samples + LABEL_PROBE_SAMPLING_MIN_SKIPPED - 1,
            samples,
            false,
        ));
        assert!(!use_exhaustive_label_probes(
            samples + LABEL_PROBE_SAMPLING_MIN_SKIPPED,
            samples,
            false,
        ));
        assert!(use_exhaustive_label_probes(10_000, samples, true));
    }

    #[test]
    fn sampling_is_deterministic_in_declared_group_order() {
        let spans = vec![0..1, 1..4, 4..9, 9..9];
        assert_eq!(sample_probe_indices(&spans), vec![0, 1, 3, 4, 8]);
    }

    #[test]
    fn parsed_budget_releases_rejected_vector_capacity_per_tile() {
        let mut budget = ParsedLabelBudget::new(3);
        let mut retained = Vec::new();
        for tile in 0..1_000 {
            let mut probed = ProbedLabels {
                names: (0..128)
                    .map(|name| format!("tile-{tile}-label-{name}"))
                    .collect::<Vec<_>>()
                    .into_boxed_slice(),
                index: LabelIndexState::Listed,
            };
            budget.admit(&mut probed);
            retained.push(probed);
        }

        assert_eq!(
            retained
                .iter()
                .map(|probe| probe.names.len())
                .sum::<usize>(),
            3
        );
        assert!(
            retained
                .iter()
                .map(|probe| std::mem::size_of_val(probe.names.as_ref()))
                .sum::<usize>()
                <= 3 * std::mem::size_of::<String>(),
            "rejected per-tile vectors retained their original allocations"
        );
        assert_eq!(budget.dropped_names(), 1_000 * 128 - 3);
    }
}
