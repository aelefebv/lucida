/** Slice render path: upload chunks + render multi-pass. */
import type { ChunkCoord, SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { planAndFetchForDatasets } from "./tickCommon.ts";
import type { PlanFetchActions, SceneSettings } from "./tickCommon.ts";
import {
  type UploadState,
  type MemberUploadActions,
  uploadChunksForMembers,
  clearUploadStateForDataset,
  clearUploadStateForMembers,
} from "./uploadCommon.ts";
import type { DatasetInfo } from "./zarr/metadata.ts";

/** Backward-compatible alias. */
export type SliceState = UploadState;

export { createUploadState as createSliceState } from "./uploadCommon.ts";

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

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  scene.set_z(z);
  scene.set_t(t);
  scene.set_c(c);

  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;
  scene.set_viewport(canvasW, canvasH);

  // Viewport center for spatial priority (camera position in slice mode)
  const vpCenter = scene.center();
  const vpCx = vpCenter[0];
  const vpCy = vpCenter[1];

  const actions: PlanFetchActions = {
    seedChangeKey: `${t}/${c}/${z}`,

    shouldSkipDataset(dsShape: number[]) {
      return z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0];
    },

    planCacheKey(_dsId: string) {
      return `${vpCx.toFixed(4)}|${vpCy.toFixed(4)}|${canvasW}|${canvasH}|${t}|${c}|${z}`;
    },

    computeSeeds(dsInfo, targetLevel) {
      const seedLevel = dsInfo.levels.length - 1;
      if (seedLevel <= targetLevel) return null;

      const seedMeta = dsInfo.levels[seedLevel];
      const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
      const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
      const fullResDepthS = dsInfo.levels[0].shape[2];
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
      return { level: seedLevel, coords: seedCoords, z: seedLevelZ, sentKeys: new Set<string>() };
    },
  };

  const result = planAndFetchForDatasets(scene, datasets, state, actions, minimapPendingFetch, vpCx, vpCy);
  if (!result) return null;

  return { memberPlanCache: result.memberPlanCache, settings: result.settings, vpCx, vpCy };
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

  const shouldSkipDataset = (_dsId: string, ds: { info: DatasetInfo }) => {
    const dsShape = ds.info.levels[0].shape;
    return z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0];
  };

  const createActions = (memberId: string, mp: MemberChunkPlan, ds: { sharedQueue: SharedChunkQueue; info: DatasetInfo }, _dsId: string): MemberUploadActions | null => {
    const level = mp.needed[0]?.level;
    if (level === undefined) return null;

    const levelMeta = ds.info.levels[level];
    if (!levelMeta) return null;

    const [, , , levelHeight, levelWidth] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
    const fullResDepth = ds.info.levels[0].shape[2];
    const levelDepth = levelMeta.shape[2];

    const tczKey = `${t}/${c}/${z}`;

    return {
      stateKey: `${t}/${c}/${z}/${level}`,

      sendAtlasConfig() {
        client.sliceAtlasConfig(
          memberId, level, z, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY,
        );
      },

      processSeedChunk(data, sc, seedMeta) {
        const seedInfo = state.seedPending.get(memberId);
        if (!seedInfo || seedInfo.z === undefined) return;
        const [, , , sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const localZ = seedInfo.z - seedInfo.coords[0].z * sChunkZ;
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
      },

      sendFineChunks(chunks) {
        client.sliceChunkData(
          memberId, chunks,
          level, z, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY, chunkZ,
          fullResDepth, levelDepth, z,
        );
      },
    };
  };

  const budgetExhausted = uploadChunksForMembers(
    datasets, memberPlanCache, state, shouldSkipDataset, createActions,
  );

  if (!shouldRender) return budgetExhausted;

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

  return budgetExhausted;
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
  clearUploadStateForDataset(state, dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearSliceForMembers(state: SliceState, memberIds: string[]): void {
  clearUploadStateForMembers(state, memberIds);
}
