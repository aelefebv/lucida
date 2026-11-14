import { useEffect, useState } from "react";
import { recentDatasets, type RecentDataset } from "./listingsApi.ts";

export interface RecentDatasets {
  /** Newest first. */
  recents: readonly RecentDataset[];
  /** False until the server answers, with recents or a failure. */
  answered: boolean;
}

const NONE: readonly RecentDataset[] = [];

/**
 * The caller's recent datasets, asked once per mount. A failure reads as
 * none: the field still opens a path, and the search beside it reports a
 * server that can't answer.
 */
export function useRecentDatasets(): RecentDatasets {
  const [answer, setAnswer] = useState<readonly RecentDataset[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    recentDatasets(signal).then(
      (recents) => {
        if (!signal.aborted) setAnswer(recents);
      },
      () => {
        if (!signal.aborted) setAnswer(NONE);
      },
    );
    return () => controller.abort();
  }, []);

  return { recents: answer ?? NONE, answered: answer !== null };
}
