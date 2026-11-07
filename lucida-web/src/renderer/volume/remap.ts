/**
 * Volume-mode indirection remap over the shared `remapSharedIndirection`
 * kernel. `targetChunkZFor: null` turns off the Z filter and selects 3D index
 * arithmetic.
 */

import { remapSharedIndirection, type RemapEntryInfo } from "../remap.ts";
import type { VisibleRegion } from "../../pipeline/viewport.ts";
import type { AtlasState } from "./atlas.ts";

/**
 * Remap the indirection buffer to the chunks matching current T/C. Other
 * chunks stay in `atlas.slots` but are unmapped.
 */
export function remapIndirection(
  atlas: AtlasState,
  currentT: number,
  currentC: number,
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
    targetChunkZFor: null,
  });
  atlas.indirectionDirty = true;
}
