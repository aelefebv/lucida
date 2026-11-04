/**
 * Eviction kernels shared by `renderer/volume/eviction` and
 * `renderer/slice/eviction`. The slice case is the volume case with the
 * Z term dropped, so keep one implementation rather than two copies that
 * drift. No GPU coupling and no module state.
 */

import type { LodIndirectionMeta } from "./volume/atlas.ts";
import { parseChunkKey, parseCompositeKey } from "./chunkKeys.ts";

/**
 * Squared distance from a chunk grid coordinate to a reference point in
 * normalized [0,1] entity-local space.
 *
 * - Volume callers pass `cz` (chunk's z grid coord) and a 3-component
 *   `cam`. The Z term contributes to the distance.
 * - Slice callers pass `null` for `cz` and a 2-component `cam`. The Z
 *   term is dropped.
 *
 * Uses the chunk's own LOD dims (from `lodMeta`) for normalization
 * since different LODs may have different grids.
 */
export function chunkDistSq(
  lodMeta: LodIndirectionMeta,
  cx: number,
  cy: number,
  cz: number | null,
  cam: [number, number] | [number, number, number],
): number {
  const [, levelH, levelW] = lodMeta.levelDims;
  const [chunkZ, chunkY, chunkX] = lodMeta.chunkDims;
  const px = (cx + 0.5) * chunkX / Math.max(levelW, 1);
  const py = (cy + 0.5) * chunkY / Math.max(levelH, 1);
  const dx = px - cam[0];
  const dy = py - cam[1];
  if (cz === null) return dx * dx + dy * dy;
  const levelD = lodMeta.levelDims[0];
  const pz = (cz + 0.5) * chunkZ / Math.max(levelD, 1);
  const dz = pz - (cam as [number, number, number])[2];
  return dx * dx + dy * dy + dz * dz;
}

export interface FindFarthestParams {
  /** Composite slot keys → slot indices. */
  slots: Map<string, number>;
  /** slotIndex → globalGridIdx; `< 0` means slot is stale (unmapped). */
  slotGridIdx: Int32Array;
  /** Per-entity LOD section metas. */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /**
   * Per-entity camera reference. Volume callers return a 3-tuple
   * (rayHit); slice callers return a 2-tuple (camera UV).
   */
  cameraFor: (memberId: string) => [number, number] | [number, number, number];
  /**
   * Per-entity target level (`detailLevels[0]` of its cold-state entry),
   * or `undefined` when the worker holds no cold state for the member. A
   * resident chunk finer than it is the first to go.
   */
  targetLevelFor: (memberId: string) => number | undefined;
  /**
   * Volume mode → use 3D distance (include the chunk's Z + camera's
   * Z). Slice mode → strip Z; the per-Z filter has already constrained
   * residency to a single Z plane.
   */
  is3D: boolean;
}

/**
 * Pick the eviction candidate from an atlas's slot map (ADR 0061):
 *   1. A chunk finer than its member's target level, finest first. The
 *      pool has no section for it, so the shader never samples it.
 *   2. Else a stale slot: unmapped, member gone from the active set, or
 *      no section for its level.
 *   3. Else the mapped chunk farthest from its member's camera reference,
 *      whatever its level.
 * Cases 1 and 2 return `dist = Infinity`. A later finer chunk outranks a
 * stale one, so the scan can't stop early except at level 0. The caller
 * evicts only if the incoming chunk is nearer than `dist`.
 */
export function findFarthestSlot(params: FindFarthestParams): { key: string; dist: number } {
  let finerKey = "";
  let finerLevel = Infinity;
  let staleKey = "";
  let farthestKey = "";
  let maxDist = -1;

  for (const [compositeKey, slotIdx] of params.slots) {
    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const chunk = parseChunkKey(parsed.chunkKey);
    if (!chunk) continue;

    const target = params.targetLevelFor(parsed.memberId);
    if (target !== undefined && chunk.level < target) {
      if (chunk.level < finerLevel) {
        finerLevel = chunk.level;
        finerKey = compositeKey;
        if (finerLevel === 0) break;
      }
      continue;
    }
    // Once the scan holds a finer chunk, only a still-finer one can outrank it.
    if (finerKey) continue;

    const gridIdx = params.slotGridIdx[slotIdx];
    const lodMeta = gridIdx < 0
      ? undefined
      : params.entityMetas.get(parsed.memberId)?.find(m => m.level === chunk.level);
    if (!lodMeta) {
      if (!staleKey) staleKey = compositeKey;
      continue;
    }
    if (staleKey) continue;

    const cam = params.cameraFor(parsed.memberId);
    const dist = params.is3D
      ? chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam)
      : chunkDistSq(lodMeta, chunk.x, chunk.y, null, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = compositeKey;
    }
  }

  if (finerKey) return { key: finerKey, dist: Infinity };
  if (staleKey) return { key: staleKey, dist: Infinity };
  return { key: farthestKey, dist: maxDist };
}
