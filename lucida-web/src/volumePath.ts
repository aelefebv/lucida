/** Volume render path: plan-based chunk upload + multi-pass render. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { evaluateAndSortPlans, buildMemberFetchList, interleaveFetchLists, getSceneSettings } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";
import {
  type UploadState,
  type MemberUploadActions,
  uploadChunksForMembers,
  clearUploadStateForDataset,
  clearUploadStateForMembers,
  resetUploadState,
} from "./uploadCommon.ts";
import type { DatasetInfo } from "./zarr/metadata.ts";
import type { SharedChunkQueue } from "./zarr/chunkStore.ts";

/** Backward-compatible alias. */
export type VolumeState = UploadState;

export { createUploadState as createVolumeState } from "./uploadCommon.ts";

/** Data passed from the plan+fetch phase to the upload+render phase. */
interface PlanResult {
  memberPlanCache: Map<string, MemberChunkPlan[]>;
  settings: { layerOrder: string[]; allSettings: Record<string, DatasetSettings> };
  eye: Float32Array;
  hitLocals: Map<string, [number, number, number]>;
  canvasW: number;
  canvasH: number;
  fullW: number;
  fullH: number;
  viewT: number;
  viewC: number;
}

/**
 * Plan+fetch phase: evaluate chunk plans, compute seeds, build fetch lists,
 * and submit to ensureFetched. Returns data needed by upload+render, or null
 * if there's nothing to do.
 */
function planAndFetchVolume(
  ctx: TickContext,
  state: VolumeState,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): PlanResult | null {
  const { scene, datasets } = ctx;

  // Use full-res viewport for chunk planning so LOD selection isn't affected
  // by renderScale (which drops to 0.25 during interaction). This prevents
  // the level from flip-flopping and clearing the chunk cache on every drag.
  const fullW = Math.round(ctx.canvas.clientWidth * devicePixelRatio);
  const fullH = Math.round(ctx.canvas.clientHeight * devicePixelRatio);
  scene.set_viewport(fullW, fullH);

  const canvasW = Math.round(fullW * ctx.renderScale);
  const canvasH = Math.round(fullH * ctx.renderScale);

  const viewT = scene.t();
  const viewC = scene.c();

  const settings = getSceneSettings(scene);

  const eye = new Float32Array(scene.eye_position());
  const hitLocals = new Map<string, [number, number, number]>();
  // Cache member plans per dataset so we don't call WASM twice (upload + render).
  const memberPlanCache = new Map<string, MemberChunkPlan[]>();

  const eyeForPriority: [number, number, number] = [eye[0], eye[1], eye[2]];

  for (const [dsId, ds] of datasets) {
    // Skip datasets whose C/T are exceeded (volume renders all Z slices)
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

    const planCacheKey = `${eye[0].toFixed(4)}|${eye[1].toFixed(4)}|${eye[2].toFixed(4)}|${fullW}|${fullH}|${viewT}|${viewC}`;
    const cached = state.planCache.get(dsId);
    let sortedPlans: MemberChunkPlan[];
    if (cached && cached.key === planCacheKey) {
      sortedPlans = cached.plans;
    } else {
      const evaluated = evaluateAndSortPlans(scene, dsId, eyeForPriority[0], eyeForPriority[1]);
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

      if (mp.needed.length === 0) continue;
      const targetLevel = mp.needed[0].level;

      // Detect T/C change for seed computation.
      // prevStateKey stores "T/C/level" (set in upload phase), so extract T/C prefix for seed check.
      const tcKey = `${viewT}/${viewC}`;
      const prevTCLevel = state.prevStateKey.get(memberId);
      const prevTCOnly = prevTCLevel?.substring(0, prevTCLevel.lastIndexOf("/"));
      const needsSeed = prevTCOnly === undefined || prevTCOnly !== tcKey;

      if (needsSeed) {
        const seedLevel = ds.info.levels.length - 1;
        if (seedLevel > targetLevel) {
          const seedMeta = ds.info.levels[seedLevel];
          const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
          const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
          const nz = Math.ceil(sDepth / sChunkZ);
          const ny = Math.ceil(sHeight / sChunkY);
          const nx = Math.ceil(sWidth / sChunkX);
          const seedCoords: ChunkCoord[] = [];
          for (let iz = 0; iz < nz; iz++) {
            for (let iy = 0; iy < ny; iy++) {
              for (let ix = 0; ix < nx; ix++) {
                seedCoords.push({
                  level: seedLevel,
                  x: ix, y: iy, z: iz,
                  t: viewT, c: viewC,
                  key: `${seedLevel}/${viewT}/${viewC}/${iz}/${iy}/${ix}`,
                });
              }
            }
          }
          state.seedPending.set(memberId, { level: seedLevel, coords: seedCoords, sentKeys: new Set() });
        } else {
          state.seedPending.delete(memberId);
        }
      }

      // Build per-member fetch list with seed coords prepended for priority
      const mmPending = minimapPendingFetch.get(memberId);
      const seedInfo = state.seedPending.get(memberId);
      const fetchList = buildMemberFetchList(mp.needed, mp.prefetch, seedInfo, sharedQueue, memberId, mmPending);
      if (fetchList.length > 0) {
        perMemberFetchLists.push({ memberId, list: fetchList });
      }

      // Ray-volume intersection point in local [0,1]^3 space for upload prioritization.
      const hitLocal = Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];
      hitLocals.set(memberId, hitLocal);
    }

    // Interleave per-member fetch lists (round-robin by spatial priority) and submit
    if (perMemberFetchLists.length > 0) {
      const unified = interleaveFetchLists(perMemberFetchLists);
      ds.sharedQueue.ensureFetched(unified);
    }
  }

  return { memberPlanCache, settings, eye, hitLocals, canvasW, canvasH, fullW, fullH, viewT, viewC };
}

