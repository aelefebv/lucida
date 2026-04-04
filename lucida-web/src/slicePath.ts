/** Slice render path: upload chunks + render multi-pass. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { evaluateAndSortPlans, buildMemberFetchList, interleaveFetchLists, getSceneSettings } from "./tickCommon.ts";
import type { SceneSettings } from "./tickCommon.ts";

export interface SliceState {
  prevTCZ: Map<string, string>;
  seedPending: Map<string, { level: number; coords: ChunkCoord[]; z: number; sentKeys: Set<string> }>;
  /** Tracks which chunks have been sent to the worker per member (cleared on atlas reset). */
  sentToWorker: Map<string, Set<string>>;
  /** Cached chunk plans per dataset, invalidated on camera/viewport/T/C/Z change. */
  planCache: Map<string, { key: string; plans: MemberChunkPlan[] }>;
}

export function createSliceState(): SliceState {
  return {
    prevTCZ: new Map(),
    seedPending: new Map(),
    sentToWorker: new Map(),
    planCache: new Map(),
  };
}

/** Result of the plan+fetch phase, passed to the upload+render phase. */
interface SlicePlanResult {
  memberPlanCache: Map<string, MemberChunkPlan[]>;
  settings: SceneSettings;
  vpCx: number;
  vpCy: number;
}

/**
 * Plan+fetch phase: set scene params, evaluate chunk plans, compute seeds,
 * build fetch lists, and submit to ensureFetched.
 */
function planAndFetchSlice(
  ctx: TickContext,
  state: SliceState,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): SlicePlanResult | null {
  const { scene, canvas, datasets } = ctx;
  if (datasets.size === 0) return null;

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  scene.set_z(z);
  scene.set_t(t);
  scene.set_c(c);

  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;
  scene.set_viewport(canvasW, canvasH);

  const settings = getSceneSettings(scene);

  const memberPlanCache = new Map<string, MemberChunkPlan[]>();

  // Viewport center for spatial priority (camera position in slice mode)
  const vpCenter = scene.center();
  const vpCx = vpCenter[0];
  const vpCy = vpCenter[1];

  for (const [dsId, ds] of datasets) {
    // Skip datasets whose dimensions are exceeded by the current slice position
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0]) continue;

    const planCacheKey = `${vpCx.toFixed(4)}|${vpCy.toFixed(4)}|${canvasW}|${canvasH}|${t}|${c}|${z}`;
    const cached = state.planCache.get(dsId);
    let sortedPlans: MemberChunkPlan[];
    if (cached && cached.key === planCacheKey) {
      sortedPlans = cached.plans;
    } else {
      const evaluated = evaluateAndSortPlans(scene, dsId, vpCx, vpCy);
      if (!evaluated) continue;
      sortedPlans = evaluated;
      state.planCache.set(dsId, { key: planCacheKey, plans: sortedPlans });
    }
    memberPlanCache.set(dsId, sortedPlans);

    // Build per-member fetch lists (with seed coords prepended) and collect for interleaving
    const perMemberFetchLists: { memberId: string; list: ChunkCoord[] }[] = [];

    for (const mp of sortedPlans) {
      const memberId = mp.member_id;
      const sharedQueue = ds.sharedQueue;
      const targetLevel = mp.needed[0]?.level;

      // Detect T/C/Z change for seed computation.
      // prevTCZ now stores "T/C/Z/level" (set in upload phase), so extract T/C/Z prefix for seed check.
      const tczKey = `${t}/${c}/${z}`;
      const prevTCZLevel = state.prevTCZ.get(memberId);
      const prevTCZOnly = prevTCZLevel?.substring(0, prevTCZLevel.lastIndexOf("/"));
      const needsSeed = prevTCZOnly === undefined || prevTCZOnly !== tczKey;

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
      const seedInfo = state.seedPending.get(memberId);
      const mmPending = minimapPendingFetch.get(memberId);
      const fetchList = buildMemberFetchList(mp.needed, mp.prefetch, seedInfo, sharedQueue, memberId, mmPending);
      if (fetchList.length > 0) {
        perMemberFetchLists.push({ memberId, list: fetchList });
      }
    }

    // Interleave per-member fetch lists (round-robin by spatial priority) and submit
    if (perMemberFetchLists.length > 0) {
      const unified = interleaveFetchLists(perMemberFetchLists);
      ds.sharedQueue.ensureFetched(unified);
    }
  }

  return { memberPlanCache, settings, vpCx, vpCy };
}

/**
 * Upload+render phase: stream seed chunks as fallback, upload fine chunks
 * within budget, build layer params, and render.
 */
