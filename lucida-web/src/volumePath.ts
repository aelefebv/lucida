/** Volume render path: plan-based chunk upload + multi-pass render. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberChunkPlan } from "./uploadCommon.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { getActiveChannels, compositeKey, parseChannel } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";
import {
  type UploadState,
  type MemberUploadActions,
  uploadChunksForMembers,
  clearUploadStateForDataset,
  clearUploadStateForMembers,
  resetUploadState,
} from "./uploadCommon.ts";
import { debugStats } from "./debug/debugStats.ts";
import type { ContentGraph } from "./contentTypes.ts";
import type { SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { Orchestrator } from "./pipeline/orchestrator.ts";
import type { PlanningEpochs } from "./pipeline/planning.ts";

/**
 * Project a well's [0,1]³ unit-cube AABB to screen space and return a scissor rect.
 * Returns null if the well is fully off-screen.
 */
function computeScissorRect(
  modelMatrix: Float32Array,
  viewProj: Float32Array,
  canvasW: number,
  canvasH: number,
): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < 8; i++) {
    const cx = i & 1;
    const cy = (i >> 1) & 1;
    const cz = (i >> 2) & 1;

    // Model transform (column-major): local [0,1]³ → world
    const wx = modelMatrix[0] * cx + modelMatrix[4] * cy + modelMatrix[8] * cz + modelMatrix[12];
    const wy = modelMatrix[1] * cx + modelMatrix[5] * cy + modelMatrix[9] * cz + modelMatrix[13];
    const wz = modelMatrix[2] * cx + modelMatrix[6] * cy + modelMatrix[10] * cz + modelMatrix[14];
    const ww = modelMatrix[3] * cx + modelMatrix[7] * cy + modelMatrix[11] * cz + modelMatrix[15];

    // ViewProj transform: world → clip
    const clipX = viewProj[0] * wx + viewProj[4] * wy + viewProj[8] * wz + viewProj[12] * ww;
    const clipY = viewProj[1] * wx + viewProj[5] * wy + viewProj[9] * wz + viewProj[13] * ww;
    const clipW = viewProj[3] * wx + viewProj[7] * wy + viewProj[11] * wz + viewProj[15] * ww;

    if (clipW <= 0) {
      // Vertex behind camera — conservative fallback to full screen
      return [0, 0, canvasW, canvasH];
    }

    // NDC [-1,1] → screen (WebGPU: top-left origin, y-down)
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const sx = (ndcX + 1) * 0.5 * canvasW;
    const sy = (1 - ndcY) * 0.5 * canvasH;

    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }

  // Clamp to canvas bounds and compute integer rect
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const w = Math.min(canvasW, Math.ceil(maxX)) - x;
  const h = Math.min(canvasH, Math.ceil(maxY)) - y;

  if (w <= 0 || h <= 0) return null; // fully off-screen
  return [x, y, w, h];
}

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
  multiChannel: boolean;
  epochs: PlanningEpochs;
}


/**
 * Upload+render phase: send chunk plans to worker, build layer params,
 * and render. Returns true if more work remains.
 */
