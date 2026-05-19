/**
 * Per-entity LOD section computation. Pure function — no GPU side
 * effects, no state mutation. Per-LOD section size is `gridX * gridY *
 * gridZ` for volume pools and `gridX * gridY` for slice pools.
 *
 * For each entry in a pool, walks `[finest, coarsest]` LODs and emits
 * a `LodIndirectionMeta` for every level whose `chunkShape` matches the
 * pool's chunk dims. Falls back to the target LOD only when no LODs
 * match (the legacy chunk-dim-mismatch path).
 *
 * Threads `startOffset` through entries in the same pool so the
 * returned `nextOffset` becomes the start offset for the next entry.
 */

import type { ColdStateActiveEntry } from "../workerProtocol.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";

/**
 * Compute per-LOD indirection metas for a single entry against a pool's
 * chunk dimensions. `dimArity = 3` for volume pools (Z*Y*X indirection)
 * and `dimArity = 2` for slice pools (Y*X indirection, Z fixed by the
 * slice).
 *
 * `poolChunkDims` is `[Z, Y, X]` (matches the worker's `chunkShape`
 * destructure). Slice mode ignores Z in the match — the pool's Z is
 * always 1 in `poolChunkDims` (set by {@link groupEntriesByPool}), so
 * Z compares would always fail.
 */
export function computeEntityMetas(
  entry: ColdStateActiveEntry,
  poolChunkDims: [number, number, number],
  startOffset: number,
  dimArity: 2 | 3,
): { metas: LodIndirectionMeta[]; nextOffset: number } {
  const [pcZ, pcY, pcX] = poolChunkDims;
  const metas: LodIndirectionMeta[] = [];
  let offset = startOffset;

  const levels = entry.wantedLodLevels && entry.wantedLodLevels.length > 0
    ? [...new Set(entry.wantedLodLevels)].sort((a, b) => a - b)
    : levelsFromRange(entry.detailOwnedLodRange);

  for (const lvl of levels) {
    const lm = entry.levels.find(l => l.level === lvl);
    if (!lm) continue;
    const [lChunkZ, lChunkY, lChunkX] = lm.chunkShape;
    if (dimArity === 3) {
      if (lChunkX !== pcX || lChunkY !== pcY || lChunkZ !== pcZ) continue;
    } else {
      if (lChunkX !== pcX || lChunkY !== pcY) continue;
    }
    const [lGridZ, lGridY, lGridX] = lm.gridShape;
    const [lLevelD, lLevelH, lLevelW] = lm.levelDims;
    metas.push({
      level: lvl,
      gridDims: [lGridZ, lGridY, lGridX],
      chunkDims: [lChunkZ, lChunkY, lChunkX],
      levelDims: [lLevelD, lLevelH, lLevelW],
      offset,
    });
    offset += dimArity === 3 ? lGridX * lGridY * lGridZ : lGridX * lGridY;
  }

  // Fallback: include target LOD only when no LODs matched the pool's
  // chunk dims. The worker uses the target LOD's gridShape but the
  // pool's chunkDims (with arity-appropriate fallback for the chunkZ
  // slot in slice mode — original code wrote the target level's chunkZ
  // for slice, so preserve that).
  if (metas.length === 0) {
    const targetLevel = entry.levels.find(l => l.level === entry.targetLod);
    if (!targetLevel) return { metas, nextOffset: offset };
    const [tChunkZ, tChunkY, tChunkX] = targetLevel.chunkShape;
    const [tGridZ, tGridY, tGridX] = targetLevel.gridShape;
    const [tLevelD, tLevelH, tLevelW] = targetLevel.levelDims;
    const fallbackChunkDims: [number, number, number] =
      dimArity === 3 ? [pcZ, pcY, pcX] : [tChunkZ, tChunkY, tChunkX];
    metas.push({
      level: entry.targetLod,
      gridDims: [tGridZ, tGridY, tGridX],
      chunkDims: fallbackChunkDims,
      levelDims: [tLevelD, tLevelH, tLevelW],
      offset,
    });
    offset += dimArity === 3 ? tGridX * tGridY * tGridZ : tGridX * tGridY;
  }

  return { metas, nextOffset: offset };
}

function levelsFromRange([finest, coarsest]: [number, number]): number[] {
  const out: number[] = [];
  for (let lvl = finest; lvl <= coarsest; lvl++) out.push(lvl);
  return out;
}
