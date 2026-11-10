/**
 * Slice-mode indirection remap over the shared `remapSharedIndirection`
 * kernel. Passing a `targetChunkZFor` callback turns on the Z filter and
 * selects 2D index arithmetic.
 */

import { remapSharedIndirection, type RemapEntryInfo } from "../remap.ts";
import type { VisibleRegion } from "../../pipeline/viewport.ts";
import type { SliceAtlasState } from "./atlas.ts";
import { computeTargetChunkZ, computeTargetPlane } from "./zRetarget.ts";

/** Remap the 2D indirection buffer to the chunks matching current T/C and each level's target Z. */
export function remapSliceIndirection(
  atlas: SliceAtlasState,
  currentT: number,
  currentC: number,
  currentZ: number,
  options: {
    visibleRegion?: VisibleRegion;
    renderRadiusView?: number;
    entryByMember?: Map<string, RemapEntryInfo>;
    failed?: ReadonlyMap<string, ReadonlySet<string>>;
  } = {},
): void {
  remapSharedIndirection({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    indirectionData: atlas.indirectionData,
    entityMetas: atlas.entityMetas,
    currentT,
    currentC,
    visibleRegion: options.visibleRegion,
    renderRadiusView: options.renderRadiusView,
    entryByMember: options.entryByMember,
    failed: options.failed,
    sliceAxis: atlas.axis,
    targetChunkZFor: (memberId, level) =>
      computeTargetChunkZ(atlas.entityZInfo.get(memberId)?.get(level), currentZ),
    holdsCurrentPlane: (memberId, level, slotIndex) => {
      const plane = computeTargetPlane(atlas.entityZInfo.get(memberId)?.get(level), currentZ);
      return plane === null || atlas.slotLevelZ[slotIndex] === plane;
    },
  });
  atlas.indirectionDirty = true;
}
