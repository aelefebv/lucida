/** Shared upload infrastructure for slice and volume render paths. */
import type { ChunkCoord, SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { ContentGraph } from "./contentTypes.ts";

/** A single member's chunk plan, consumed by the upload loop. */
export interface MemberChunkPlan {
  image_id: string;
  position: [number, number];
  needed: ChunkCoord[];
  prefetch: ChunkCoord[];
}
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";
import { debugStats } from "./debug/debugStats.ts";

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface UploadState {
  prevStateKey: Map<string, string>;
  sentToWorker: Map<string, Set<string>>;
  planCache: Map<string, { key: string; plans: MemberChunkPlan[] }>;
}

export function createUploadState(): UploadState {
  return {
    prevStateKey: new Map(),
    sentToWorker: new Map(),
    planCache: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Per-member action interface (caller supplies render-path-specific logic)
// ---------------------------------------------------------------------------

export interface MemberUploadActions {
  stateKey: string;
  sendAtlasConfig(): void;
  sendFineChunks(chunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[]): void;
}

// ---------------------------------------------------------------------------
// Core shared upload loop
// ---------------------------------------------------------------------------

/**
 * Resolve the real dataset ID from a plan cache key.
 *
 * In multi-channel mode the cache key is `${dsId}:ch${n}` — strip the
 * channel suffix to find the dataset. In single-channel mode the key is
 * the plain dataset ID.
 */
function resolveDatasetId(cacheKey: string): string {
  return cacheKey.replace(/:ch\d+$/, "");
}

export function uploadChunksForMembers(
  datasets: Map<string, { sharedQueue: SharedChunkQueue; content: ContentGraph }>,
  memberPlanCache: Map<string, MemberChunkPlan[]>,
  state: UploadState,
  shouldSkipDataset: (cacheKey: string, ds: { sharedQueue: SharedChunkQueue; content: ContentGraph }) => boolean,
  createActions: (memberId: string, mp: MemberChunkPlan, ds: { sharedQueue: SharedChunkQueue; content: ContentGraph }, dsId: string) => MemberUploadActions | null,
): boolean {
  let uploadBudget = MAIN_VIEW_UPLOAD_BUDGET_BYTES;
  let budgetExhausted = false;

  // Iterate memberPlanCache instead of datasets so that composite keys
  // (e.g. `dsId:ch0`) from multi-channel mode are found correctly.
  for (const [cacheKey, sortedPlans] of memberPlanCache) {
    const dsId = resolveDatasetId(cacheKey);
    const ds = datasets.get(dsId);
    if (!ds) continue;
    if (shouldSkipDataset(cacheKey, ds)) continue;

    for (const mp of sortedPlans) {
      // In multi-channel mode, the plan cache key includes the channel
      // (e.g. `dsId:ch1`). We need to pass the composite member ID to
      // createActions so that state maps (prevStateKey, sentToWorker, etc.)
      // are keyed correctly. The composite member ID is built by the caller
      // in tickCommon's planAndFetchForDatasets.
      const isComposite = cacheKey !== dsId;
      const channelSuffix = isComposite ? cacheKey.substring(dsId.length) : "";
      const memberId = isComposite ? `${mp.image_id}${channelSuffix}` : mp.image_id;
      const rawMemberId = mp.image_id;

      const actions = createActions(memberId, mp, ds, dsId);
      if (!actions) continue;

      // --- Atlas config on state key change ---
      if (actions.stateKey !== state.prevStateKey.get(memberId)) {
        actions.sendAtlasConfig();
        state.sentToWorker.delete(memberId);
        state.prevStateKey.set(memberId, actions.stateKey);
      }

      // --- Fine chunk upload (budgeted) ---
      let sentSet = state.sentToWorker.get(memberId);
      if (!sentSet) {
        sentSet = new Set();
        state.sentToWorker.set(memberId, sentSet);
      }

      if (!budgetExhausted) {
        const chunksToSend: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
        for (const coord of mp.needed) {
          if (debugStats.enabled && debugStats.uploadDebug) debugStats.uploadDebug.chunksAttempted++;
          if (sentSet.has(coord.key)) {
            if (debugStats.enabled && debugStats.uploadDebug) debugStats.uploadDebug.chunksSentSkip++;
            continue;
          }
          const buf = ds.sharedQueue.get(rawMemberId, coord.key);
          if (!buf || buf.byteLength === 0) {
            if (debugStats.enabled && debugStats.uploadDebug) debugStats.uploadDebug.chunksCacheMiss++;
            continue;
          }
          if (debugStats.enabled && debugStats.uploadDebug) debugStats.uploadDebug.chunksCacheHit++;
          const data = new Uint16Array(buf);
          chunksToSend.push({ data, x: coord.x, y: coord.y, z: coord.z, key: coord.key });
          sentSet.add(coord.key);
          uploadBudget -= buf.byteLength;
          if (uploadBudget <= 0) {
            budgetExhausted = true;
            break;
          }
        }
        if (chunksToSend.length > 0) {
          actions.sendFineChunks(chunksToSend);
        }
      }
    }
  }

  if (debugStats.enabled) {
    debugStats.uploadBytesUsed = MAIN_VIEW_UPLOAD_BUDGET_BYTES - uploadBudget;
    debugStats.budgetExhausted = budgetExhausted;
  }

  return budgetExhausted;
}

// ---------------------------------------------------------------------------
// Clear / reset helpers
// ---------------------------------------------------------------------------

export function clearUploadStateForDataset(state: UploadState, dsId: string): void {
  state.prevStateKey.delete(dsId);
  state.sentToWorker.delete(dsId);
  state.planCache.delete(dsId);
}

export function clearUploadStateForMembers(state: UploadState, memberIds: string[]): void {
  for (const id of memberIds) {
    state.prevStateKey.delete(id);
    state.sentToWorker.delete(id);
  }
}

export function resetUploadState(state: UploadState): void {
  state.prevStateKey.clear();
  state.sentToWorker.clear();
  state.planCache.clear();
}
