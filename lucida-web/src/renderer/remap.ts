/**
 * Indirection-remap kernel shared by `volume/remap` and `slice/remap`. Both
 * walk the composite slot keys and write slot indices into a flat
 * indirection buffer at a per-entity, per-level offset. A non-null
 * `targetChunkZFor` means slice mode: it filters chunks by Z and drops the
 * Z term from the index, since a slice section is one `[y][x]` plane.
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
  currentT: number;
  currentC: number;
  /** Optional render-radius filter; omit to skip it. */
  visibleRegion?: VisibleRegion;
  renderRadiusView?: number;
  entryByMember?: Map<string, RemapEntryInfo>;
  /**
   * Slice mode: target chunk-Z for one (member, level), computed from
   * currentZ + that level's Z metadata. Chunks whose `chunk.z !==` the
   * returned value are skipped. Returning `null` disables the filter for
   * that level (no Z info yet).
   *
   * Volume mode: pass `null` to disable the Z filter entirely *and*
   * select the volume index arithmetic (Z multiplier included).
   */
  targetChunkZFor: ((memberId: string, level: number) => number | null) | null;
  /**
   * Slice mode: whether a slot holds the plane the current Z maps to at its
   * level. A slot that fails keeps its key but stays unmapped, so the shader
   * never draws the previous plane while the re-cut one is on its way.
   */
  holdsCurrentPlane?: (memberId: string, level: number, slotIndex: number) => boolean;
}

/**
 * Walk the atlas's composite slot keys and rebuild the indirection
 * buffer so that only chunks matching `(currentT, currentC)` (and an
 * optional per-level Z target) are visible to the shader.
 *
 * Stale chunks (kept in `slots` for fast switch-back but not currently
 * relevant) remain in the slot pool with `slotGridIdx[slot] = -1`,
 * marking them as preferred eviction candidates for the next upload.
 */
export function remapSharedIndirection(params: RemapParams): void {
  params.indirectionData.fill(0xFFFFFFFF);
  params.slotGridIdx.fill(-1);

  const isVolumeMode = params.targetChunkZFor == null;

  for (const [compositeKey, slotIndex] of params.slots) {
    const parsedComp = parseCompositeKey(compositeKey);
    if (!parsedComp) continue;

    const lodMetas = params.entityMetas.get(parsedComp.memberId);
    if (!lodMetas) continue; // entity no longer in active set

    const chunk = parseChunkKey(parsedComp.chunkKey);
    if (!chunk) continue;
    if (chunk.t !== params.currentT) continue;
    if (chunk.c !== params.currentC) continue;

    // Slice-mode Z filter, per level: the levels sharing a pool can
    // differ in depth and chunk Z.
    if (params.targetChunkZFor) {
      const tz = params.targetChunkZFor(parsedComp.memberId, chunk.level);
      if (tz !== null && chunk.z !== tz) continue;
    }
    if (
      params.holdsCurrentPlane &&
      !params.holdsCurrentPlane(parsedComp.memberId, chunk.level, slotIndex)
    ) {
      continue;
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
