import { useEffect, useRef } from "react";
import type { DatasetSeed } from "../workspaceFromDataset.ts";

interface Params {
  /** Seed datasets for a workspace created from dataset(s). Absent when
   *  opening an existing workspace, which makes this a no-op. */
  seed?: DatasetSeed;
  /** Must mean the session is established (open and snapshot), not that a
   *  `Bridge` exists: `send` silently drops frames before the socket is OPEN,
   *  so a premature `true` loses the seed open with no error and no retry. */
  ready: boolean;
  /** The in-viewer "Open" path, so dedup, progress, and open-failed UI apply.
   *  `view` names the view the dataset lands in; null lands it as any open. */
  openDataset: (url: string, view: number | null) => void;
  /** Divide the canvas so `count` datasets get a view each, every view
   *  showing nothing yet, and return the views in order. */
  viewsForEach: (count: number) => readonly number[];
}

/**
 * Open the seed datasets at most once per mount, once the transport is ready.
 * A re-render or a peer command must never re-open them. A failed open is left
 * to the open-failed UI and does not unwind the workspace, which already exists.
 */
export function useSeedDatasetOpens({
  seed,
  ready,
  openDataset,
  viewsForEach,
}: Params): void {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    if (!ready) return;
    if (!seed || seed.urls.length === 0) return;
    // Latch only when about to send, so a deferral never consumes the one-shot.
    firedRef.current = true;
    const views = seed.sideBySide && seed.urls.length > 1 ? viewsForEach(seed.urls.length) : [];
    seed.urls.forEach((url, at) => openDataset(url, views[at] ?? null));
  }, [seed, ready, openDataset, viewsForEach]);
}
