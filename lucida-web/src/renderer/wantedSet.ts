/**
 * Wanted-set computation — pure function that diffs expected chunks against
 * actual atlas contents to determine what the GPU worker is missing.
 */

import type {
  ColdStateMessage,
  MissingChunk,
} from "./workerProtocol.ts";
import {
  RENDER_RADIUS_DISABLED,
  chunkWithinRenderRadius,
} from "../pipeline/renderRadius.ts";
import { makeCompositeKey } from "./chunkKeys.ts";
import { memberIdForColdEntry } from "./descriptorBuffer.ts";
import { memberTierKey, type ChunkTier } from "./poolKeys.ts";

/** Per-LOD metadata for an entity in a shared pool. */
export interface AtlasLodMeta {
  level: number;
  gridDims: [number, number, number];   // [Z, Y, X]
  chunkDims: [number, number, number];  // [Z, Y, X]
  offset: number;
}

/** Minimal shared-pool atlas state for wanted-set computation. */
export interface AtlasSnapshot {
  z?: number; // only for slice atlases
  /** Slots keyed by composite "memberId|chunkKey" (volume) or plain chunkKey (slice). */
  slots: Map<string, number>;
  /** Per-entity LOD sections (volume shared pool). */
  entityMetas?: Map<string, AtlasLodMeta[]>;
  /** Single-entity LOD metas (slice). */
  lodMetas?: AtlasLodMeta[];
}

export interface WantedSetResult {
  missing: MissingChunk[];
}

