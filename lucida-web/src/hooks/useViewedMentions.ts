/**
 * Per-browser "viewed" state for the "mentions of me" inbox. A mention is viewed
 * once its panel item is clicked; the badge counts only unviewed ones.
 *
 * Read state is personal, so it is a preference, not on the wire. The ids are
 * kept per dataset because comment ids are only unique within one.
 */
import { useCallback, useMemo } from "react";
import {
  definePreference,
  getPreference,
  migrateLegacyKeys,
  setPreference,
  usePreference,
} from "../theme/preferences.ts";

/** The inbox still shows mentions with no dataset selected, so that state needs
 * its own entry rather than sharing a real dataset's. */
const NO_DATASET_SENTINEL = "__none__";

type ViewedByDataset = Readonly<Record<string, readonly string[]>>;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined;
}

/** Viewed comment ids by dataset id. Keeps only string ids rather than trusting a foreign blob. */
export const viewedMentionsPreference = definePreference<ViewedByDataset>("mentions.viewed", {}, (raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const viewed: Record<string, string[]> = {};
  for (const [datasetId, ids] of Object.entries(raw)) {
    const kept = strings(ids);
    if (kept) viewed[datasetId] = kept;
  }
  return viewed;
});

const LEGACY_KEY_PREFIX = "lucida.mentions.viewed.";

migrateLegacyKeys(
  (key) => key.startsWith(LEGACY_KEY_PREFIX),
  (old) => {
    const viewed: Record<string, readonly string[]> = { ...getPreference(viewedMentionsPreference) };
    for (const [key, raw] of old) {
      let ids: string[] | undefined;
      try {
        ids = strings(JSON.parse(raw));
      } catch {
        continue;
      }
      if (ids) viewed[key.slice(LEGACY_KEY_PREFIX.length)] = ids;
    }
    setPreference(viewedMentionsPreference, viewed);
  },
);

/**
 * The selected dataset's viewed mention ids, and a `markViewed` that adds and
 * persists one. Switching datasets swaps in that dataset's own set.
 */
export function useViewedMentions(selectedDatasetId: string | null): {
  viewedCommentIds: string[];
  markViewed: (commentId: string) => void;
} {
  const [viewed] = usePreference(viewedMentionsPreference);
  const key = selectedDatasetId ?? NO_DATASET_SENTINEL;
  const ids = viewed[key];

  const markViewed = useCallback(
    (commentId: string) => {
      const current = getPreference(viewedMentionsPreference);
      const known = current[key] ?? [];
      if (known.includes(commentId)) return;
      setPreference(viewedMentionsPreference, { ...current, [key]: [...known, commentId] });
    },
    [key],
  );

  const viewedCommentIds = useMemo(() => [...(ids ?? [])], [ids]);

  return { viewedCommentIds, markViewed };
}
