/**
 * Lookups over the worker's view draws (`ViewDraw` in `state.ts`): which views
 * draw a dataset, which pool a delivery lands in, and what the views drawing
 * from one pool want of it.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { PoolMode } from "../workerProtocol.ts";
import type { SpatialAxis } from "../slicePlane.ts";
import type { SharedChunkPool } from "../viewIndirection.ts";
import type { EvictionView } from "../eviction.ts";
import { datasetViewKey, sourceKey } from "../poolKeys.ts";
import { wantedEntryKey } from "../wantedChunks.ts";
import type { RendererState, ViewDraw } from "./state.ts";

/** The draw of `datasetId` in `view`, if the view draws it. */
export function drawOf(state: RendererState, datasetId: string, view: number): ViewDraw | undefined {
  return state.draws.get(datasetViewKey(datasetId, view));
}

/** Every view's draw of `datasetId`, those of `mode` alone when given. */
export function drawsOf(state: RendererState, datasetId: string, mode?: PoolMode): ViewDraw[] {
  const out: ViewDraw[] = [];
  for (const draw of state.draws.values()) {
    if (draw.datasetId === datasetId && (mode === undefined || draw.mode === mode)) out.push(draw);
  }
  return out;
}

/**
 * The pool a delivery of one member's (tier, level) lands in: the one a view
 * of `mode` routes it to, a slice pool cut along `axis` first. Views of one
 * mode route a level to the same pool, since a pool's key is the dataset,
 * channel, chunk shape, axis and tier. Undefined when no view lays out a
 * section for it.
 */
export function routeOf(
  state: RendererState,
  mode: PoolMode,
  memberId: string,
  tier: ResidencyTier,
  level: number,
  axis?: SpatialAxis,
): string | undefined {
  const datasetId = state.memberToDataset.get(memberId);
  if (datasetId === undefined) return undefined;
  const source = sourceKey(tier, level);
  let found: string | undefined;
  for (const draw of drawsOf(state, datasetId, mode)) {
    const poolKey = draw.routes.get(memberId)?.get(source);
    if (poolKey === undefined) continue;
    if (axis === undefined || state.sliceAtlases.get(poolKey)?.axis === axis) return poolKey;
    found ??= poolKey;
  }
  return found;
}

/** Whether a view drawing from `pool` wants one member's chunk in `tier`. */
export function anyViewWants(pool: SharedChunkPool, memberId: string, tier: ResidencyTier, chunkKey: string): boolean {
  const key = wantedEntryKey(tier, memberId);
  for (const view of pool.views.values()) {
    if (view.draw.wanted.get(key)?.has(chunkKey)) return true;
  }
  return false;
}

/** How many chunks of one member in `tier` the views drawing from `pool` want between them. */
export function wantedCountIn(pool: SharedChunkPool, memberId: string, tier: ResidencyTier): number {
  const key = wantedEntryKey(tier, memberId);
  let only: ReadonlySet<string> | undefined;
  let union: Set<string> | undefined;
  for (const view of pool.views.values()) {
    const keys = view.draw.wanted.get(key);
    if (!keys || keys === only) continue;
    if (only === undefined) {
      only = keys;
      continue;
    }
    union ??= new Set(only);
    for (const chunkKey of keys) union.add(chunkKey);
  }
  return union?.size ?? only?.size ?? 0;
}

/**
 * What eviction reads of each view drawing from `pool` in `tier`, its camera
 * references read through `cameraFor` at `cameraRevision`.
 */
export function evictionViewsOf(
  pool: SharedChunkPool,
  tier: ResidencyTier,
  cameraFor: (view: number, memberId: string) => [number, number] | [number, number, number],
  cameraRevision: number,
): EvictionView[] {
  return [...pool.views.values()].map((view) => {
    const { wanted, targetLevels } = view.draw;
    // Each member's keys are looked up once: a full pool asks about every slot.
    const byMember = new Map<string, ReadonlySet<string> | undefined>();
    const wantedOf = (memberId: string): ReadonlySet<string> | undefined => {
      if (!byMember.has(memberId)) byMember.set(memberId, wanted.get(wantedEntryKey(tier, memberId)));
      return byMember.get(memberId);
    };
    return {
      slotGridIdx: view.slotGridIdx,
      entityMetas: view.entityMetas,
      cameraFor: (memberId) => cameraFor(view.draw.view, memberId),
      targetLevelFor: (memberId) => targetLevels.get(memberId),
      isWanted: (memberId, chunkKey) => wantedOf(memberId)?.has(chunkKey) ?? false,
      sources: [wanted, targetLevels, cameraRevision],
    };
  });
}
