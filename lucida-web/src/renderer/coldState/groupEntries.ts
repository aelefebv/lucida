/**
 * Partition a cold state's active set into per-(channel, chunkDims) pool
 * groups. Pure function — no GPU side effects, no state mutation.
 * Parameterised by `mode` so the same logic serves 3D (volume) and 2D
 * (slice) callers; only chunk-dim arity differs.
 *
 * Each tile entry contributes one source per detail-tier level plus one
 * for its coarse level. `group-as-proxy` entries contribute none, because
 * they carry `levels: []` and have no chunks to upload. The orchestrator
 * still registers them in `memberToDataset` through
 * {@link iterateColdMembers}; they have no chunk pool, so they do not
 * appear here.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
} from "../workerProtocol.ts";
import { memberIdForColdEntry } from "../descriptorBuffer.ts";
import { chunkTierPoolKey } from "../poolKeys.ts";

/**
 * One pool's worth of entries from a cold state.
 *
 * `chunkDims` is captured as `[Z, Y, X]` for both modes so callers can
 * thread the same tuple through `getOrCreateVolumePool` (which takes
 * X/Y/Z) and `computeEntityTierMeta` (which compares against
 * `lm.chunkShape` — also `[Z, Y, X]`). Slice mode sets `Z = 1` since
 * the 2D pool ignores depth (the inline format string also dropped it).
 */
export interface PoolGroup {
  poolKey: string;
  tier: ResidencyTier;
  level: number;
  channel: number;
  /** `[Z, Y, X]`. For slice mode `Z = 1`. */
  chunkDims: [number, number, number];
  entries: Array<{ entry: ColdStateActiveEntry; memberId: string; tier: ResidencyTier; level: number }>;
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
      const memberId = memberIdForColdEntry(entry, channel, isMultiCh);
      for (const source of tierSourcesForEntry(entry)) {
        const levelMeta = entry.levels.find(l => l.level === source.level);
        if (!levelMeta) continue;
        const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        // `chunkTierPoolKey` takes `[X, Y, Z]` for volume / `[X, Y]` for
        // slice. Keep `chunkDims` on the group as `[Z, Y, X]` for
        // downstream callers.
        const poolKey =
          mode === "volume"
            ? chunkTierPoolKey(cold.datasetId, source.tier, channel, [chunkX, chunkY, chunkZ], isMultiCh)
            : chunkTierPoolKey(cold.datasetId, source.tier, channel, [chunkX, chunkY], isMultiCh);
        const dims: [number, number, number] =
          mode === "volume" ? [chunkZ, chunkY, chunkX] : [1, chunkY, chunkX];

        let group = groups.get(poolKey);
        if (!group) {
          group = { poolKey, tier: source.tier, level: source.level, channel, chunkDims: dims, entries: [] };
          groups.set(poolKey, group);
        }
        group.entries.push({ entry, memberId, tier: source.tier, level: source.level });
      }
    }
  }
  return groups;
}

function tierSourcesForEntry(
  entry: ColdStateActiveEntry,
): Array<{ tier: ResidencyTier; level: number }> {
  if (entry.kind === "group-as-proxy") return [];
  const sources: Array<{ tier: ResidencyTier; level: number }> =
    entry.detailLevels.map(level => ({ tier: "detail", level }));
  if (entry.coarseLevel !== null) {
    sources.push({ tier: "coarse", level: entry.coarseLevel });
  }
  return sources;
}
