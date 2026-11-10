/**
 * Eviction kernels shared by `renderer/volume/eviction` and
 * `renderer/slice/eviction`. The slice case is the volume case with the
 * Z term dropped, so keep one implementation rather than two copies that
 * drift. No GPU coupling and no module state.
 */

import type { LodIndirectionMeta } from "./volume/atlas.ts";
import { parseCompositeKey, parsePlaneChunkKey } from "./chunkKeys.ts";
import type { SpatialAxis } from "./slicePlane.ts";

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

export interface FindEvictionParams {
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
   * or `undefined` when the worker holds no cold state for the member. The
   * pool has no section for a resident chunk finer than it.
   */
  targetLevelFor: (memberId: string) => number | undefined;
  /** Whether the planner wants a resident chunk for the current view. */
  isWanted: (memberId: string, chunkKey: string) => boolean;
  /**
   * Volume mode → use 3D distance (include the chunk's Z + camera's
   * Z). Slice mode → strip Z; the per-Z filter has already constrained
   * residency to a single Z plane.
   */
  is3D: boolean;
  /**
   * The axis a slice pool's slots are cut along; slot keys then read in that
   * plane's frame (`parsePlaneChunkKey`). Absent: Z.
   */
  sliceAxis?: SpatialAxis;
}

/**
 * The three kinds of slot, in the order they are evicted:
 *
 *   - `unsampled`: the shader never reads it. It is finer than its member's
 *     target level, unmapped (another T, C or plane), or has no section.
 *   - `unwanted`: mapped, and the shader may sample it as a fallback, but the
 *     planner does not want it.
 *   - `wanted`: the planner wants it.
 */
export type EvictionClass = "unsampled" | "unwanted" | "wanted";

export interface EvictionCandidate {
  key: string;
  class: EvictionClass;
  /** Squared distance to the member's camera reference; `Infinity` for `unsampled`. */
  dist: number;
}

/**
 * Pick the slot an incoming chunk may take. Every slot the planner does not
 * want goes before any it does, and each class has a fixed order, so the
 * choice never depends on the order chunks arrived in:
 *   1. `unsampled`: the greatest composite key.
 *   2. `unwanted`: the farthest from its member's camera reference, keeping
 *      near fallback longest; the greatest key among equally far.
 *   3. `wanted`: the farthest, then the greatest key. The caller evicts it
 *      only for a wanted chunk strictly nearer, so two chunks at one distance
 *      never trade a slot.
 * Returns null when the pool holds nothing.
 */
export function findEvictionSlot(params: FindEvictionParams): EvictionCandidate | null {
  let unsampledKey = "";
  let unwantedKey = "";
  let unwantedDist = -1;
  let wantedKey = "";
  let wantedDist = -1;

  for (const [compositeKey, slotIdx] of params.slots) {
    // Once the scan holds an unsampled slot, no other class can outrank it.
    const slot = classifySlot(params, compositeKey, slotIdx, unsampledKey === "");
    if (!slot) continue;
    if (slot.class === "unsampled") {
      if (compositeKey > unsampledKey) unsampledKey = compositeKey;
    } else if (slot.class === "wanted") {
      if (slot.dist > wantedDist || (slot.dist === wantedDist && compositeKey > wantedKey)) {
        wantedDist = slot.dist;
        wantedKey = compositeKey;
      }
    } else if (slot.dist > unwantedDist || (slot.dist === unwantedDist && compositeKey > unwantedKey)) {
      unwantedDist = slot.dist;
      unwantedKey = compositeKey;
    }
  }

  if (unsampledKey) return { key: unsampledKey, class: "unsampled", dist: Infinity };
  if (unwantedKey) return { key: unwantedKey, class: "unwanted", dist: unwantedDist };
  if (wantedKey) return { key: wantedKey, class: "wanted", dist: wantedDist };
  return null;
}

const CLASS_RANK: Record<EvictionClass, number> = { wanted: 0, unwanted: 1, unsampled: 2 };

/**
 * Every slot, in the order a pool that must shrink keeps them: the reverse of
 * {@link findEvictionSlot}'s order, so wanted slots nearest first, then
 * unwanted ones nearest first, then unsampled ones.
 */
export function rankSlotsToKeep(params: FindEvictionParams): EvictionCandidate[] {
  const ranked: EvictionCandidate[] = [];
  for (const [compositeKey, slotIdx] of params.slots) {
    const slot = classifySlot(params, compositeKey, slotIdx, true);
    ranked.push(slot ?? { key: compositeKey, class: "unsampled", dist: Infinity });
  }
  return ranked.sort((a, b) =>
    CLASS_RANK[a.class] - CLASS_RANK[b.class] ||
    a.dist - b.dist ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * One slot's class, and its distance unless `withDistance` is false or the
 * slot is unsampled. Null for a key that doesn't parse.
 */
function classifySlot(
  params: FindEvictionParams,
  compositeKey: string,
  slotIdx: number,
  withDistance: boolean,
): EvictionCandidate | null {
  const parsed = parseCompositeKey(compositeKey);
  if (!parsed) return null;
  const chunk = parsePlaneChunkKey(parsed.chunkKey, params.sliceAxis);
  if (!chunk) return null;

  const target = params.targetLevelFor(parsed.memberId);
  const lodMeta = params.slotGridIdx[slotIdx] < 0
    ? undefined
    : params.entityMetas.get(parsed.memberId)?.find(m => m.level === chunk.level);
  if ((target !== undefined && chunk.level < target) || !lodMeta) {
    return { key: compositeKey, class: "unsampled", dist: Infinity };
  }
  const wanted = params.isWanted(parsed.memberId, parsed.chunkKey);
  if (!withDistance) return { key: compositeKey, class: wanted ? "wanted" : "unwanted", dist: 0 };
  const cam = params.cameraFor(parsed.memberId);
  const dist = params.is3D
    ? chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam)
    : chunkDistSq(lodMeta, chunk.x, chunk.y, null, cam);
  return { key: compositeKey, class: wanted ? "wanted" : "unwanted", dist };
}

/** Whether a wanted incoming chunk at `incomingDist` may take `victim`'s slot. */
export function mayEvict(victim: EvictionCandidate, incomingDist: number): boolean {
  return victim.class !== "wanted" || incomingDist < victim.dist;
}
