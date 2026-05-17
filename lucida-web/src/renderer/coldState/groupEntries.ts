/**
 * Partition a cold state's active set into per-(channel, chunkDims) pool
 * groups. Pure function — no GPU side effects, no state mutation.
 * Parameterised by `mode` so the same logic serves 3D (volume) and 2D
 * (slice) callers; only chunk-dim arity differs.
 *
 * Skips entries whose `targetLod` is not in `entry.levels[]` — that
 * covers `well-as-proxy` entries (which carry `levels: []` because they
 * have no chunks to upload). Those still get registered in
 * `memberToDataset` via {@link iterateColdMembers} in the orchestrator;
 * they just don't appear here because there's no chunk pool to put them
 * in.
 */

import type {
  ColdStateMessage,
  ColdStateActiveEntry,
} from "../workerProtocol.ts";
import { memberIdForColdEntry } from "../descriptorBuffer.ts";
import { chunkPoolKey } from "../poolKeys.ts";

/**
 * One pool's worth of entries from a cold state.
 *
 * `chunkDims` is captured as `[Z, Y, X]` for both modes so callers can
 * thread the same tuple through `getOrCreateVolumePool` (which takes
 * X/Y/Z) and `computeEntityMetas` (which compares against
 * `lm.chunkShape` — also `[Z, Y, X]`). Slice mode sets `Z = 1` since
 * the 2D pool ignores depth (the inline format string also dropped it).
 */
export interface PoolGroup {
  poolKey: string;
  channel: number;
  /** `[Z, Y, X]`. For slice mode `Z = 1`. */
  chunkDims: [number, number, number];
  entries: Array<{ entry: ColdStateActiveEntry; memberId: string }>;
}

/**
 * Partition `cold.activeSet × cold.visibleChannels` into pool groups.
 *
 * Iteration order matches the worker's previous inline code: channel
 * outer, entry inner. The resulting Map preserves insertion order so
 * downstream code that builds entityMetas with sequential offsets sees
 * entries in the same order the worker did before extraction.
 */
export function groupEntriesByPool(
  cold: ColdStateMessage,
  mode: "volume" | "slice",
): Map<string, PoolGroup> {
  const groups = new Map<string, PoolGroup>();
  const isMultiCh = cold.multiChannel;
  const channels = isMultiCh
    ? cold.visibleChannels
    : [cold.visibleChannels[0]];

  for (const channel of channels) {
    for (const entry of cold.activeSet) {
      const targetLevel = entry.levels.find(l => l.level === entry.targetLod);
      if (!targetLevel) continue; // well-as-proxy (no levels) skips here
      const [chunkZ, chunkY, chunkX] = targetLevel.chunkShape;
      // `chunkPoolKey` takes `[X, Y, Z]` for volume / `[X, Y]` for slice,
      // matching the inline format strings in `gpu.worker.ts`. We keep
      // `chunkDims` on the group as `[Z, Y, X]` for downstream callers.
      const poolKey =
        mode === "volume"
          ? chunkPoolKey(cold.datasetId, channel, [chunkX, chunkY, chunkZ], isMultiCh)
          : chunkPoolKey(cold.datasetId, channel, [chunkX, chunkY], isMultiCh);
      const dims: [number, number, number] =
        mode === "volume" ? [chunkZ, chunkY, chunkX] : [1, chunkY, chunkX];
      const memberId = memberIdForColdEntry(entry, channel, isMultiCh);

      let group = groups.get(poolKey);
      if (!group) {
        group = { poolKey, channel, chunkDims: dims, entries: [] };
        groups.set(poolKey, group);
      }
      group.entries.push({ entry, memberId });
    }
  }
  return groups;
}
