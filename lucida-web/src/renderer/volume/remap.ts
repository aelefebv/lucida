/**
 * Volume-mode indirection remap (thin wrapper).
 *
 * Delegates to the shared `remapSharedIndirection` kernel. Volume mode
 * passes `targetChunkZForMember: null` to (a) disable the Z filter and
 * (b) select volume index arithmetic (Z multiplier included).
 */

import { remapSharedIndirection } from "../remap.ts";
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
): void {
  remapSharedIndirection({
    slots: atlas.slots,
    slotGridIdx: atlas.slotGridIdx,
    indirectionData: atlas.indirectionData,
    entityMetas: atlas.entityMetas,
    currentT,
    currentC,
    targetChunkZForMember: null,
  });
  atlas.indirectionDirty = true;
}
