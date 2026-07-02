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
import { chunkTierPoolKey, type ChunkTier } from "../poolKeys.ts";

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
  tier: ChunkTier;
  level: number;
  channel: number;
  /** `[Z, Y, X]`. For slice mode `Z = 1`. */
  chunkDims: [number, number, number];
  /**
   * True when this group holds segmentation **label** members. Label groups get
   * their own `:label`-discriminated pool key and an `r32uint` atlas (so ids
   * > 65535 aren't truncated); the cold-state applier reads this to pick the
   * texel format when allocating the pool.
   */
  isLabel: boolean;
  entries: Array<{ entry: ColdStateActiveEntry; memberId: string; tier: ChunkTier; level: number }>;
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
      const isLabel = entry.isLabel === true;
      for (const source of tierSourcesForEntry(entry)) {
        const targetLevel = entry.levels.find(l => l.level === source.level);
        if (!targetLevel) continue; // well-as-proxy (no levels) skips here
        const [chunkZ, chunkY, chunkX] = targetLevel.chunkShape;
        // `chunkTierPoolKey` takes `[X, Y, Z]` for volume / `[X, Y]` for
        // slice. Keep `chunkDims` on the group as `[Z, Y, X]` for
        // downstream callers. Label members get a `:label` discriminator so
        // they land in their own `r32uint` pool.
        const poolKey =
          mode === "volume"
            ? chunkTierPoolKey(cold.datasetId, source.tier, channel, [chunkX, chunkY, chunkZ], isMultiCh, isLabel)
            : chunkTierPoolKey(cold.datasetId, source.tier, channel, [chunkX, chunkY], isMultiCh, isLabel);
        const dims: [number, number, number] =
          mode === "volume" ? [chunkZ, chunkY, chunkX] : [1, chunkY, chunkX];

        let group = groups.get(poolKey);
        if (!group) {
          group = { poolKey, tier: source.tier, level: source.level, channel, chunkDims: dims, isLabel, entries: [] };
          groups.set(poolKey, group);
        }
        group.entries.push({ entry, memberId, tier: source.tier, level: source.level });
      }
    }
  }
  return groups;
}

function tierSourcesForEntry(entry: ColdStateActiveEntry): Array<{ tier: ChunkTier; level: number }> {
  if (entry.kind === "well-as-proxy") return [];
  const detailLevel = entry.detailLevel ?? entry.targetLod;
  const sources: Array<{ tier: ChunkTier; level: number }> = [
    { tier: "detail", level: detailLevel },
  ];
  if (entry.coarseLevel !== undefined && entry.coarseLevel !== null) {
    sources.push({ tier: "coarse", level: entry.coarseLevel });
  }
  return sources;
}
