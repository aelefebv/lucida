/**
 * Volume-mode indirection remap over the shared `remapSharedIndirection`
 * kernel. `targetChunkZFor: null` turns off the Z filter and selects 3D index
 * arithmetic.
 */

import { remapSharedIndirection, type RemapEntryInfo } from "../remap.ts";
import type { VisibleRegion } from "../../pipeline/viewport.ts";
import type { ViewIndirection } from "../viewIndirection.ts";
import type { AtlasState, LodIndirectionMeta } from "./atlas.ts";

/**
 * Remap one view's indirection over a volume pool to the chunks matching its
 * T and the pool's channel. Other chunks stay in `atlas.slots`, unmapped here.
 */
export function remapIndirection(
  atlas: AtlasState,
  view: ViewIndirection,
  currentT: number,
  currentC: number,
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
    targetChunkZFor: null,
  });
  view.dirty = true;
}
