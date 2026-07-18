/**
 * Per-browser "viewed" state for the "mentions of me" inbox (issue #803).
 *
 * Slice 2 gave every viewer a badge + panel of the CURRENT dataset's comments
 * that @-mention them. This turns that into an unread/read inbox: a mention is
 * "viewed" once you click its panel item (which already navigates to the pin),
 * the badge counts only UNVIEWED mentions, and the panel can hide viewed ones.
 *
 * WHY localStorage (not the wire): "I have read this" is PERSONAL, per-browser
 * state — it must not flow to peers, change the document, or touch Rust. So it
 * mirrors {@link annotationIdentity}'s localStorage pattern exactly: every
 * storage access is guarded so a missing/throwing `localStorage` (SSR, private
 * browsing, quota) degrades to "treat everything as unviewed" and NEVER throws
 * out of the toolbar.
 *
 * WHY keyed by dataset: comment ids are only unique within a document/dataset,
 * and "viewed" is a per-dataset inbox. Keying the stored set by the selected
 * dataset id means switching datasets shows that dataset's own read-state, and
 * one dataset's reads never bleed into another's count. A null scope is kept in
 * memory only: persistence begins only once the host resolves the annotation's
 * real dataset, so placeholder state can never leak across datasets.
 *
 * The hook owns the Set; {@link MentionsOfMe} stays PURE and receives the id
 * list + a `markViewed` callback as props.
 */
import { useCallback, useMemo, useState } from "react";

/** Prefix for the per-dataset localStorage key. The exact string is part of the
 * contract: a returning browser reuses whatever is stored under it, so this
 * prefix must stay stable across releases. The dataset id is appended to scope
 * the set so reads never bleed across datasets. */
export const VIEWED_MENTIONS_KEY_PREFIX = "lucida.mentions.viewed.";

/** The full storage key for a given dataset selection. */
function storageKey(datasetId: string): string {
  return `${VIEWED_MENTIONS_KEY_PREFIX}${datasetId}`;
}

/** Read the persisted viewed-id set for `datasetId`, or an empty set when
 * absent/empty/malformed/unavailable. Never throws: a broken storage simply
 * means "nothing viewed yet" (degrade to all-unviewed). */
function readViewed(datasetId: string | null): Set<string> {
  if (datasetId === null) return new Set();
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(storageKey(datasetId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    // Tolerate anything that isn't the expected string[] (older/foreign data):
    // keep only string entries rather than trusting the blob wholesale.
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** Persist `ids` for `datasetId`. Swallows failures (quota / private browsing):
 * an in-memory set that doesn't survive a reload still beats throwing out of the
 * toolbar. Stored as a JSON string[] so it round-trips through {@link readViewed}. */
function writeViewed(datasetId: string | null, ids: Set<string>): void {
  if (datasetId === null) return;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(datasetId), JSON.stringify([...ids]));
  } catch {
    // ignore — the in-memory state keeps the session consistent regardless.
  }
}

/**
 * Owns the per-browser, per-dataset set of viewed mention comment ids.
 *
 * Contract:
 *  - `viewedCommentIds` is the current dataset's viewed ids (stable array
 *    reference until the set changes), ready to pass straight to
 *    {@link MentionsOfMe}'s `viewedCommentIds` prop;
 *  - `markViewed(id)` adds `id` to the set AND persists it (idempotent — marking
 *    an already-viewed id is a no-op and does not churn storage or state);
 *  - switching `selectedDatasetId` swaps in that dataset's own persisted set, so
 *    read-state is scoped per dataset and never bleeds across them.
 *
 * Fail-safe throughout: if storage is unavailable the set lives only in memory
 * (still correct for the session), and nothing here ever throws.
 */
export function useViewedMentions(selectedDatasetId: string | null): {
  viewedCommentIds: string[];
  markViewed: (commentId: string) => void;
} {
  // The viewed set for the CURRENT dataset, seeded from storage.
  const [viewed, setViewed] = useState<Set<string>>(() => readViewed(selectedDatasetId));

  // Re-seed when the dataset changes using React's "adjust state during render"
  // pattern (https://react.dev/learn/you-might-not-need-an-effect) instead of a
  // setState-in-an-effect: the strict react-hooks lint (set-state-in-effect)
  // rejects the effect form, and the render-time form also avoids an extra
  // effect-driven re-render. When `selectedDatasetId` differs from the dataset we
  // last seeded from, swap in that dataset's persisted set during render, so
  // read-state never bleeds across datasets.
  const [seededDataset, setSeededDataset] = useState(selectedDatasetId);
  if (seededDataset !== selectedDatasetId) {
    setSeededDataset(selectedDatasetId);
    setViewed(readViewed(selectedDatasetId));
  }

  const markViewed = useCallback(
    (commentId: string) => {
      setViewed((prev) => {
        // Idempotent: already viewed → return the SAME set so React skips the
        // re-render and we don't rewrite identical storage.
        if (prev.has(commentId)) return prev;
        const next = new Set(prev);
        next.add(commentId);
        // Persist under the currently-selected dataset's key.
        writeViewed(selectedDatasetId, next);
        return next;
      });
    },
    [selectedDatasetId],
  );

  // A stable array view of the set for the pure child; recomputed only when the
  // set identity changes.
  const viewedCommentIds = useMemo(() => [...viewed], [viewed]);

  return { viewedCommentIds, markViewed };
}
