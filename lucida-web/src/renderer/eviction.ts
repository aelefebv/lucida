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
 *     Everything else (prefer-stale, parse composite key, lookup entity
 *     meta) is identical.
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
   * Volume mode → use 3D distance (include the chunk's Z + camera's
   * Z). Slice mode → strip Z; the per-Z filter has already constrained
   * residency to a single Z plane.
   */
  is3D: boolean;
}

/**
 * Find the best eviction candidate from an atlas's slot map.
 *
 * Policy:
 *   1. Prefer a stale slot (one whose `slotGridIdx < 0`, or whose
 *      member has been removed from the active set). Those are returned
 *      immediately with `dist = Infinity`.
 *   2. Otherwise pick the slot whose cached chunk is farthest from its
 *      member's camera reference.
 *
 * The caller decides whether to actually evict by comparing the
 * incoming chunk's distance to the returned `dist`.
 */
export function findFarthestSlot(params: FindFarthestParams): { key: string; dist: number } {
  let farthestKey = "";
  let maxDist = -1;

  for (const [compositeKey, slotIdx] of params.slots) {
    const gridIdx = params.slotGridIdx[slotIdx];
    if (gridIdx < 0) {
      // Stale chunk (not mapped in indirection) — always prefer for eviction.
      return { key: compositeKey, dist: Infinity };
    }

    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const lodMetas = params.entityMetas.get(parsed.memberId);
    if (!lodMetas) {
      // Entity gone from active set — prefer for eviction.
      return { key: compositeKey, dist: Infinity };
    }
    const chunk = parseChunkKey(parsed.chunkKey);
    if (!chunk) continue;
    const lodMeta = lodMetas.find(m => m.level === chunk.level);
    if (!lodMeta) continue;

    const cam = params.cameraFor(parsed.memberId);
    const dist = params.is3D
      ? chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam)
      : chunkDistSq(lodMeta, chunk.x, chunk.y, null, cam);

    if (dist > maxDist) {
      maxDist = dist;
      farthestKey = compositeKey;
    }
  }

  return { key: farthestKey, dist: maxDist };
}