function uploadAndRenderSlice(
  ctx: TickContext,
  state: SliceState,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  planResult: SlicePlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, canvas, datasets } = ctx;
  const { memberPlanCache, settings } = planResult;

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;

  for (const [dsId, ds] of datasets) {
    const dsShape = ds.info.levels[0].shape;
    if (z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0]) continue;

    const sortedPlans = memberPlanCache.get(dsId);
    if (!sortedPlans) continue;

    for (const mp of sortedPlans) {
      const memberId = mp.member_id;
      const sharedQueue = ds.sharedQueue;
      const tczKey = `${t}/${c}/${z}`;

      // Send available seed chunks incrementally as fallback
      const seedInfo = state.seedPending.get(memberId);
      if (seedInfo) {
        const seedMeta = ds.info.levels[seedInfo.level];
        const [, , , sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const localZ = seedInfo.z - seedInfo.coords[0].z * sChunkZ;
        let allSent = true;
        for (const sc of seedInfo.coords) {
          if (seedInfo.sentKeys.has(sc.key)) continue;
          const buf = sharedQueue.get(memberId, sc.key);
          if (!buf || buf.byteLength === 0) { allSent = false; continue; }
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

      const level = mp.needed[0]?.level;
      if (level === undefined) continue;

      const levelMeta = ds.info.levels[level];
      if (!levelMeta) continue;

      const [, , , levelHeight, levelWidth] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
      const fullResDepth = ds.info.levels[0].shape[2];
      const levelDepth = levelMeta.shape[2];

      // --- Atlas config on LOD/T/C/Z change ---
      const tczLevelKey = `${t}/${c}/${z}/${level}`;
      const prevTCZLevel = state.prevTCZ.get(memberId);
      if (prevTCZLevel !== tczLevelKey) {
        client.sliceAtlasConfig(
          memberId, level, z, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY,
        );
        state.sentToWorker.delete(memberId);
        state.prevTCZ.set(memberId, tczLevelKey);
      }

      // --- Direct chunk push: send available chunks not yet sent ---
      let sentSet = state.sentToWorker.get(memberId);
      if (!sentSet) {
        sentSet = new Set();
        state.sentToWorker.set(memberId, sentSet);
      }
      // Prune sentToWorker to current needed set — if a chunk left the viewport,
      // it may have been evicted by the worker. Re-send if it becomes needed again.
      const neededKeys = new Set(mp.needed.filter(c => c.level === level).map(c => c.key));
      for (const key of sentSet) {
        if (!neededKeys.has(key)) sentSet.delete(key);
      }
      const chunksToSend: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of mp.needed) {
        if (coord.level !== level) continue;
        if (sentSet.has(coord.key)) continue;
        const buf = sharedQueue.get(memberId, coord.key);
        if (!buf || buf.byteLength === 0) continue;
        chunksToSend.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        sentSet.add(coord.key);
      }
      if (chunksToSend.length > 0) {
        client.sliceChunkData(
          memberId, chunksToSend,
          level, z, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY, chunkZ,
          fullResDepth, levelDepth, z,
        );
      }
    }
  }

  if (!shouldRender) return false;

  // Build layer params for visible layers in order
  const { layerOrder, allSettings } = settings;
  const currentZoom = scene.zoom();
  const centerArr = scene.center();
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  for (const dsId of layerOrder) {
    const ds = datasets.get(dsId);
    if (!ds) continue;
    const dsSettings = allSettings[dsId];
    if (!dsSettings || !dsSettings.visible) continue;

    // Skip layers whose dimensions are exceeded by the current slice position
    const dsShapeL = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (z >= dsShapeL[2] || c >= dsShapeL[1] || t >= dsShapeL[0]) continue;

    const fullResWidth = ds.info.levels[0].shape[4];
    const fullResHeight = ds.info.levels[0].shape[3];

    // Get member plans to emit one layer per member with position offsets (use cache from plan phase)
    const members: MemberChunkPlan[] = memberPlanCache.get(dsId) ?? [{ member_id: dsId, position: [0, 0], store_prefix: null, needed: [], prefetch: [] }];

    for (const mp of members) {
      layers.push({
        datasetId: mp.member_id,
        dataW: fullResWidth,
        dataH: fullResHeight,
        contrastMin: dsSettings.contrast_min,
        contrastMax: dsSettings.contrast_max,
        gamma: dsSettings.gamma,
        opacity: dsSettings.opacity,
        blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
        offsetX: mp.position[0],
        offsetY: mp.position[1],
      });
    }
  }

  client.resize(canvasW, canvasH);
  client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH);

  return false;
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
  shouldRender: boolean = true,
): boolean {
  const planResult = planAndFetchSlice(ctx, state, sliceZ, sliceT, sliceC, minimapPendingFetch);
  if (!planResult) return false;
  return uploadAndRenderSlice(ctx, state, sliceZ, sliceT, sliceC, planResult, shouldRender);
}

export function clearSliceForDataset(state: SliceState, dsId: string): void {
  state.prevTCZ.delete(dsId);
  state.seedPending.delete(dsId);
  state.sentToWorker.delete(dsId);
  state.planCache.delete(dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearSliceForMembers(state: SliceState, memberIds: string[]): void {
  for (const id of memberIds) {
    state.prevTCZ.delete(id);
    state.seedPending.delete(id);
    state.sentToWorker.delete(id);
  }
}
