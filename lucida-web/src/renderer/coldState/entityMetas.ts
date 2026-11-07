/**
 * Per-entity level section computation. Pure. A section is
 * `gridX * gridY * gridZ` slots for volume pools and `gridX * gridY` for
 * slice pools; `applyColdState` threads each `nextOffset` into the next call.
 */

import type { ColdStateActiveEntry } from "../workerProtocol.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";

/**
 * The indirection meta for one entry at one level, or `null` when the entry
 * lacks that level or its chunk shape doesn't match the pool's `[Z, Y, X]`
 * dims. Slice mode (`dimArity = 2`) skips the Z compare because a slice
 * pool's Z is always 1.
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