function uploadAndRenderVolume(
  ctx: TickContext,
  state: VolumeState,
  plan: PlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, datasets } = ctx;
  const { memberPlanCache, settings, eye, hitLocals, canvasW, canvasH, fullW, fullH, viewT, viewC, multiChannel, epochs } = plan;
  const { layerOrder, allSettings } = settings;

  const shouldSkipDataset = (cacheKey: string, ds: { content: ContentGraph }) => {
    if (multiChannel) {
      // In multi-channel mode, the plan phase already filtered channels.
      return !ds;
    }
    const dsShape = ds.content.images[0].multiscale.levels[0].shape;
    return viewC >= dsShape[1] || viewT >= dsShape[0];
  };

  const createActions = (memberId: string, mp: MemberChunkPlan, ds: { sharedQueue: SharedChunkQueue; content: ContentGraph }, dsId: string): MemberUploadActions | null => {
    if (mp.needed.length === 0) return null;

    const targetLevel = mp.needed[0].level;
    const levelMeta = ds.content.images[0].multiscale.levels[targetLevel];
    const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;

    // In multi-channel mode, memberId is composite; extract channel
    const ch = multiChannel ? (parseChannel(memberId) ?? viewC) : viewC;

    const hitLocal = hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];

    return {
      stateKey: `${viewT}/${ch}/${targetLevel}`,

      sendAtlasConfig() {
        client.volumeAtlasConfig(
          memberId, targetLevel, viewT, ch,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
          epochs,
        );
      },

      sendFineChunks(chunks) {
        client.volumeChunkData(
          memberId, chunks,
          targetLevel, viewT, ch,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
          hitLocal,
          epochs,
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

    const dsShapeV = dsVol.content.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]

    if (multiChannel) {
      // Multi-channel: emit one layer per (member, channel)
      const activeChannels = getActiveChannels(dsSettings);
      const channelBlend = dsSettings.channel_blend_mode as "alpha" | "additive" | "max" || "additive";

      for (const ch of activeChannels) {
        if (ch >= dsShapeV[1] || viewT >= dsShapeV[0]) continue;

        const chSettings = dsSettings.channel_settings?.[ch];
        const layerContrastMin = chSettings?.contrast_min ?? dsSettings.contrast_min;
        const layerContrastMax = chSettings?.contrast_max ?? dsSettings.contrast_max;
        const layerGamma = chSettings?.gamma ?? dsSettings.gamma;
        const layerColormap = chSettings?.colormap ?? "gray";

        const planCacheKey = `${dsId}:ch${ch}`;
        const members: MemberChunkPlan[] = memberPlanCache.get(planCacheKey)
          ?? [{ image_id: dsId, position: [0, 0], needed: [], prefetch: [] }];

        for (const mp of members) {
          const rawMemberId = mp.image_id;
          const compKey = compositeKey(rawMemberId, ch);
          const model = new Float32Array(scene.member_model_matrix(dsId, rawMemberId));
          const invModel = new Float32Array(scene.inv_member_model_matrix(dsId, rawMemberId));

          const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
          if (!scissorRect) continue; // well fully off-screen

          layers.push({
            datasetId: compKey,
            modelMatrix: model,
            invModelMatrix: invModel,
            rayHitLocal: hitLocals.get(compKey) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number],
            contrastMin: layerContrastMin,
            contrastMax: layerContrastMax,
            gamma: layerGamma,
            opacity: dsSettings.opacity,
            blendMode: channelBlend,
            renderMode: (dsSettings.render_mode || "translucent") as "translucent" | "max_intensity",
            colormap: layerColormap,
            scissorRect,
          });
        }
      }
    } else {
      // Single-channel: existing behavior
      if (viewC >= dsShapeV[1] || viewT >= dsShapeV[0]) continue;

      const members: MemberChunkPlan[] = memberPlanCache.get(dsId)
        ?? [{ image_id: dsId, position: [0, 0], needed: [], prefetch: [] }];

      const chSettings = dsSettings.channel_settings?.[viewC];
      const layerContrastMin = chSettings?.contrast_min ?? dsSettings.contrast_min;
      const layerContrastMax = chSettings?.contrast_max ?? dsSettings.contrast_max;
      const layerGamma = chSettings?.gamma ?? dsSettings.gamma;
      const layerColormap = chSettings?.colormap ?? "gray";

      for (const mp of members) {
        const memberId = mp.image_id;
        const model = new Float32Array(scene.member_model_matrix(dsId, memberId));
        const invModel = new Float32Array(scene.inv_member_model_matrix(dsId, memberId));

        const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
        if (!scissorRect) continue; // well fully off-screen

        layers.push({
          datasetId: memberId,
          modelMatrix: model,
          invModelMatrix: invModel,
          rayHitLocal: hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number],
          contrastMin: layerContrastMin,
          contrastMax: layerContrastMax,
          gamma: layerGamma,
          opacity: dsSettings.opacity,
          blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
          renderMode: (dsSettings.render_mode || "translucent") as "translucent" | "max_intensity",
          colormap: layerColormap,
          scissorRect,
        });
      }
    }
  }

  if (debugStats.enabled) {
    debugStats.renderPassCount = layers.length;
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
  orchestrator: Orchestrator,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene } = ctx;

  // Use full-res viewport for chunk planning so LOD selection isn't affected
  // by renderScale (which drops to 0.25 during interaction).
  const fullW = Math.round(ctx.canvas.clientWidth * devicePixelRatio);
  const fullH = Math.round(ctx.canvas.clientHeight * devicePixelRatio);
  scene.set_viewport(fullW, fullH);

  const canvasW = Math.round(fullW * ctx.renderScale);
  const canvasH = Math.round(fullH * ctx.renderScale);

  const t0 = debugStats.enabled ? performance.now() : 0;
  const orchResult = orchestrator.planAndFetch(ctx, minimapPendingFetch);
  if (debugStats.enabled) debugStats.planTimeMs = performance.now() - t0;
  if (!orchResult) return false;

  // Volume-specific rendering state
  const eye = new Float32Array(scene.eye_position());
  const hitLocals = new Map<string, [number, number, number]>();

  // Compute ray hit locals per member for volume rendering
  for (const [dsId] of ctx.datasets) {
    const plans = orchResult.memberPlanCache.get(dsId);
    if (plans) {
      for (const mp of plans) {
        const hitLocal = Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];
        hitLocals.set(mp.image_id, hitLocal);
      }
    }
    // Multi-channel: check composite keys too
    if (orchResult.multiChannel) {
      for (const [key, plans] of orchResult.memberPlanCache) {
        if (key.startsWith(`${dsId}:ch`)) {
          for (const mp of plans) {
            const rawId = mp.image_id.replace(/:ch\d+$/, "");
            if (!hitLocals.has(mp.image_id)) {
              const hitLocal = Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];
              hitLocals.set(mp.image_id, hitLocal);
            }
          }
        }
      }
    }
  }

  if (debugStats.enabled) {
    const firstDsId = orchResult.settings.layerOrder[0];
    if (firstDsId) {
      const lodInfo = scene.debug_lod_info(firstDsId);
      debugStats.effectiveZoom = lodInfo[0];
      debugStats.zoomPerVoxel = lodInfo[1];
    }
    debugStats.activeChannels = orchResult.multiChannel
      ? getActiveChannels(orchResult.settings.allSettings[orchResult.settings.layerOrder[0]]).length
      : 1;
  }

  const viewT = scene.t();
  const viewC = scene.c();

  const planResult: PlanResult = {
    memberPlanCache: orchResult.memberPlanCache,
    settings: orchResult.settings,
    eye, hitLocals, canvasW, canvasH, fullW, fullH, viewT, viewC,
    multiChannel: orchResult.multiChannel,
    epochs: orchResult.epochs,
  };

  const t1 = debugStats.enabled ? performance.now() : 0;
  const result = uploadAndRenderVolume(ctx, state, planResult, shouldRender);
  if (debugStats.enabled) debugStats.uploadTimeMs = performance.now() - t1;
  return result;
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
