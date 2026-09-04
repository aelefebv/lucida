/**
 * Slice-mode indirection remap (thin wrapper).
 *
 * Delegates to the shared `remapSharedIndirection` kernel. Slice mode
 * passes a per-(member, level) `targetChunkZFor` callback to (a) enable
 * the Z filter (chunks whose `chunk.z !==` the returned target are
 * skipped) and (b) select slice index arithmetic (Z multiplier
 * dropped).
 */

import { remapSharedIndirection, type RemapEntryInfo } from "../remap.ts";
import type { VisibleRegion } from "../../pipeline/viewport.ts";
import type { SliceAtlasState } from "./atlas.ts";
import { computeTargetChunkZ } from "./zRetarget.ts";

/**
 * Remap the 2D indirection buffer for the current state.
 * Walks composite slot keys, looks up each (member, level) section + Z
 * info, and writes chunks matching current T/C and that level's target Z
 * into the section.
 */
export function remapSliceIndirection(
  atlas: SliceAtlasState,
  currentT: number,
  currentC: number,
  currentZ: number,
  options: {
    visibleRegion?: VisibleRegion;
    renderRadiusView?: number;
    entryByMember?: Map<string, RemapEntryInfo>;
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
    targetChunkZFor: (memberId, level) =>
      computeTargetChunkZ(atlas.entityZInfo.get(memberId)?.get(level), currentZ),
  });
  atlas.indirectionDirty = true;
}
