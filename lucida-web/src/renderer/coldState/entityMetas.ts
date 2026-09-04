/**
 * Per-entity level section computation. Pure function — no GPU side
 * effects, no state mutation. A section is `gridX * gridY * gridZ` slots
 * for volume pools and `gridX * gridY` for slice pools.
 *
 * `applyColdState` calls this once per (entry, tier source) inside a
 * pool group, threading `startOffset` through so the returned
 * `nextOffset` becomes the start offset for the next section.
 */

import type { ColdStateActiveEntry } from "../workerProtocol.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";

/**
 * Compute the indirection meta for one entry at one level against a
 * pool's chunk dimensions, or `null` when the entry lacks that level or
 * the level's chunk shape does not match the pool. `dimArity = 3` for
 * volume pools (Z*Y*X indirection) and `dimArity = 2` for slice pools
 * (Y*X indirection, Z fixed by the slice).
 *
 * `poolChunkDims` is `[Z, Y, X]` (matches the worker's `chunkShape`
 * destructure). Slice mode ignores Z in the match — the pool's Z is
 * always 1 in `poolChunkDims` (set by `groupEntriesByPool`), so Z
 * compares would always fail.
 */
export function computeEntityTierMeta(
  entry: ColdStateActiveEntry,
  level: number,
  poolChunkDims: [number, number, number],
  startOffset: number,
  dimArity: 2 | 3,
): { meta: LodIndirectionMeta | null; nextOffset: number } {
  const [pcZ, pcY, pcX] = poolChunkDims;
  const lm = entry.levels.find(l => l.level === level);
  if (!lm) return { meta: null, nextOffset: startOffset };
  const [lChunkZ, lChunkY, lChunkX] = lm.chunkShape;
  if (dimArity === 3) {
    if (lChunkX !== pcX || lChunkY !== pcY || lChunkZ !== pcZ) {
      return { meta: null, nextOffset: startOffset };
    }
  } else if (lChunkX !== pcX || lChunkY !== pcY) {
    return { meta: null, nextOffset: startOffset };
  }
  const [lGridZ, lGridY, lGridX] = lm.gridShape;
  const [lLevelD, lLevelH, lLevelW] = lm.levelDims;
  const meta: LodIndirectionMeta = {
    level,
    gridDims: [lGridZ, lGridY, lGridX],
    chunkDims: [lChunkZ, lChunkY, lChunkX],
    levelDims: [lLevelD, lLevelH, lLevelW],
    offset: startOffset,
  };
  const nextOffset = startOffset + (dimArity === 3 ? lGridX * lGridY * lGridZ : lGridX * lGridY);
  return { meta, nextOffset };
}
