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

/** What eviction reads of one view drawing from a pool. */
export interface EvictionView {
  /** slotIndex → the view's cell; `< 0` means the view does not map the slot. */
  slotGridIdx: Int32Array;
  /** The view's per-entity level sections. */
  entityMetas: ReadonlyMap<string, readonly LodIndirectionMeta[]>;
  /**
   * Per-entity camera reference in this view. Volume callers return a
   * 3-tuple (rayHit); slice callers return a 2-tuple (camera UV).
   */
  cameraFor: (memberId: string) => [number, number] | [number, number, number];
  /**
   * Per-entity target level of the view's cold state, or `undefined` when it
   * has none for the member. The view samples no resident chunk finer.
   */
  targetLevelFor: (memberId: string) => number | undefined;
  /** Whether the planner wants a resident chunk for this view. */
  isWanted: (memberId: string, chunkKey: string) => boolean;
  /**
   * What `cameraFor`, `targetLevelFor` and `isWanted` answer from. Each is
   * replaced rather than changed in place, or is a revision that moves with
   * it, so while every one is the same the answers are too, and a pool's
   * `EvictionOrder` need not classify its slots again.
   */
  sources: readonly unknown[];
}

export interface FindEvictionParams {
  /** Composite slot keys → slot indices. */
  slots: Map<string, number>;
  /** Every view drawing from the pool. A slot is classed by the views that sample it. */
  views: readonly EvictionView[];
  /**
   * Volume mode → use 3D distance (include the chunk's Z + camera's
   * Z). Slice mode → strip Z; a view maps one plane of each chunk.
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
 *   - `unsampled`: no view's shader reads it. In every view it is finer than
 *     its member's target level, unmapped (another T, C or plane), or has no
 *     section.
 *   - `unwanted`: a view maps it, and its shader may sample it as a
 *     fallback, but the planner wants it for no view that maps it.
 *   - `wanted`: the planner wants it for a view that maps it.
 */
export type EvictionClass = "unsampled" | "unwanted" | "wanted";

export interface EvictionCandidate {
  key: string;
  class: EvictionClass;
  /** Squared distance to the nearest camera reference of a view that samples it; `Infinity` for `unsampled`. */
  dist: number;
}

/** A composite slot key read: its member, its chunk key, and the chunk's place in the pool's frame. */
export interface SlotIdentity {
  memberId: string;
  chunkKey: string;
  /** Null for a chunk key that doesn't parse. Such a slot is never a candidate. */
  chunk: { level: number; x: number; y: number; z: number } | null;
}

/** Read a composite slot key, or null for one with no member. */
export function readSlotKey(compositeKey: string, sliceAxis?: SpatialAxis): SlotIdentity | null {
  const parsed = parseCompositeKey(compositeKey);
  if (!parsed) return null;
  return {
    memberId: parsed.memberId,
    chunkKey: parsed.chunkKey,
    chunk: parsePlaneChunkKey(parsed.chunkKey, sliceAxis),
  };
}

const EVICTION_RANK: Record<EvictionClass, number> = { unsampled: 2, unwanted: 1, wanted: 0 };

/**
 * Whether eviction takes `a` before `b`. Every slot the planner does not want
 * goes before any it does, and each class has a fixed order, so the choice
 * never depends on the order chunks arrived in:
 *   1. `unsampled`: the greatest composite key.
 *   2. `unwanted`: the farthest from its member's camera reference, keeping
 *      near fallback longest; the greatest key among equally far.
 *   3. `wanted`: the farthest, then the greatest key. The caller evicts it
 *      only for a wanted chunk strictly nearer, so two chunks at one distance
 *      never trade a slot.
 */
export function evictsBefore(a: EvictionCandidate, b: EvictionCandidate): boolean {
  const rank = EVICTION_RANK[a.class] - EVICTION_RANK[b.class];
  if (rank !== 0) return rank > 0;
  if (a.dist !== b.dist) return a.dist > b.dist;
  return a.key > b.key;
}

/** Whether a classified slot has a place in {@link evictsBefore}'s order: a NaN distance compares false with any. */
export function isEvictionCandidate(slot: EvictionCandidate): boolean {
  return !Number.isNaN(slot.dist);
}

/**
 * Pick the slot an incoming chunk may take: the first in {@link evictsBefore}'s
 * order, or null when the pool holds nothing. It classifies every slot, so an
 * upload asks the pool's `EvictionOrder`, which keeps the same pick as chunks
 * come and go.
 */
export function findEvictionSlot(params: FindEvictionParams): EvictionCandidate | null {
  let best: EvictionCandidate | null = null;
  for (const [compositeKey, slotIdx] of params.slots) {
    const slot = readSlotKey(compositeKey, params.sliceAxis);
    if (!slot?.chunk) continue;
    // Once the scan holds an unsampled slot, no other class can outrank it.
    const candidate = classifySlot(params, compositeKey, slot, slotIdx, best?.class !== "unsampled");
    if (isEvictionCandidate(candidate) && (best === null || evictsBefore(candidate, best))) best = candidate;
  }
  return best;
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
    const slot = readSlotKey(compositeKey, params.sliceAxis);
    ranked.push(slot?.chunk
      ? classifySlot(params, compositeKey, slot, slotIdx, true)
      : { key: compositeKey, class: "unsampled", dist: Infinity });
  }
  return ranked.sort((a, b) =>
    CLASS_RANK[a.class] - CLASS_RANK[b.class] ||
    a.dist - b.dist ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * One slot's class, and its distance unless `withDistance` is false or the
 * slot is unsampled. The slot's chunk must have parsed.
 */
export function classifySlot(
  params: FindEvictionParams,
  compositeKey: string,
  slot: SlotIdentity,
  slotIdx: number,
  withDistance: boolean,
): EvictionCandidate {
  const chunk = slot.chunk!;
  let sampled = false;
  let wanted = false;
  let dist = Infinity;
  for (const view of params.views) {
    if (view.slotGridIdx[slotIdx] < 0) continue;
    const target = view.targetLevelFor(slot.memberId);
    if (target !== undefined && chunk.level < target) continue;
    const lodMeta = view.entityMetas.get(slot.memberId)?.find(m => m.level === chunk.level);
    if (!lodMeta) continue;
    sampled = true;
    wanted ||= view.isWanted(slot.memberId, slot.chunkKey);
    if (withDistance) dist = Math.min(dist, viewChunkDistSq(params, view, lodMeta, slot.memberId, chunk));
  }
  if (!sampled) return { key: compositeKey, class: "unsampled", dist: Infinity };
  return { key: compositeKey, class: wanted ? "wanted" : "unwanted", dist: withDistance ? dist : 0 };
}

function viewChunkDistSq(
  params: FindEvictionParams,
  view: EvictionView,
  lodMeta: LodIndirectionMeta,
  memberId: string,
  chunk: { x: number; y: number; z: number },
): number {
  const cam = view.cameraFor(memberId);
  return params.is3D ? chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam) : chunkDistSq(lodMeta, chunk.x, chunk.y, null, cam);
}

/**
 * An arriving chunk's squared distance to the nearest camera reference of a
 * view with a section for it, the measure {@link mayEvict} weighs against a
 * wanted resident's. `Infinity` when no view lays one out.
 */
export function incomingDistSq(
  params: FindEvictionParams,
  memberId: string,
  chunk: { level: number; x: number; y: number; z: number },
): number {
  let dist = Infinity;
  for (const view of params.views) {
    const lodMeta = view.entityMetas.get(memberId)?.find(m => m.level === chunk.level);
    if (lodMeta) dist = Math.min(dist, viewChunkDistSq(params, view, lodMeta, memberId, chunk));
  }
  return dist;
}

/** Whether a wanted incoming chunk at `incomingDist` may take `victim`'s slot. */
export function mayEvict(victim: EvictionCandidate, incomingDist: number): boolean {
  return victim.class !== "wanted" || incomingDist < victim.dist;
}
