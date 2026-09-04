/**
 * Shared eviction kernels used by both `renderer/volume/eviction` and
 * `renderer/slice/eviction`.
 *
 * Why one module:
 *
 *   - `chunkDistSq` (volume) and `chunkDistSq2D` (slice) are
 *     mathematically the same function — 2D form is simply 3D with the
 *     Z term dropped. The duplication has cost us bug-hunting time
 *     before (level-dim arity mismatch, chunkDims tuple ordering) and
 *     each fix had to land in two places.
 *
 *   - `findFarthestSlot` (volume) and `findFarthestSlot2D` (slice)
 *     differ only in:
 *       * the dimensionality of the per-entity camera reference, and
 *       * whether `chunkDistSq` uses the Z term.
 *     Everything else (finer-than-target first, then stale, then
 *     farthest; parse composite key; lookup entity meta) is identical.
 *
 * The handlers keep their public function names; this module is the
 * source of truth for the algorithm.
 *
 * No GPU coupling, no module state — safe to import from workers,
 * tests, and any future split-out volume/slice eviction files.
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
 * Find the best eviction candidate from an atlas's slot map.
 *
 * Order (ADR 0061):
 *   1. A chunk finer than its member's target level, finest level first.
 *      The pool holds no section for a level finer than the target, so
 *      the shader never samples such a chunk, and it is the most
 *      expensive resident. At the same target, a level-0 chunk covers a
 *      quarter of the screen a level-1 chunk does. Returned with
 *      `dist = Infinity`.
 *   2. Otherwise a stale slot: unmapped (`slotGridIdx < 0`), or its
 *      member has left the active set, or its level has no section.
 *      Also `dist = Infinity`.
 *   3. Otherwise the mapped chunk farthest from its member's camera
 *      reference, whatever its level. A coarser resident chunk near the
 *      view outlives a target-level chunk at the edge.
 *
 * The scan covers the whole slot map instead of stopping at the first
 * stale slot, because a finer chunk later in the map outranks it. A
 * level-0 chunk ends the scan early, because nothing is finer.
 *
 * The caller decides whether to actually evict by comparing the
 * incoming chunk's distance to the returned `dist`.
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
