import { useCallback, useSyncExternalStore } from "react";
import { failedChunkReport, type FailedChunkSummary } from "../pipeline/failedChunks.ts";

/** The chunks of one dataset the source failed for good, or null when none have. */
export function useFailedChunks(datasetId: string): FailedChunkSummary | null {
  const read = useCallback(() => failedChunkReport.get(datasetId), [datasetId]);
  return useSyncExternalStore(subscribe, read);
}

function subscribe(onChange: () => void): () => void {
  return failedChunkReport.subscribe(onChange);
}