/**
 * Compute which chunks the GPU worker is missing.
 *
 * Pure function — no side effects, no GPU dependencies.
 *
 * Chunk wanted-set rules: for each detail-owned LOD on each visible
 * channel, enumerate the visible-region grid cells and report any
 * whose composite slot key is missing.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
  memberTierToPool?: Map<string, string>,
): WantedSetResult {
  const missing: MissingChunk[] = [];

  if (coldState.activeSet.length === 0) {
    return { missing };
  }

  const isMultiChannel = coldState.multiChannel;

  for (const entry of coldState.activeSet) {
    // Chunk wanted-set.
    const members: Array<{ memberId: string; channel: number }> = [];
    if (isMultiChannel) {
      for (const c of coldState.visibleChannels) {
        members.push({
          memberId: memberIdForColdEntry(entry, c, true),
          channel: c,
        });
      }
    } else {
      const channel = coldState.visibleChannels[0];
      members.push({
        memberId: memberIdForColdEntry(entry, channel, false),
        channel,
      });
    }

    for (const { memberId, channel } of members) {
      for (const source of chunkSourcesForEntry(entry)) {
        let atlas: AtlasSnapshot | undefined;
        let entityLodMetas: AtlasLodMeta[] | undefined;
        let useCompositeKey = false;

        const tierPoolKey =
          memberTierToPool?.get(memberTierKey(memberId, source.tier)) ??
          memberTierToPool?.get(memberId);
        if (!tierPoolKey) continue;

        if (coldState.viewMode === "volume") {
          atlas = volumeAtlases.get(tierPoolKey);
          if (atlas === undefined) continue;
          entityLodMetas = atlas.entityMetas?.get(memberId);
          if (entityLodMetas === undefined) continue;
          useCompositeKey = true;
        } else {
          atlas = sliceAtlases.get(tierPoolKey);
          if (atlas === undefined) continue;
          entityLodMetas = atlas.entityMetas?.get(memberId);
          if (entityLodMetas === undefined) continue;
          useCompositeKey = true;
        }

        const atlasLodByLevel = new Map(entityLodMetas.map((m) => [m.level, m]));

        for (const lvl of source.levels) {
          if (!atlasLodByLevel.has(lvl)) continue;

          const levelMeta = entry.levels.find((l) => l.level === lvl);
          if (levelMeta === undefined) continue;

          const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
          const [gridZ, gridY, gridX] = levelMeta.gridShape;
          const level0Meta = entry.levels.find((l) => l.level === 0);
          const fullDims = [
            level0Meta?.levelDims[2] ?? levelMeta.levelDims[2],
            level0Meta?.levelDims[1] ?? levelMeta.levelDims[1],
            level0Meta?.levelDims[0] ?? levelMeta.levelDims[0],
          ] as [number, number, number];
          const levelDims = [
            levelMeta.levelDims[2],
            levelMeta.levelDims[1],
            levelMeta.levelDims[0],
          ] as [number, number, number];
          const chunkWorldX = chunkX * (fullDims[0] / Math.max(1, levelDims[0]));
          const chunkWorldY = chunkY * (fullDims[1] / Math.max(1, levelDims[1]));
          const chunkWorldZ = chunkZ * (fullDims[2] / Math.max(1, levelDims[2]));

          const [minVoxX, minVoxY, maxVoxX, maxVoxY] =
            coldState.visibleRegion.xyBoundsVox;
          const layoutPositionVox = entry.layoutPositionVox ?? ([0, 0] as [number, number]);
          const localMinVoxX = minVoxX - layoutPositionVox[0];
          const localMinVoxY = minVoxY - layoutPositionVox[1];
          const localMaxVoxX = maxVoxX - layoutPositionVox[0];
          const localMaxVoxY = maxVoxY - layoutPositionVox[1];

          const colStart = Math.max(0, Math.floor(localMinVoxX / chunkWorldX));
          const colEnd = Math.min(gridX, Math.ceil(localMaxVoxX / chunkWorldX));
          const rowStart = Math.max(0, Math.floor(localMinVoxY / chunkWorldY));
          const rowEnd = Math.min(gridY, Math.ceil(localMaxVoxY / chunkWorldY));

          let zStart: number;
          let zEnd: number;

          if (coldState.viewMode === "slice") {
            const sliceZ = atlas.z ?? 0;
            const chunkIdx = Math.floor(sliceZ / chunkZ);
            zStart = Math.max(0, chunkIdx);
            zEnd = Math.min(gridZ, chunkIdx + 1);
          } else {
            zStart = Math.max(0, Math.floor(coldState.visibleRegion.zRangeVox[0] / chunkWorldZ));
            zEnd = Math.min(gridZ, Math.ceil(coldState.visibleRegion.zRangeVox[1] / chunkWorldZ));
          }

          const radiusView = renderRadiusForTier(coldState, source.tier);
          for (let iz = zStart; iz < zEnd; iz++) {
            for (let iy = rowStart; iy < rowEnd; iy++) {
              for (let ix = colStart; ix < colEnd; ix++) {
                if (
                  !chunkWithinRenderRadius({
                    region: coldState.visibleRegion,
                    radiusView,
                    layoutPositionVox,
                    geometry: {
                      fullDims,
                      levelDims,
                      chunkDims: [chunkX, chunkY, chunkZ],
                    },
                    chunk: { x: ix, y: iy, z: iz },
                  })
                ) {
                  continue;
                }
                const chunkKey = `${lvl}/${coldState.currentT}/${channel}/${iz}/${iy}/${ix}`;
                const slotKey = useCompositeKey ? makeCompositeKey(memberId, chunkKey) : chunkKey;
                if (!atlas.slots.has(slotKey)) {
                  missing.push({
                    kind: "chunk",
                    datasetId: coldState.datasetId,
                    tier: source.tier,
                    entityId: entry.entityId,
                    memberId,
                    c: channel,
                    chunkKey,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return { missing };
}

function renderRadiusForTier(
  coldState: ColdStateMessage,
  tier: ChunkTier,
): number {
  return coldState.renderRadiusView?.[tier] ?? RENDER_RADIUS_DISABLED;
}

function chunkSourcesForEntry(
  entry: ColdStateMessage["activeSet"][number],
): Array<{ tier: ChunkTier; levels: number[] }> {
  const sources: Array<{ tier: ChunkTier; levels: number[] }> = [
    { tier: "detail", levels: [entry.detailLevel] },
  ];
  if (
    entry.coarseLevel !== null
  ) {
    sources.push({ tier: "coarse", levels: [entry.coarseLevel] });
  }
  return sources;
}
