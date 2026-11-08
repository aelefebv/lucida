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

/** An indirection entry for a cell with nothing resident. Matches `MISS` in the shaders. */
export const INDIRECTION_MISS = 0xffffffff;

/**
 * An indirection entry for a cell whose chunk the source failed for good.
 * Matches `FAILED` in the shaders, which draw it hatched, since black would
 * read as data that is zero. No slot index reaches it.
 */
export const INDIRECTION_FAILED = 0xfffffffe;

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
  /** Flat indirection buffer. Cleared to {@link INDIRECTION_MISS} then repopulated. */
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
  /**
   * memberId → wanted chunk keys the source failed for good. Each one's cell
   * reads {@link INDIRECTION_FAILED} unless a resident slot holds it.
   */
  failed?: ReadonlyMap<string, ReadonlySet<string>>;
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
  params.indirectionData.fill(INDIRECTION_MISS);
  params.slotGridIdx.fill(-1);

  for (const [compositeKey, slotIndex] of params.slots) {
    const parsedComp = parseCompositeKey(compositeKey);
    if (!parsedComp) continue;

    const chunk = parseChunkKey(parsedComp.chunkKey);
    if (!chunk) continue;
    const meta = currentSection(params, parsedComp.memberId, chunk);
    if (!meta) continue;
    if (
      params.holdsCurrentPlane &&
      !params.holdsCurrentPlane(parsedComp.memberId, chunk.level, slotIndex)
    ) {
      continue;
    }
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

    const globalIdx = cellIndex(params, meta, chunk);
    if (globalIdx >= 0 && globalIdx < params.indirectionData.length) {
      params.indirectionData[globalIdx] = slotIndex;
      params.slotGridIdx[slotIndex] = globalIdx;
    }
  }

  if (!params.failed) return;
  for (const [memberId, chunkKeys] of params.failed) {
    for (const chunkKey of chunkKeys) {
      const chunk = parseChunkKey(chunkKey);
      if (!chunk) continue;
      const meta = currentSection(params, memberId, chunk);
      if (!meta) continue;
      const globalIdx = cellIndex(params, meta, chunk);
      if (params.indirectionData[globalIdx] === INDIRECTION_MISS) {
        params.indirectionData[globalIdx] = INDIRECTION_FAILED;
      }
    }
  }
}

type ChunkCoords = NonNullable<ReturnType<typeof parseChunkKey>>;

/**
 * The section a chunk of `memberId` draws from now, or null when the chunk
 * is for another T, C or plane, or the member holds no section at its level.
 */
function currentSection(
  params: RemapParams,
  memberId: string,
  chunk: ChunkCoords,
): LodIndirectionMeta | null {
  const lodMetas = params.entityMetas.get(memberId);
  if (!lodMetas) return null; // entity no longer in active set
  if (chunk.t !== params.currentT || chunk.c !== params.currentC) return null;
  // Slice-mode Z filter, per level: the levels sharing a pool can
  // differ in depth and chunk Z.
  if (params.targetChunkZFor) {
    const tz = params.targetChunkZFor(memberId, chunk.level);
    if (tz !== null && chunk.z !== tz) return null;
  }
  return lodMetas.find(m => m.level === chunk.level) ?? null;
}

/** A chunk's entry in the flat indirection. A slice section is one `[y][x]` plane. */
function cellIndex(params: RemapParams, meta: LodIndirectionMeta, chunk: ChunkCoords): number {
  const [, gridY, gridX] = meta.gridDims;
  return params.targetChunkZFor == null
    ? meta.offset + chunk.z * gridY * gridX + chunk.y * gridX + chunk.x
    : meta.offset + chunk.y * gridX + chunk.x;
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
