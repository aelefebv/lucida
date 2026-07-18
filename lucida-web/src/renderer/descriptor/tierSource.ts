/** Canonical serializer for the shader-facing `ChunkTierSource` record. */

import type { LodIndirectionMeta } from "../volume/atlas.ts";
import {
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_PAD0,
  SOURCE_OFFSET_VALID,
} from "./layout.ts";

/**
 * Write one explicit detail/coarse source into an entity descriptor.
 *
 * `LodIndirectionMeta` uses the pipeline's `[Z, Y, X]` convention; the
 * descriptor and WGSL use `[X, Y, Z]`. Keeping that conversion here makes
 * both canonical and transient descriptor writers share the exact same
 * 64-byte serialization and invalid-source clearing behavior.
 */
export function writeChunkTierSource(
  u32: Uint32Array,
  offsetBytes: number,
  meta: LodIndirectionMeta | undefined,
): void {
  const base = offsetBytes / 4;
  if (!meta) {
    for (let i = 0; i < 16; i++) u32[base + i] = 0;
    return;
  }

  const [gZ, gY, gX] = meta.gridDims;
  const [cZ, cY, cX] = meta.chunkDims;
  const [lZ, lY, lX] = meta.levelDims;

  u32[base + SOURCE_OFFSET_VALID / 4] = 1;
  u32[base + SOURCE_OFFSET_LEVEL / 4] = meta.level;
  u32[base + SOURCE_OFFSET_INDIRECTION_OFFSET / 4] = meta.offset;
  u32[base + SOURCE_OFFSET_PAD0 / 4] = 0;

  const gridBase = base + SOURCE_OFFSET_GRID_DIMS / 4;
  u32[gridBase + 0] = gX;
  u32[gridBase + 1] = gY;
  u32[gridBase + 2] = gZ;
  u32[gridBase + 3] = 0;

  const chunkBase = base + SOURCE_OFFSET_CHUNK_DIMS / 4;
  u32[chunkBase + 0] = cX;
  u32[chunkBase + 1] = cY;
  u32[chunkBase + 2] = cZ;
  u32[chunkBase + 3] = 0;

  const levelBase = base + SOURCE_OFFSET_LEVEL_DIMS / 4;
  u32[levelBase + 0] = lX;
  u32[levelBase + 1] = lY;
  u32[levelBase + 2] = lZ;
  u32[levelBase + 3] = 0;
}
