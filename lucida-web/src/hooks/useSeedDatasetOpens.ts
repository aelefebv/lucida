import { useEffect, useRef } from "react";

interface Params {
  /** Seed datasets for a workspace created from dataset(s). Empty when opening
   *  an existing workspace, which makes this a no-op. */
  initialDatasetUrls?: readonly string[];
  /** Must mean the session is established (open and snapshot), not that a
   *  `Bridge` exists: `send` silently drops frames before the socket is OPEN,
   *  so a premature `true` loses the seed open with no error and no retry. */
  ready: boolean;
  /** The in-viewer "Open" path, so dedup, progress, and open-failed UI apply. */
  openDataset: (url: string) => void;
}

/**
 * Open the seed datasets at most once per mount, once the transport is ready.
 * A re-render or a peer command must never re-open them. A failed open is left
 * to the open-failed UI and does not unwind the workspace, which already exists.
 */
export function useSeedDatasetOpens({
  initialDatasetUrls,
  ready,
  openDataset,
}: Params): void {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    if (!ready) return;
    if (!initialDatasetUrls || initialDatasetUrls.length === 0) return;
    // Latch only when about to send, so a deferral never consumes the one-shot.
    firedRef.current = true;
    for (const url of initialDatasetUrls) {
      openDataset(url);
    }
  }, [initialDatasetUrls, ready, openDataset]);
}
