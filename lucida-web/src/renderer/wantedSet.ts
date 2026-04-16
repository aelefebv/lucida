/**
 * Wanted-set computation — pure function that diffs expected chunks against
 * actual atlas contents to determine what the GPU worker is missing.
 */

import type { ColdStateMessage } from "./workerProtocol.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-LOD metadata for an entity in a shared pool. */
export interface AtlasLodMeta {
  level: number;
  gridDims: [number, number, number];   // [Z, Y, X]
  chunkDims: [number, number, number];  // [Z, Y, X]
  offset: number;
}

/** Minimal shared-pool atlas state for wanted-set computation. */
export interface AtlasSnapshot {
  z?: number; // only for slice atlases (single-entity for now until SP-3)
  /** Slots keyed by composite "memberId|chunkKey" (volume) or plain chunkKey (slice). */
  slots: Map<string, number>;
  /** Per-entity LOD sections (volume shared pool). */
  entityMetas?: Map<string, AtlasLodMeta[]>;
  /** Single-entity LOD metas (slice — until SP-3 makes slice shared too). */
  lodMetas?: AtlasLodMeta[];
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
  memberToPool?: Map<string, string>,
): WantedSetResult {
  const missing: Array<{ entityId: string; chunkKey: string }> = [];

  if (coldState.activeSet.length === 0) {
    return { missing };
  }

  const isMultiChannel = coldState.visibleChannels.length > 1;

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
      // Look up atlas. Volume uses shared pools (keyed by poolKey from memberToPool).
      // Slice still uses per-member atlases (keyed by memberId) until SP-3.
      let atlas: AtlasSnapshot | undefined;
      let entityLodMetas: AtlasLodMeta[] | undefined;
      let useCompositeKey = false;

      if (coldState.viewMode === "volume") {
        const poolKey = memberToPool?.get(memberId);
        if (!poolKey) continue;
        atlas = volumeAtlases.get(poolKey);
        if (atlas === undefined) continue;
        entityLodMetas = atlas.entityMetas?.get(memberId);
        if (entityLodMetas === undefined) continue;
        useCompositeKey = true;
      } else {
        atlas = sliceAtlases.get(memberId);
        if (atlas === undefined) continue;
        entityLodMetas = atlas.lodMetas;
        if (entityLodMetas === undefined) continue;
      }

      const atlasLodByLevel = new Map(entityLodMetas.map((m) => [m.level, m]));

      // Iterate all detail-owned LODs for this entry.
      const [finest, coarsest] = entry.detailOwnedLodRange;
      for (let lvl = finest; lvl <= coarsest; lvl++) {
        if (!atlasLodByLevel.has(lvl)) continue;

        const levelMeta = entry.levels.find((l) => l.level === lvl);
        if (levelMeta === undefined) continue;

        const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        const [gridZ, gridY, gridX] = levelMeta.gridShape;

        const [minVoxX, minVoxY, maxVoxX, maxVoxY] =
          coldState.visibleRegion.xyBounds;

        const colStart = Math.max(0, Math.floor(minVoxX / chunkX));
        const colEnd = Math.min(gridX, Math.ceil(maxVoxX / chunkX));
        const rowStart = Math.max(0, Math.floor(minVoxY / chunkY));
        const rowEnd = Math.min(gridY, Math.ceil(maxVoxY / chunkY));

        let zStart: number;
        let zEnd: number;

        if (coldState.viewMode === "slice") {
          const sliceZ = atlas.z ?? 0;
          const chunkIdx = Math.floor(sliceZ / chunkZ);
          zStart = Math.max(0, chunkIdx);
          zEnd = Math.min(gridZ, chunkIdx + 1);
        } else {
          zStart = Math.max(0, Math.floor(coldState.visibleRegion.zRange[0] / chunkZ));
          zEnd = Math.min(gridZ, Math.ceil(coldState.visibleRegion.zRange[1] / chunkZ));
        }

        for (let iz = zStart; iz < zEnd; iz++) {
          for (let iy = rowStart; iy < rowEnd; iy++) {
            for (let ix = colStart; ix < colEnd; ix++) {
              const chunkKey = `${lvl}/${coldState.currentT}/${channel}/${iz}/${iy}/${ix}`;
              const slotKey = useCompositeKey ? `${memberId}|${chunkKey}` : chunkKey;
              if (!atlas.slots.has(slotKey)) {
                missing.push({ entityId: entry.entityId, chunkKey });
              }
            }
          }
        }
      }
    }
  }

  return { missing };
}
