/**
 * Volume-mode indirection remap (thin wrapper).
 *
 * Delegates to the shared `remapSharedIndirection` kernel. Volume mode
 * passes `targetChunkZFor: null` to (a) disable the Z filter and
 * (b) select volume index arithmetic (Z multiplier included).
 */

import { remapSharedIndirection, type RemapEntryInfo } from "../remap.ts";
import type { VisibleRegion } from "../../pipeline/viewport.ts";
import type { AtlasState } from "./atlas.ts";

/**
 * Remap the indirection buffer to show only chunks matching the current state.
 * Iterates composite slot keys, looks up each entity's lodMetas, and writes
 * chunks into the correct per-entity per-LOD section. Chunks for other T/C
 * or entities not in entityMetas remain in atlas.slots but are unmapped.
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
