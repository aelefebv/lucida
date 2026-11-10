/**
 * Dataset health in words for people. The server's messages are written for
 * developers and agents, naming bindings, caches, settings and store paths,
 * so they stay in the health the trace records, and each reason here is
 * worded from its kind or its numbers.
 */
import type { DatasetImportWarning, DatasetImportWarningKind, DatasetSourceHealth } from "../bridge.ts";

export interface HealthReason {
  text: string;
  /** The data shows wrong, or not at all. */
  degrades: boolean;
}

/** Every reason health gives that the dataset may not show as stored. */
export function healthReasons(health: DatasetSourceHealth): HealthReason[] {
  const reasons: HealthReason[] = [];
  if (health.binding.status !== "healthy") {
    reasons.push({ text: "The server can't read this dataset right now, so none of it can be shown.", degrades: true });
  }
  // Absent reads are no reason: a chunk never written draws its fill, which
  // is the dataset as stored.
  const failedReads = health.source_cache?.backend_errors ?? 0;
  if (failedReads > 0) {
    const reads = failedReads === 1 ? "read" : "reads";
    reasons.push({
      text: `${failedReads.toLocaleString()} ${reads} from the source failed, so parts of the dataset may be missing.`,
      degrades: true,
    });
  }
  if (health.generated_coarse.status !== "healthy") {
    reasons.push({
      text: "The server couldn't build some zoomed-out levels, so the dataset may show gaps when zoomed out.",
      degrades: true,
    });
  }
  for (const warning of health.import_warnings ?? []) {
    reasons.push({ text: importWarningText(warning), degrades: warning.degrades });
  }
  return reasons;
}

const IMPORT_WARNING_TEXT: Record<DatasetImportWarningKind, (warning: DatasetImportWarning) => string> = {
  skipped_group: ({ target }) => `Cell ${target} was left out because it couldn't be read.`,
  unreadable_tile_geometry: () =>
    "Some tiles couldn't be read when the collection opened, so its layout comes from another tile.",
  unusable_tile_geometry: () =>
    "Some tiles are stored differently from the rest but are read as if stored alike, so they may show wrong.",
  sampled_label_discovery: () => "Only some tiles were checked for labels, so labels on the rest may not be listed.",
  unusable_label_index: () => "Some label lists couldn't be read, so some labels may not be listed.",
  unwritten_level: () =>
    "Some resolution levels were never written, so they draw all zero. Coarser levels do have data.",
  // The importer words these for people and names the tiles they reach.
  mismatched_tile_geometry: importerMessage,
  duplicate_tile: importerMessage,
  malformed_collection_layout: importerMessage,
  pinned_axis: () => "The dataset has more axes than the viewer shows, so only one slice of each extra axis is visible.",
  invalid_scale: () => "The collection gives no usable pixel size, so tiles may be placed wrong.",
};

/** One import warning as a person reads it. */
export function importWarningText(warning: DatasetImportWarning): string {
  // A server of another version can send a kind this page has no words for.
  const words = IMPORT_WARNING_TEXT[warning.kind] as ((warning: DatasetImportWarning) => string) | undefined;
  return words ? words(warning) : importerMessage(warning);
}

function importerMessage({ message }: DatasetImportWarning): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}
