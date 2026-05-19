/**
 * Shared indirection-remap kernel used by both `renderer/volume/remap`
 * and `renderer/slice/remap`.
 *
 * Both handlers walk the same composite-slot-key map and write a
 * slot-index back into a flat `indirectionData` Uint32Array at a
 * per-entity, per-LOD offset. They differ in exactly two ways:
 *
 *   1. **Z filter.** Slice mode passes a per-entity Z target (computed
 *      from `entityZInfo` + current full-res Z); only chunks whose
 *      `chunk.z` matches that target survive the filter. Volume has no
 *      Z filter — all chunks at the current (t, c) survive.
 *
 *   2. **Global-index arithmetic.** Volume's per-entity section is laid
 *      out as `[z][y][x]` (`gridZ * gridY * gridX` per LOD). Slice's is
 *      `[y][x]` (one 2D plane per LOD). The Z multiplier is dropped in
 *      slice mode — implemented here by branching on
 *      `targetChunkZForMember != null` (slice mode signal).
 *
 * The handlers keep their public function names (`remapIndirection` /
 * `remapSliceIndirection`); this module is the source of truth.
 *
 * No GPU coupling, no module state — safe to import from anywhere.
 */

import type { LodIndirectionMeta } from "./volume/atlas.ts";
import { parseChunkKey, parseCompositeKey } from "./chunkKeys.ts";
import type { VisibleRegion } from "../pipeline/viewport.ts";
import { chunkWithinRenderRadius } from "../pipeline/renderRadius.ts";

export interface RemapEntryInfo {
  layoutPositionVox?: [number, number];
  levels: Array<{
    level: number;
    chunkShape: [number, number, number];
    levelDims: [number, number, number];
  }>;
}

export interface RemapParams {
  /** Composite slot keys → slot indices. */
  slots: Map<string, number>;
  /** slotIndex → globalGridIdx. Reset to -1 then repopulated. */
  slotGridIdx: Int32Array;
  /** Flat indirection buffer. Cleared to 0xFFFFFFFF then repopulated. */
  indirectionData: Uint32Array;
  /** Per-entity LOD section metas. */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /** Current T plane. */
  currentT: number;
  /** Current channel. */
  currentC: number;
  /** Optional render-radius filter; omitted keeps legacy remap behavior. */
  visibleRegion?: VisibleRegion;
  renderRadiusView?: number;
  entryByMember?: Map<string, RemapEntryInfo>;
  /**
   * Slice mode: per-entity target chunk-Z (computed from currentZ +
   * the entity's Z metadata). Chunks whose `chunk.z !==` the returned
   * value are skipped. Returning `null` from the callback disables the
   * filter for that entity (no Z info yet).
   *
   * Volume mode: pass `null` to disable the Z filter entirely *and*
   * select the volume index arithmetic (Z multiplier included).
   */
  targetChunkZForMember: ((memberId: string) => number | null) | null;
}

/**
 * Walk the atlas's composite slot keys and rebuild the indirection
 * buffer so that only chunks matching `(currentT, currentC)` (and an
 * optional per-entity Z target) are visible to the shader.
 *
 * Stale chunks (kept in `slots` for fast switch-back but not currently
 * relevant) remain in the slot pool with `slotGridIdx[slot] = -1`,
 * marking them as preferred eviction candidates for the next upload.
 */
export function remapSharedIndirection(params: RemapParams): void {
  params.indirectionData.fill(0xFFFFFFFF);
  params.slotGridIdx.fill(-1);

  const isVolumeMode = params.targetChunkZForMember == null;

  for (const [compositeKey, slotIndex] of params.slots) {
    const parsedComp = parseCompositeKey(compositeKey);
    if (!parsedComp) continue;

    const lodMetas = params.entityMetas.get(parsedComp.memberId);
    if (!lodMetas) continue; // entity no longer in active set

    const chunk = parseChunkKey(parsedComp.chunkKey);
    if (!chunk) continue;
    if (chunk.t !== params.currentT) continue;
    if (chunk.c !== params.currentC) continue;

    // Slice-mode per-entity Z filter.
    if (params.targetChunkZForMember) {
      const tz = params.targetChunkZForMember(parsedComp.memberId);
      if (tz !== null && chunk.z !== tz) continue;
    }

    const meta = lodMetas.find(m => m.level === chunk.level);
    if (!meta) continue;
    if (
      params.visibleRegion &&
      params.renderRadiusView !== undefined &&
      params.entryByMember &&
      !chunkPassesRenderRadius(
        params.visibleRegion,
        params.renderRadiusView,
        params.entryByMember.get(parsedComp.memberId),
        chunk,
      )
    ) {
      continue;
    }

    const [, gridY, gridX] = meta.gridDims;
    const globalIdx = isVolumeMode
      ? meta.offset + chunk.z * gridY * gridX + chunk.y * gridX + chunk.x
      : meta.offset + chunk.y * gridX + chunk.x;
    if (globalIdx >= 0 && globalIdx < params.indirectionData.length) {
      params.indirectionData[globalIdx] = slotIndex;
      params.slotGridIdx[slotIndex] = globalIdx;
    }
  }
}

function chunkPassesRenderRadius(
  region: VisibleRegion,
  radiusView: number,
  entry: RemapEntryInfo | undefined,
  chunk: { level: number; x: number; y: number; z: number },
): boolean {
  if (!entry) return true;
  const level = entry.levels.find((l) => l.level === chunk.level);
  const level0 = entry.levels.find((l) => l.level === 0) ?? level;
  if (!level || !level0) return true;
  const [chunkZ, chunkY, chunkX] = level.chunkShape;
  return chunkWithinRenderRadius({
    region,
    radiusView,
    layoutPositionVox: entry.layoutPositionVox ?? [0, 0],
    geometry: {
      fullDims: [
        level0.levelDims[2],
        level0.levelDims[1],
        level0.levelDims[0],
      ],
      levelDims: [
        level.levelDims[2],
        level.levelDims[1],
        level.levelDims[0],
      ],
      chunkDims: [chunkX, chunkY, chunkZ],
    },
    chunk,
  });
}
