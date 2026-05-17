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
import { makeCompositeKey } from "./chunkKeys.ts";
import { memberIdForColdEntry } from "./descriptorBuffer.ts";

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
 * residency checks distinguish `WellProxy3D` vs `FieldProxy3D` pools
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
 * Chunk wanted-set rules: for each detail-owned LOD on each visible
 * channel, enumerate the visible-region grid cells and report any
 * whose composite slot key is missing.
 *
 * Proxy wanted-set rules: for each cold-state active entry, walk its
 * `mode`:
 *
 *   - `well-as-proxy` (entry.entityId IS the wellId)
 *       → emit a `MissingProxy { kind: WellProxy3D }` per visible
 *         channel if the well's slot isn't resident.
 *   - `fields-with-proxy-fallback` (entry.entityId is the fieldId)
 *       → emit a `MissingProxy { kind: FieldProxy3D }` for the field
 *         per channel (if `proxyAvailable`), and a single
 *         `MissingProxy { kind: WellProxy3D }` for the parent well per
 *         channel (if `wellProxyAvailable` and `parentWellId` is set).
 *         Parent-well requests are deduped per (parentWellId, t, c).
 *   - `fields-with-detail`
 *       → existing chunk wanted-set + a per-channel field-proxy
 *         request when the catalog advertises one but it isn't yet
 *         resident.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
  memberToPool?: Map<string, string>,
  proxyAtlases?: Map<string, ProxyAtlasSnapshot>,
): WantedSetResult {
  const missing: Array<MissingChunk | MissingProxy> = [];

  if (coldState.activeSet.length === 0) {
    return { missing };
  }

  const isMultiChannel = coldState.visibleChannels.length > 1;

  // Dedup per (wellId, t, c) so multiple field entries of the same
  // parent only emit one parent-well-proxy request.
  const wellProxyEmitted = new Set<string>();

  for (const entry of coldState.activeSet) {
    // Proxy wanted-set. `entry.kind` discriminates so the field
    // branches see the field variant typed-out.
    if (entry.kind === "well-as-proxy") {
      for (const c of coldState.visibleChannels) {
        if (!isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "WellProxy3D")) {
          missing.push({
            kind: "proxy",
            datasetId: coldState.datasetId,
            entityId: entry.entityId,
            proxyKind: "WellProxy3D",
            t: coldState.currentT,
            c,
          });
        }
      }
      continue;
    }

    if (entry.mode === "fields-with-proxy-fallback") {
      if (entry.proxyAvailable && entry.proxyKind === "FieldProxy3D") {
        for (const c of coldState.visibleChannels) {
          if (!isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "FieldProxy3D")) {
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: entry.entityId,
              proxyKind: "FieldProxy3D",
              t: coldState.currentT,
              c,
            });
          }
        }
      }
      const wellId = entry.parentWellId ?? null;
      if (entry.wellProxyAvailable && wellId) {
        for (const c of coldState.visibleChannels) {
          const dk = `${wellId}|${coldState.currentT}|${c}`;
          if (wellProxyEmitted.has(dk)) continue;
          if (!isProxyResident(proxyAtlases, wellId, coldState.currentT, c, "WellProxy3D")) {
            wellProxyEmitted.add(dk);
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: wellId,
              proxyKind: "WellProxy3D",
              t: coldState.currentT,
              c,
            });
          } else {
            // Already resident; mark dedup to avoid re-checking.
            wellProxyEmitted.add(dk);
          }
        }
      }
    } else if (entry.mode === "fields-with-detail") {
      // Field proxy fallback for the worker to use while detail chunks
      // are still loading. Only request if catalog advertises one.
      if (entry.proxyAvailable && entry.proxyKind === "FieldProxy3D") {
        for (const c of coldState.visibleChannels) {
          if (!isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "FieldProxy3D")) {
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: entry.entityId,
              proxyKind: "FieldProxy3D",
              t: coldState.currentT,
              c,
            });
          }
        }
      }
    }

    // Chunk wanted-set. memberIdForColdEntry centralizes the
    // well-as-proxy → entityId convention even though those entries are
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
        const poolKey = memberToPool?.get(memberId);
        if (!poolKey) continue;
        atlas = sliceAtlases.get(poolKey);
        if (atlas === undefined) continue;
        entityLodMetas = atlas.entityMetas?.get(memberId);
        if (entityLodMetas === undefined) continue;
        useCompositeKey = true;
      }

      const atlasLodByLevel = new Map(entityLodMetas.map((m) => [m.level, m]));

      const [finest, coarsest] = entry.detailOwnedLodRange;
      for (let lvl = finest; lvl <= coarsest; lvl++) {
        if (!atlasLodByLevel.has(lvl)) continue;

        const levelMeta = entry.levels.find((l) => l.level === lvl);
        if (levelMeta === undefined) continue;

        const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        const [gridZ, gridY, gridX] = levelMeta.gridShape;

        const [minVoxX, minVoxY, maxVoxX, maxVoxY] =
          coldState.visibleRegion.xyBoundsVox;

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
          zStart = Math.max(0, Math.floor(coldState.visibleRegion.zRangeVox[0] / chunkZ));
          zEnd = Math.min(gridZ, Math.ceil(coldState.visibleRegion.zRangeVox[1] / chunkZ));
        }

        for (let iz = zStart; iz < zEnd; iz++) {
          for (let iy = rowStart; iy < rowEnd; iy++) {
            for (let ix = colStart; ix < colEnd; ix++) {
              const chunkKey = `${lvl}/${coldState.currentT}/${channel}/${iz}/${iy}/${ix}`;
              const slotKey = useCompositeKey ? makeCompositeKey(memberId, chunkKey) : chunkKey;
              if (!atlas.slots.has(slotKey)) {
                missing.push({
                  kind: "chunk",
                  entityId: entry.entityId,
                  chunkKey,
                });
              }
            }
          }
        }
      }
    }
  }

  return { missing };
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