/**
 * Upload+render phase: stream seed chunks, send chunk plans to worker,
 * build layer params, and render. Returns true if more work remains.
 */
function uploadAndRenderVolume(
  ctx: TickContext,
  state: VolumeState,
  plan: PlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, datasets } = ctx;
  const { memberPlanCache, settings, eye, hitLocals, canvasW, canvasH, fullW, fullH, viewT, viewC } = plan;
  const { layerOrder, allSettings } = settings;

  const shouldSkipDataset = (_dsId: string, ds: { info: DatasetInfo }) => {
    const dsShape = ds.info.levels[0].shape;
    return viewC >= dsShape[1] || viewT >= dsShape[0];
  };

  const createActions = (memberId: string, mp: MemberChunkPlan, ds: { sharedQueue: SharedChunkQueue; info: DatasetInfo }, dsId: string): MemberUploadActions | null => {
    if (mp.needed.length === 0) return null;

    const targetLevel = mp.needed[0].level;
    const levelMeta = ds.info.levels[targetLevel];
    const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

    const hitLocal = hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];

    const tcKey = `${viewT}/${viewC}`;

    return {
      stateKey: `${viewT}/${viewC}/${targetLevel}`,

      sendAtlasConfig() {
        client.volumeAtlasConfig(
          memberId, targetLevel, viewT, viewC,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
        );
      },

      processSeedChunk(data, sc, seedMeta) {
        const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const xOff = sc.x * sChunkX;
        const yOff = sc.y * sChunkY;
        const zOff = sc.z * sChunkZ;
        const cw = Math.min(sChunkX, sWidth - xOff);
        const ch = Math.min(sChunkY, sHeight - yOff);
        const cd = Math.min(sChunkZ, sDepth - zOff);
        const transferBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        client.volumeWriteFallbackChunk(
          memberId, tcKey,
          sWidth, sHeight, sDepth,
          transferBuf,
          xOff, yOff, zOff,
          cw, ch, cd,
          sChunkX, sChunkY,
        );
      },

      sendFineChunks(chunks) {
        client.volumeChunkData(
          memberId, chunks,
          targetLevel, viewT, viewC,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
          hitLocal,
        );
      },
    };
  };

  const budgetExhausted = uploadChunksForMembers(
    datasets, memberPlanCache, state, shouldSkipDataset, createActions,
  );

  if (!shouldRender) return budgetExhausted;

  // Build layer params for visible layers in order
  const invVP = new Float32Array(scene.inv_view_proj());
  const viewProj = new Float32Array(scene.view_proj());
  const camForward = new Float32Array(scene.camera_forward());
  const clipDistance = scene.clip_distance();
  const clipModeStr = scene.clip_mode();
  const clipMode = clipModeStr === "sphere" ? 1 : 0;

  const layers: VolumeLayerParams[] = [];
  for (const dsId of layerOrder) {
    const dsVol = datasets.get(dsId);
    if (!dsVol) continue;
    const dsSettings = allSettings[dsId];
    if (!dsSettings || !dsSettings.visible) continue;

    // Skip layers whose C/T are exceeded (volume renders all Z slices)
    const dsShapeV = dsVol.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShapeV[1] || viewT >= dsShapeV[0]) continue;

    // Get member plans to emit one layer per member with its own model matrix (use cache from upload phase)
    const members: MemberChunkPlan[] = memberPlanCache.get(dsId) ?? [{ member_id: dsId, position: [0, 0], store_prefix: null, needed: [], prefetch: [] }];

    for (const mp of members) {
      const memberId = mp.member_id;
      const model = new Float32Array(scene.member_model_matrix(dsId, memberId));
      const invModel = new Float32Array(scene.inv_member_model_matrix(dsId, memberId));

      layers.push({
        datasetId: memberId,
        modelMatrix: model,
        invModelMatrix: invModel,
        rayHitLocal: hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number],
        contrastMin: dsSettings.contrast_min,
        contrastMax: dsSettings.contrast_max,
        gamma: dsSettings.gamma,
        opacity: dsSettings.opacity,
        blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
        renderMode: (dsSettings.render_mode || "translucent") as "translucent" | "max_intensity",
      });
    }
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH, fullW, fullH, viewProj, camForward, clipDistance, clipMode);

  return budgetExhausted;
}

/**
 * Upload volume chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickVolume(
  ctx: TickContext,
  state: VolumeState,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const planResult = planAndFetchVolume(ctx, state, minimapPendingFetch);
  if (!planResult) return false;
  return uploadAndRenderVolume(ctx, state, planResult, shouldRender);
}

export function clearVolumeForDataset(state: VolumeState, dsId: string): void {
  clearUploadStateForDataset(state, dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearVolumeForMembers(state: VolumeState, memberIds: string[]): void {
  clearUploadStateForMembers(state, memberIds);
}

export function resetVolumeState(state: VolumeState): void {
  resetUploadState(state);
}
