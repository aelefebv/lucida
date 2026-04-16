/**
 * Wanted-set computation — pure function that diffs expected chunks against
 * actual atlas contents to determine what the GPU worker is missing.
 */

import type { ColdStateMessage } from "./workerProtocol.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal atlas state interface — only the fields needed for wanted-set computation. */
export interface AtlasSnapshot {
  z?: number; // only for slice atlases
  slots: Map<string, number>; // chunkKey -> slotIndex
  lodMetas: Array<{
    level: number;
    gridDims: [number, number, number];   // [Z, Y, X]
    chunkDims: [number, number, number];  // [Z, Y, X]
    offset: number;
  }>;
}

export interface WantedSetResult {
  missing: Array<{ entityId: string; chunkKey: string }>;
}

// ---------------------------------------------------------------------------
// computeWantedSet()
// ---------------------------------------------------------------------------

/**
 * Compute which chunks the GPU worker is missing by diffing expected chunks
 * (derived from cold state + visible region) against actual atlas contents.
 *
 * Pure function — no side effects, no GPU dependencies.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
): WantedSetResult {
  const missing: Array<{ entityId: string; chunkKey: string }> = [];

  if (coldState.activeSet.length === 0) {
    return { missing };
  }

  const isMultiChannel = coldState.visibleChannels.length > 1;
  const atlases =
    coldState.viewMode === "volume" ? volumeAtlases : sliceAtlases;

  for (const entry of coldState.activeSet) {
    // Build the list of (workerMemberId, channel) pairs for this entry.
    const members: Array<{ memberId: string; channel: number }> = [];
    if (isMultiChannel) {
      for (const c of coldState.visibleChannels) {
        members.push({ memberId: `${entry.imageId}:ch${c}`, channel: c });
      }
    } else {
      members.push({
        memberId: entry.imageId,
        channel: coldState.visibleChannels[0],
      });
    }

    for (const { memberId, channel } of members) {
      const atlas = atlases.get(memberId);
      if (atlas === undefined) continue; // atlas config hasn't arrived yet

      // Build a lookup for which levels the atlas actually covers.
      const atlasLodByLevel = new Map(
        atlas.lodMetas.map((m) => [m.level, m]),
      );

      // Iterate all detail-owned LODs for this entry.
      const [finest, coarsest] = entry.detailOwnedLodRange;
      for (let lvl = finest; lvl <= coarsest; lvl++) {
        // Atlas must cover this level.
        if (!atlasLodByLevel.has(lvl)) continue;

        // Find cold-state level metadata for enumeration bounds.
        const levelMeta = entry.levels.find((l) => l.level === lvl);
        if (levelMeta === undefined) continue;

        const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        const [gridZ, gridY, gridX] = levelMeta.gridShape;

        // Compute chunk coordinate bounds from visible region.
        const [minVoxX, minVoxY, maxVoxX, maxVoxY] =
          coldState.visibleRegion.xyBounds;

        const colStart = Math.max(0, Math.floor(minVoxX / chunkX));
        const colEnd = Math.min(gridX, Math.ceil(maxVoxX / chunkX));
        const rowStart = Math.max(0, Math.floor(minVoxY / chunkY));
        const rowEnd = Math.min(gridY, Math.ceil(maxVoxY / chunkY));

        let zStart: number;
        let zEnd: number;

        if (coldState.viewMode === "slice") {
          // Single slice: only the chunk containing the current Z
          const sliceZ = atlas.z ?? 0;
          const chunkIdx = Math.floor(sliceZ / chunkZ);
          zStart = Math.max(0, chunkIdx);
          zEnd = Math.min(gridZ, chunkIdx + 1);
        } else {
          // Volume: Z range from visible region
          zStart = Math.max(0, Math.floor(coldState.visibleRegion.zRange[0] / chunkZ));
          zEnd = Math.min(gridZ, Math.ceil(coldState.visibleRegion.zRange[1] / chunkZ));
        }

        // Enumerate expected chunks and check atlas residency.
        for (let iz = zStart; iz < zEnd; iz++) {
          for (let iy = rowStart; iy < rowEnd; iy++) {
            for (let ix = colStart; ix < colEnd; ix++) {
              const key = `${lvl}/${coldState.currentT}/${channel}/${iz}/${iy}/${ix}`;
              if (!atlas.slots.has(key)) {
                missing.push({ entityId: entry.entityId, chunkKey: key });
              }
            }
          }
        }
      }
    }
  }

  return { missing };
}
