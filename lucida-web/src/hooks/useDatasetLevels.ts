import { useCallback, useEffect, useState } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { PoolMode } from "../renderer/workerProtocol.ts";
import { sameDatasetLevels, type DatasetLevels, type LevelsByMode } from "../pipeline/datasetLevels.ts";

/**
 * The per-dataset level readout the render worker reports, for the dataset's
 * pools of each mode: the target level and the level actually on screen. The
 * client summarises every report as it arrives, so the map only changes
 * identity when a summary changes; React skips the re-render otherwise. The
 * worker reports a mode's pools empty when it frees them. `forget` drops a
 * removed dataset, which the worker stops reporting rather than reports as
 * empty.
 */
export function useDatasetLevels({
  clientReady,
  clientRef,
}: {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
}): { levels: Map<string, LevelsByMode>; forget: (datasetId: string) => void } {
  const [levels, setLevels] = useState<Map<string, LevelsByMode>>(new Map());

  useEffect(() => {
    const client = clientRef.current;
    if (!clientReady || !client) return;
    client.onEntityLevels = (datasetId, mode, next) => {
      setLevels((prev) => withLevels(prev, datasetId, mode, next));
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

/** `levels` with `datasetId`'s readout for `mode` replaced, or itself when nothing changed. */
export function withLevels(
  levels: Map<string, LevelsByMode>,
  datasetId: string,
  mode: PoolMode,
  next: DatasetLevels | null,
): Map<string, LevelsByMode> {
  const held = levels.get(datasetId);
  if (sameDatasetLevels(held?.[mode] ?? null, next)) return levels;
  const byMode: LevelsByMode = { ...held };
  if (next === null) delete byMode[mode];
  else byMode[mode] = next;
  const updated = new Map(levels);
  if (byMode.slice === undefined && byMode.volume === undefined) updated.delete(datasetId);
  else updated.set(datasetId, byMode);
  return updated;
}
