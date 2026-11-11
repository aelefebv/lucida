import { useCallback, useEffect, useState } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import { sameDatasetLevels, type DatasetLevels, type LevelsByView } from "../pipeline/datasetLevels.ts";

/**
 * The per-dataset level readout the render worker reports, for each view that
 * draws the dataset: the target level and the level actually on screen. The
 * client summarises every report as it arrives, so the map only changes
 * identity when a summary changes; React skips the re-render otherwise. The
 * worker reports a view's draw empty when it drops it. `forget` drops a
 * removed dataset, which the worker stops reporting rather than reports as
 * empty.
 */
export function useDatasetLevels({
  clientReady,
  clientRef,
}: {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
}): { levels: Map<string, LevelsByView>; forget: (datasetId: string) => void } {
  const [levels, setLevels] = useState<Map<string, LevelsByView>>(new Map());

  useEffect(() => {
    const client = clientRef.current;
    if (!clientReady || !client) return;
    client.onEntityLevels = (datasetId, view, next) => {
      setLevels((prev) => withLevels(prev, datasetId, view, next));
    };
    return () => {
      client.onEntityLevels = null;
    };
  }, [clientReady, clientRef]);

  const forget = useCallback((datasetId: string) => {
    setLevels((prev) => {
      if (!prev.has(datasetId)) return prev;
      const updated = new Map(prev);
      updated.delete(datasetId);
      return updated;
    });
  }, []);

  return { levels, forget };
}

/** `levels` with `datasetId`'s readout for `view` replaced, or itself when nothing changed. */
export function withLevels(
  levels: Map<string, LevelsByView>,
  datasetId: string,
  view: number,
  next: DatasetLevels | null,
): Map<string, LevelsByView> {
  const held = levels.get(datasetId);
  if (sameDatasetLevels(held?.get(view) ?? null, next)) return levels;
  const byView = new Map(held);
  if (next === null) byView.delete(view);
  else byView.set(view, next);
  const updated = new Map(levels);
  if (byView.size === 0) updated.delete(datasetId);
  else updated.set(datasetId, byView);
  return updated;
}
