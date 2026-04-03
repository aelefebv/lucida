/** Slice render path: upload chunks + render multi-pass. */
import type { ChunkCoord, QualifiedChunkCoord } from "./zarr/chunkStore.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface SliceState {
  uploaded: Map<string, Map<string, true>>;  // memberId → chunkKey → true (ordered for LRU)
  currentLod: Map<string, { level: number; z: number; t: number; c: number }>;
  prevTCZ: Map<string, string>;
  seedPending: Map<string, { level: number; coords: ChunkCoord[]; z: number; sentKeys: Set<string> }>;
}

export function createSliceState(): SliceState {
  return {
    uploaded: new Map(),
    currentLod: new Map(),
    prevTCZ: new Map(),
    seedPending: new Map(),
  };
}

/**
 * Upload slice chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickSlice(
  ctx: TickContext,
  state: SliceState,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): boolean {
  const { scene, client, canvas, datasets } = ctx;
  if (datasets.size === 0) return false;

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  scene.set_z(z);
  scene.set_t(t);
  scene.set_c(c);

  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;
  scene.set_viewport(canvasW, canvasH);

  // Get layer ordering and settings from scene
  const layerOrder: string[] = JSON.parse(scene.dataset_order());
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    contrast_min: number;
    contrast_max: number;
    gamma: number;
    blend_mode: string;
  }> = JSON.parse(scene.all_dataset_settings());

  let budgetRemaining = UPLOAD_BUDGET_BYTES;
  let exhausted = false;
  let hasPending = false;

  // Cache member plans per dataset so we don't call WASM twice (upload + render).
  const memberPlanCache = new Map<string, MemberChunkPlan[]>();

  // Viewport center for spatial priority (camera position in slice mode)
  const vpCenter = scene.center();
  const vpCx = vpCenter[0];
  const vpCy = vpCenter[1];

  // Upload chunks for ALL datasets, iterating per-member
  for (const [dsId, ds] of datasets) {
    // Skip datasets whose dimensions are exceeded by the current slice position
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0]) continue;

    const memberPlans = evaluateChunkPlanFor(scene, dsId);
    if (!memberPlans) continue;
    memberPlanCache.set(dsId, memberPlans);

    // Sort member plans by distance from viewport center (nearest first)
    const sortedPlans = [...memberPlans].sort((a, b) => {
      const dxA = a.position[0] - vpCx;
      const dyA = a.position[1] - vpCy;
      const dxB = b.position[0] - vpCx;
      const dyB = b.position[1] - vpCy;
      return (dxA * dxA + dyA * dyA) - (dxB * dxB + dyB * dyB);
    });

    // Build per-member fetch lists (with seed coords prepended) and collect for interleaving
    const perMemberFetchLists: { memberId: string; list: ChunkCoord[] }[] = [];

    for (const mp of sortedPlans) {
      const memberId = mp.member_id;
      const sharedQueue = ds.sharedQueue;
      const targetLevel = mp.needed[0]?.level;

      // Detect T/C/Z change and compute coarse seed coords
      const tczKey = `${t}/${c}/${z}`;
      const prevTCZKey = state.prevTCZ.get(memberId);
      const needsSeed = prevTCZKey === undefined || prevTCZKey !== tczKey;
      state.prevTCZ.set(memberId, tczKey);

      if (needsSeed && targetLevel !== undefined) {
        const seedLevel = ds.info.levels.length - 1;
        if (seedLevel > targetLevel) {
          const seedMeta = ds.info.levels[seedLevel];
          const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
          const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
          const fullResDepthS = ds.info.levels[0].shape[2];
          const seedLevelZ = Math.min(
            Math.floor((z / Math.max(fullResDepthS - 1, 1)) * Math.max(sDepth - 1, 1)),
            sDepth - 1,
          );
          const targetChunkZ = Math.floor(seedLevelZ / sChunkZ);
          const ny = Math.ceil(sHeight / sChunkY);
          const nx = Math.ceil(sWidth / sChunkX);
          const seedCoords: ChunkCoord[] = [];
          for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
              seedCoords.push({
                level: seedLevel,
                x: ix, y: iy, z: targetChunkZ,
                t, c,
                key: `${seedLevel}/${t}/${c}/${targetChunkZ}/${iy}/${ix}`,
              });
            }
          }
          state.seedPending.set(memberId, { level: seedLevel, coords: seedCoords, z: seedLevelZ, sentKeys: new Set() });
        } else {
          state.seedPending.delete(memberId);
        }
      }

      // Build per-member fetch list with seed coords prepended for priority
      const mmPending = minimapPendingFetch.get(memberId);
      let fetchList: ChunkCoord[] = [...mp.needed, ...mp.prefetch, ...(mmPending ?? [])];
      const seedInfo = state.seedPending.get(memberId);
      if (seedInfo) {
        const seedFetchCoords = seedInfo.coords.filter(sc => !sharedQueue.has(memberId, sc.key));
        if (seedFetchCoords.length > 0) {
          fetchList = [...seedFetchCoords, ...fetchList];
        }
      }
      if (fetchList.length > 0) {
        perMemberFetchLists.push({ memberId, list: fetchList });
      }

      // Send available seed chunks incrementally as fallback
      if (seedInfo) {
        const seedMeta = ds.info.levels[seedInfo.level];
        const [, , , sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const localZ = seedInfo.z - seedInfo.coords[0].z * sChunkZ;
        let allSent = true;
        for (const sc of seedInfo.coords) {
          if (seedInfo.sentKeys.has(sc.key)) continue;
          const buf = sharedQueue.get(memberId, sc.key);
          if (!buf || buf.byteLength === 0) { allSent = false; hasPending = true; continue; }
          const data = bufferToUint16(buf, seedMeta.dataType);
          const xOff = sc.x * sChunkX;
          const yOff = sc.y * sChunkY;
          const chunkW = Math.min(sChunkX, sWidth - xOff);
          const chunkH = Math.min(sChunkY, sHeight - yOff);
          const sliceOffset = localZ * sChunkY * sChunkX;
          const sliceData = data.subarray(sliceOffset, sliceOffset + sChunkY * sChunkX);
          const transferBuf = sliceData.buffer.slice(sliceData.byteOffset, sliceData.byteOffset + sliceData.byteLength);
          client.sliceWriteFallbackChunk(
            memberId, tczKey,
            sWidth, sHeight,
            transferBuf,
            xOff, yOff,
            chunkW, chunkH,
            sChunkX,
          );
          seedInfo.sentKeys.add(sc.key);
        }
        if (allSent) {
          state.seedPending.delete(memberId);
        }
      }

      const level = targetLevel;
      if (level === undefined) continue;

      const levelMeta = ds.info.levels[level];
      if (!levelMeta) continue;

      const [, , , levelHeight, levelWidth] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
      const fullResDepth = ds.info.levels[0].shape[2];
      const levelDepth = levelMeta.shape[2];

      // Per-member LOD tracking -- clear uploaded set on change
      const lod = state.currentLod.get(memberId);
      if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
        state.uploaded.set(memberId, new Map());
        state.currentLod.set(memberId, { level, z, t, c });
      }

      let uploaded = state.uploaded.get(memberId);
      if (!uploaded) {
        uploaded = new Map();
        state.uploaded.set(memberId, uploaded);
      }

      const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of mp.needed) {
        if (coord.level !== level) continue;
        if (uploaded.has(coord.key)) continue;
        const buf = sharedQueue.get(memberId, coord.key);
        if (!buf || buf.byteLength === 0) { hasPending = true; continue; }
        availableChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        uploaded.set(coord.key, true as const);
        budgetRemaining -= buf.byteLength;
        if (budgetRemaining <= 0) {
          exhausted = true;
          break;
        }
      }

      if (availableChunks.length > 0) {
        client.sliceUploadChunksForLayer(
          memberId,
          availableChunks,
          level, z, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY, chunkZ,
          fullResDepth, levelDepth, z,
        );
      }

      if (budgetRemaining <= 0) break;
    }

    // Interleave per-member fetch lists (round-robin by spatial priority) and submit
    if (perMemberFetchLists.length > 0) {
      const unified: QualifiedChunkCoord[] = [];
      const maxLen = Math.max(...perMemberFetchLists.map(p => p.list.length));
      for (let i = 0; i < maxLen; i++) {
        for (const { memberId, list } of perMemberFetchLists) {
          if (i < list.length) {
            unified.push({ ...list[i], memberId });
          }
        }
      }
      ds.sharedQueue.ensureFetched(unified);
    }

    if (budgetRemaining <= 0) break;
  }

  // Build layer params for visible layers in order
  const currentZoom = scene.zoom();
  const centerArr = scene.center();
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  for (const dsId of layerOrder) {
    const ds = datasets.get(dsId);
    if (!ds) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    // Skip layers whose dimensions are exceeded by the current slice position
    const dsShapeL = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (z >= dsShapeL[2] || c >= dsShapeL[1] || t >= dsShapeL[0]) continue;

    const fullResWidth = ds.info.levels[0].shape[4];
    const fullResHeight = ds.info.levels[0].shape[3];

    // Get member plans to emit one layer per member with position offsets (use cache from upload phase)
    const members: MemberChunkPlan[] = memberPlanCache.get(dsId) ?? [{ member_id: dsId, position: [0, 0], store_prefix: null, needed: [], prefetch: [] }];

    for (const mp of members) {
      layers.push({
        datasetId: mp.member_id,
        dataW: fullResWidth,
        dataH: fullResHeight,
        contrastMin: settings.contrast_min,
        contrastMax: settings.contrast_max,
        gamma: settings.gamma,
        opacity: settings.opacity,
        blendMode: settings.blend_mode as "alpha" | "additive" | "max",
        offsetX: mp.position[0],
        offsetY: mp.position[1],
      });
    }
  }

  client.resize(canvasW, canvasH);
  client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH);

  return exhausted || hasPending;
}

export function clearSliceForDataset(state: SliceState, dsId: string): void {
  state.uploaded.delete(dsId);
  state.currentLod.delete(dsId);
  state.prevTCZ.delete(dsId);
  state.seedPending.delete(dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearSliceForMembers(state: SliceState, memberIds: string[]): void {
  for (const id of memberIds) {
    state.uploaded.delete(id);
    state.currentLod.delete(id);
    state.prevTCZ.delete(id);
    state.seedPending.delete(id);
  }
}
