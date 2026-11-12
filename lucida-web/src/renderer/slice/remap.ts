/**
 * Slice-mode indirection remap over the shared `remapSharedIndirection`
 * kernel. Passing a `targetChunkZFor` callback turns on the Z filter and
 * selects 2D index arithmetic.
 */

import { remapSharedIndirection, type RemapEntryInfo } from "../remap.ts";
import type { VisibleRegion } from "../../pipeline/viewport.ts";
import type { ViewIndirection } from "../viewIndirection.ts";
import type { SliceAtlasState } from "./atlas.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { computeTargetChunkZ, computeTargetPlane } from "./zRetarget.ts";

/**
 * Remap one view's indirection over a slice pool to the slots holding its T,
 * the pool's channel, and the plane its Z maps to at each level.
 */
export function remapSliceIndirection(
  atlas: SliceAtlasState,
  view: ViewIndirection,
  currentT: number,
  currentC: number,
  currentZ: number,
  options: {
    visibleRegion?: VisibleRegion;
    renderRadiusView?: number;
    entryByMember?: Map<string, RemapEntryInfo>;
    failed?: ReadonlyMap<string, ReadonlySet<string>>;
    /** See `RemapParams.only`. */
    only?: ReadonlyMap<string, readonly LodIndirectionMeta[]>;
  } = {},
): void {
  remapSharedIndirection({
    slots: atlas.slots,
    slotGridIdx: view.slotGridIdx,
    indirectionData: view.indirectionData,
    entityMetas: view.entityMetas,
    currentT,
    currentC,
    visibleRegion: options.visibleRegion,
    renderRadiusView: options.renderRadiusView,
    entryByMember: options.entryByMember,
    failed: options.failed,
    only: options.only,
    sliceAxis: atlas.axis,
    targetChunkZFor: (memberId, level) =>
      computeTargetChunkZ(atlas.entityZInfo.get(memberId)?.get(level), currentZ),
    holdsCurrentPlane: (memberId, level, plane) => {
      const target = computeTargetPlane(atlas.entityZInfo.get(memberId)?.get(level), currentZ);
      return target === null || plane === target;
    },
  });
  view.dirty = true;
}
