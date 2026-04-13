/** Slice render path: upload chunks + render multi-pass. */
import type { ChunkCoord, SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberChunkPlan } from "./uploadCommon.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { getActiveChannels, compositeKey, parseChannel } from "./tickCommon.ts";
import type { SceneSettings } from "./tickCommon.ts";
import {
  type UploadState,
  type MemberUploadActions,
  uploadChunksForMembers,
  clearUploadStateForDataset,
  clearUploadStateForMembers,
} from "./uploadCommon.ts";
import type { ContentGraph } from "./contentTypes.ts";
import type { Orchestrator } from "./pipeline/orchestrator.ts";
import { debugStats } from "./debug/debugStats.ts";

/** Backward-compatible alias. */
export type SliceState = UploadState;

export { createUploadState as createSliceState } from "./uploadCommon.ts";

/** Result of the plan+fetch phase, passed to the upload+render phase. */
interface SlicePlanResult {
  memberPlanCache: Map<string, MemberChunkPlan[]>;
  settings: SceneSettings;
  vpCx: number;
  vpCy: number;
  multiChannel: boolean;
}

/**
 * Upload+render phase: upload fine chunks within budget, build layer
 * params, and render.
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
  const { memberPlanCache, settings, multiChannel } = planResult;

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  const dpr = devicePixelRatio;
  const canvasW = Math.round(canvas.clientWidth * dpr);
  const canvasH = Math.round(canvas.clientHeight * dpr);

  const shouldSkipDataset = (cacheKey: string, ds: { content: ContentGraph }) => {
    const dsShape = ds.content.images[0].multiscale.levels[0].shape;
    if (multiChannel) {
      // In multi-channel mode, cache keys are `${dsId}:ch${ch}` — the plan
      // phase already filtered channels, so nothing to skip here.
      // But we still need to validate the dataset exists.
      return !ds;
    }
    return z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0];
  };

  const uploadDiag = debugStats.enabled ? {
    atlasConfigSent: false,
    stateKey: "",
    prevStateKey: "",
    chunksAttempted: 0,
    chunksUploaded: 0,
    chunksCacheHit: 0,
    chunksCacheMiss: 0,
    chunksSentSkip: 0,
  } : null;

  const createActions = (memberId: string, mp: MemberChunkPlan, ds: { sharedQueue: SharedChunkQueue; content: ContentGraph }, _dsId: string): MemberUploadActions | null => {
    const level = mp.needed[0]?.level;
    if (level === undefined) return null;

    const multiscale = ds.content.images[0].multiscale;
    const levelMeta = multiscale.levels[level];
    if (!levelMeta) return null;

    const [, , , levelHeight, levelWidth] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
    const fullResDepth = multiscale.levels[0].shape[2];
    const levelDepth = levelMeta.shape[2];

    // In multi-channel mode, memberId is a composite key; extract the channel
    const ch = multiChannel ? (parseChannel(memberId) ?? c) : c;

    const sk = `${t}/${ch}/${z}/${level}`;
    if (uploadDiag) {
      uploadDiag.stateKey = sk;
      uploadDiag.prevStateKey = state.prevStateKey.get(memberId) ?? "(none)";
    }

    return {
      stateKey: sk,

      sendAtlasConfig() {
        if (uploadDiag) uploadDiag.atlasConfigSent = true;
        client.sliceAtlasConfig(
          memberId, level, z, t, ch,
          levelWidth, levelHeight,
          chunkX, chunkY,
        );
      },

      sendFineChunks(chunks) {
        if (uploadDiag) uploadDiag.chunksUploaded += chunks.length;
        client.sliceChunkData(
          memberId, chunks,
          level, z, t, ch,
          levelWidth, levelHeight,
          chunkX, chunkY, chunkZ,
          fullResDepth, levelDepth, z,
        );
      },
    };
  };

  // Set BEFORE upload loop so uploadCommon's counters go to the right object
  if (uploadDiag) debugStats.uploadDebug = uploadDiag;

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

    const dsShapeL = ds.content.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    const fullResWidth = dsShapeL[4];
    const fullResHeight = dsShapeL[3];

    if (multiChannel) {
      // Multi-channel: emit one layer per (member, channel) with per-channel settings
      const activeChannels = getActiveChannels(dsSettings);
      const channelBlend = dsSettings.channel_blend_mode as "alpha" | "additive" | "max" || "additive";

      for (const ch of activeChannels) {
        if (z >= dsShapeL[2] || ch >= dsShapeL[1] || t >= dsShapeL[0]) continue;

        const chSettings = dsSettings.channel_settings?.[ch];
        const layerContrastMin = chSettings?.contrast_min ?? dsSettings.contrast_min;
        const layerContrastMax = chSettings?.contrast_max ?? dsSettings.contrast_max;
        const layerGamma = chSettings?.gamma ?? dsSettings.gamma;
        const layerColormap = chSettings?.colormap ?? "gray";

        const planCacheKey = `${dsId}:ch${ch}`;
        const members: MemberChunkPlan[] = memberPlanCache.get(planCacheKey)
          ?? [{ image_id: dsId, position: [0, 0], needed: [], prefetch: [] }];

        for (const mp of members) {
          layers.push({
            datasetId: compositeKey(mp.image_id, ch),
            dataW: fullResWidth,
            dataH: fullResHeight,
            contrastMin: layerContrastMin,
            contrastMax: layerContrastMax,
            gamma: layerGamma,
            opacity: dsSettings.opacity,
            blendMode: channelBlend,
            colormap: layerColormap,
            offsetX: mp.position[0],
            offsetY: mp.position[1],
          });
        }
      }
    } else {
      // Single-channel: existing behavior
      if (z >= dsShapeL[2] || c >= dsShapeL[1] || t >= dsShapeL[0]) continue;

      const members: MemberChunkPlan[] = memberPlanCache.get(dsId)
        ?? [{ image_id: dsId, position: [0, 0], needed: [], prefetch: [] }];

      const chSettings = dsSettings.channel_settings?.[c];
      const layerContrastMin = chSettings?.contrast_min ?? dsSettings.contrast_min;
      const layerContrastMax = chSettings?.contrast_max ?? dsSettings.contrast_max;
      const layerGamma = chSettings?.gamma ?? dsSettings.gamma;
      const layerColormap = chSettings?.colormap ?? "gray";

      for (const mp of members) {
        layers.push({
          datasetId: mp.image_id,
          dataW: fullResWidth,
          dataH: fullResHeight,
          contrastMin: layerContrastMin,
          contrastMax: layerContrastMax,
          gamma: layerGamma,
          opacity: dsSettings.opacity,
          blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
          colormap: layerColormap,
          offsetX: mp.position[0],
          offsetY: mp.position[1],
        });
      }
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
  orchestrator: Orchestrator,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene, canvas } = ctx;

  // Set scene params before orchestrator queries WASM state
  scene.set_z(sliceZ);
  scene.set_t(sliceT);
  scene.set_c(sliceC);
  const dpr = devicePixelRatio;
  const canvasW = Math.round(canvas.clientWidth * dpr);
  const canvasH = Math.round(canvas.clientHeight * dpr);
  scene.set_viewport(canvasW, canvasH);

  const orchResult = orchestrator.planAndFetch(ctx, minimapPendingFetch);
  if (!orchResult) return false;

  const vpCenter = scene.center();
  const planResult: SlicePlanResult = {
    memberPlanCache: orchResult.memberPlanCache,
    settings: orchResult.settings,
    vpCx: vpCenter[0],
    vpCy: vpCenter[1],
    multiChannel: orchResult.multiChannel,
  };

  return uploadAndRenderSlice(ctx, state, sliceZ, sliceT, sliceC, planResult, shouldRender);
}

export function clearSliceForDataset(state: SliceState, dsId: string): void {
  clearUploadStateForDataset(state, dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearSliceForMembers(state: SliceState, memberIds: string[]): void {
  clearUploadStateForMembers(state, memberIds);
}
