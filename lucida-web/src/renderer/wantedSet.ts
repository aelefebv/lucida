/**
 * Wanted-set computation — pure function that diffs expected chunks against
 * actual atlas contents to determine what the GPU worker is missing.
 *
 * Reports missing chunks and missing proxy assets via a discriminated
 * union (`MissingChunk | MissingProxy`).
 */

import type {
  ColdStateMessage,
  MissingChunk,
  MissingProxy,
} from "./workerProtocol.ts";
import type { ProxyKind } from "../pipeline/assetCatalog.ts";
import {
  RENDER_RADIUS_DISABLED,
  chunkWithinRenderRadius,
} from "../pipeline/renderRadius.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { makeCompositeKey } from "./chunkKeys.ts";
import { memberIdForColdEntry } from "./descriptorBuffer.ts";
import { memberTierKey } from "./poolKeys.ts";

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

/**
 * Minimal per-pool view of proxy residency for wanted-set queries.
 * Independent from `ProxyAtlasState` so this module stays GPU-free.
 *
 * The map key is the composite slot key `${entityId}|${t}|${c}` —
 * matches `proxySlotKey()` in `./proxyAtlas.ts`. `kind` is carried so
 * residency checks distinguish `GroupProxy3D` vs `TileProxy3D` pools
 * for entities that could appear as either (a defensive safeguard;
 * pool keying already separates them in practice).
 */
export interface ProxyAtlasSnapshot {
  kind: ProxyKind;
  slots: Map<string, number>;
}

export interface WantedSetResult {
  missing: Array<MissingChunk | MissingProxy>;
}

