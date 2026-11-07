import { useCallback, useEffect, useState } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import { sameDatasetLevels, type DatasetLevels } from "../pipeline/datasetLevels.ts";

/**
 * The per-dataset level readout the render worker reports: the target level
 * and the level actually on screen. The client summarises every report as it
 * arrives, so the map only changes identity when a dataset's summary
 * changes; React skips the re-render otherwise. `forget` drops a removed
 * dataset, which the worker stops reporting rather than reports as empty.
 */
export function useDatasetLevels({
  clientReady,
  clientRef,
}: {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
}): { levels: Map<string, DatasetLevels>; forget: (datasetId: string) => void } {
  const [levels, setLevels] = useState<Map<string, DatasetLevels>>(new Map());

  useEffect(() => {
    const client = clientRef.current;
    if (!clientReady || !client) return;
    client.onEntityLevels = (datasetId, next) => {
      setLevels((prev) => {
        if (sameDatasetLevels(prev.get(datasetId) ?? null, next)) return prev;
        const updated = new Map(prev);
        if (next === null) updated.delete(datasetId);
        else updated.set(datasetId, next);
        return updated;
      });
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
