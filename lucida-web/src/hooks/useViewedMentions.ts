/**
 * Per-browser "viewed" state for the "mentions of me" inbox. A mention is viewed
 * once its panel item is clicked; the badge counts only unviewed ones.
 *
 * Read state is personal, so it lives in localStorage, not on the wire. Every
 * storage access is guarded: missing or throwing storage degrades to "nothing
 * viewed" and never throws out of the toolbar. The set is keyed by dataset
 * because comment ids are only unique within one.
 */
import { useCallback, useMemo, useState } from "react";

/** Must stay stable across releases: a returning browser reads whatever is
 * stored under it. The dataset id is appended. */
export const VIEWED_MENTIONS_KEY_PREFIX = "lucida.mentions.viewed.";

/** The inbox still shows mentions with no dataset selected, so that state needs
 * its own key rather than sharing a real dataset's. */
const NO_DATASET_SENTINEL = "__none__";

function storageKey(datasetId: string | null): string {
  return `${VIEWED_MENTIONS_KEY_PREFIX}${datasetId ?? NO_DATASET_SENTINEL}`;
}

/** The persisted viewed ids for `datasetId`, or an empty set when absent,
 * malformed, or unavailable. Never throws. */
function readViewed(datasetId: string | null): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(storageKey(datasetId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    // Keep only string entries rather than trusting a foreign blob.
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** Persist `ids` for `datasetId`. Swallows quota and private-browsing failures:
 * an in-memory set that doesn't survive a reload beats throwing. */
function writeViewed(datasetId: string | null, ids: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(datasetId), JSON.stringify([...ids]));
  } catch {
    // The in-memory state keeps the session consistent.
  }
}

/**
 * The selected dataset's viewed mention ids, and a `markViewed` that adds and
 * persists one. Switching datasets swaps in that dataset's own set.
 */
export function useViewedMentions(selectedDatasetId: string | null): {
  viewedCommentIds: string[];
  markViewed: (commentId: string) => void;
} {
  const [viewed, setViewed] = useState<Set<string>>(() => readViewed(selectedDatasetId));

  // Re-seed during render, not in an effect: the react-hooks lint rejects
  // setState in an effect, and this skips an extra re-render.
  // https://react.dev/learn/you-might-not-need-an-effect
  const [seededDataset, setSeededDataset] = useState(selectedDatasetId);
  if (seededDataset !== selectedDatasetId) {
    setSeededDataset(selectedDatasetId);
    setViewed(readViewed(selectedDatasetId));
  }

  const markViewed = useCallback(
    (commentId: string) => {
      setViewed((prev) => {
        // Return the same set so React skips the re-render and storage isn't
        // rewritten.
        if (prev.has(commentId)) return prev;
        const next = new Set(prev);
        next.add(commentId);
        writeViewed(selectedDatasetId, next);
        return next;
      });
    },
    [selectedDatasetId],
  );

  const viewedCommentIds = useMemo(() => [...viewed], [viewed]);

  return { viewedCommentIds, markViewed };
}