/**
 * Compute which chunks AND proxies the GPU worker is missing.
 *
 * Pure function — no side effects, no GPU dependencies.
 *
 * Chunk wanted-set rules: for each level a tier holds on each visible
 * channel, enumerate the visible-region grid cells and report any
 * whose composite slot key is missing.
 *
 * Proxy wanted-set rules: for each cold-state active entry, walk its
 * `mode`:
 *
 *   - `group-as-proxy` (entry.entityId IS the groupId)
 *       → emit a `MissingProxy { kind: GroupProxy3D }` per visible
 *         channel if the group's slot isn't resident.
 *   - `tiles-with-proxy-fallback` (entry.entityId is the tileId)
 *       → emit a `MissingProxy { kind: TileProxy3D }` for the tile
 *         per channel (if `proxyAvailable`), and a single
 *         `MissingProxy { kind: GroupProxy3D }` for the parent group per
 *         channel (if `groupProxyAvailable` and `parentGroupId` is set).
 *         Parent-group requests are deduped per (parentGroupId, t, c).
 *   - `tiles-with-detail`
 *       → existing chunk wanted-set + a per-channel tile-proxy
 *         request when the catalog advertises one but it isn't yet
 *         resident.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
  memberTierToPool?: Map<string, string>,
  proxyAtlases?: Map<string, ProxyAtlasSnapshot>,
): WantedSetResult {
  const missing: Array<MissingChunk | MissingProxy> = [];
  const desiredProxyKeys =
    coldState.desiredProxyKeys === undefined
      ? null
      : new Set(coldState.desiredProxyKeys);

  if (coldState.activeSet.length === 0) {
    return { missing };
  }

  const isMultiChannel = coldState.multiChannel;

  // Dedup per (groupId, t, c) so multiple tile entries of the same
  // parent only emit one parent-group-proxy request.
  const groupProxyEmitted = new Set<string>();

  for (const entry of coldState.activeSet) {
    // Proxy wanted-set. `entry.kind` discriminates so the tile
    // branches see the tile variant typed-out.
    if (entry.kind === "group-as-proxy") {
      for (const c of coldState.visibleChannels) {
        if (
          isProxyDesired(desiredProxyKeys, coldState.datasetId, entry.entityId, "GroupProxy3D", coldState.currentT, c) &&
          !isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "GroupProxy3D")
        ) {
          missing.push({
            kind: "proxy",
            datasetId: coldState.datasetId,
            entityId: entry.entityId,
            proxyKind: "GroupProxy3D",
            t: coldState.currentT,
            c,
          });
        }
      }
      continue;
    }

    if (entry.mode === "tiles-with-proxy-fallback") {
      if (entry.proxyAvailable && entry.proxyKind === "TileProxy3D") {
        for (const c of coldState.visibleChannels) {
          if (
            isProxyDesired(desiredProxyKeys, coldState.datasetId, entry.entityId, "TileProxy3D", coldState.currentT, c) &&
            !isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "TileProxy3D")
          ) {
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: entry.entityId,
              proxyKind: "TileProxy3D",
              t: coldState.currentT,
              c,
            });
          }
        }
      }
      const groupId = entry.parentGroupId ?? null;
      if (entry.groupProxyAvailable && groupId) {
        for (const c of coldState.visibleChannels) {
          const dk = `${groupId}|${coldState.currentT}|${c}`;
          if (groupProxyEmitted.has(dk)) continue;
          if (
            isProxyDesired(desiredProxyKeys, coldState.datasetId, groupId, "GroupProxy3D", coldState.currentT, c) &&
            !isProxyResident(proxyAtlases, groupId, coldState.currentT, c, "GroupProxy3D")
          ) {
            groupProxyEmitted.add(dk);
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: groupId,
              proxyKind: "GroupProxy3D",
              t: coldState.currentT,
              c,
            });
          } else {
            // Already resident; mark dedup to avoid re-checking.
            groupProxyEmitted.add(dk);
          }
        }
      }
    } else if (entry.mode === "tiles-with-detail") {
      // Tile proxy fallback for the worker to use while detail chunks
      // are still loading. Only request if catalog advertises one.
      if (entry.proxyAvailable && entry.proxyKind === "TileProxy3D") {
        for (const c of coldState.visibleChannels) {
          if (
            isProxyDesired(desiredProxyKeys, coldState.datasetId, entry.entityId, "TileProxy3D", coldState.currentT, c) &&
            !isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "TileProxy3D")
          ) {
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: entry.entityId,
              proxyKind: "TileProxy3D",
              t: coldState.currentT,
              c,
            });
          }
        }
      }
    }

    // Chunk wanted-set. memberIdForColdEntry centralizes the
    // group-as-proxy → entityId convention even though those entries are
    // narrowed out above.
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
  tier: ResidencyTier,
): number {
  return coldState.renderRadiusView?.[tier] ?? RENDER_RADIUS_DISABLED;
}

/** The levels each tier holds for a tile entry, detail first. */
function chunkSourcesForEntry(
  entry: Exclude<ColdStateMessage["activeSet"][number], { kind: "group-as-proxy" }>,
): Array<{ tier: ResidencyTier; levels: number[] }> {
  const sources: Array<{ tier: ResidencyTier; levels: number[] }> = [
    { tier: "detail", levels: entry.detailLevels },
  ];
  if (entry.coarseLevel !== null) {
    sources.push({ tier: "coarse", levels: [entry.coarseLevel] });
  }
  return sources;
}

/**
 * Check whether a proxy is resident across any pool with matching
 * `(entityId, t, c)`. We don't know the pool key from cold state alone
 * (it depends on slot dims and channel); instead we scan all pools
 * indexed by the channel + composite key.
 *
 * In practice the orchestrator provides `proxyAtlases` indexed by
 * `proxyPoolKey()` strings; the slot composite key is unique per
 * `(entityId, t, c)`, so a single hit anywhere counts.
 */
function isProxyResident(
  proxyAtlases: Map<string, ProxyAtlasSnapshot> | undefined,
  entityId: string,
  t: number,
  c: number,
  proxyKind: ProxyKind,
): boolean {
  if (!proxyAtlases || proxyAtlases.size === 0) return false;
  const slotKey = `${entityId}|${t}|${c}`;
  for (const atlas of proxyAtlases.values()) {
    if (atlas.kind !== proxyKind) continue;
    if (atlas.slots.has(slotKey)) return true;
  }
  return false;
}

function isProxyDesired(
  desiredProxyKeys: Set<string> | null,
  datasetId: string,
  entityId: string,
  proxyKind: ProxyKind,
  t: number,
  c: number,
): boolean {
  if (desiredProxyKeys === null) return true;
  return desiredProxyKeys.has(`${datasetId}|${entityId}|${proxyKind}|${t}|${c}`);
}
