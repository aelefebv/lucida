/** Volume render path: upload chunks with LRU eviction + render multi-pass. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import { VOL_CACHE_BUDGET } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface VolumeState {
  uploaded: Map<string, { uploaded: Set<string>; byteSize: number }>;
  cacheBytes: number;
  lodKeys: Map<string, string>;
}

export function createVolumeState(): VolumeState {
  return {
    uploaded: new Map(),
    cacheBytes: 0,
    lodKeys: new Map(),
  };
}

/**
 * Upload volume chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickVolume(
  ctx: TickContext,
  state: VolumeState,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): boolean {
  const { scene, client, canvas, datasets } = ctx;

  const canvasW = Math.round(canvas.clientWidth * devicePixelRatio * ctx.renderScale);
  const canvasH = Math.round(canvas.clientHeight * devicePixelRatio * ctx.renderScale);
  scene.set_viewport(canvasW, canvasH);

  const viewT = scene.t();
  const viewC = scene.c();

  // Get layer ordering and settings from scene
  const layerOrder: string[] = JSON.parse(scene.layer_order());
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    contrast_min: number;
    contrast_max: number;
    gamma: number;
    blend_mode: string;
    render_mode: string;
  }> = JSON.parse(scene.all_layer_settings());

  let budgetRemaining = UPLOAD_BUDGET_BYTES;
  let exhausted = false;
  let hasPending = false;

  // Upload chunks for ALL datasets
  for (const [dsId, ds] of datasets) {
    // Skip datasets whose C/T are exceeded (volume renders all Z slices)
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

    const plan = evaluateChunkPlanFor(scene, dsId);
    if (!plan) continue;
    const mmPending = minimapPendingFetch.get(dsId);
    const fetchList = mmPending?.length ? [...plan.needed, ...mmPending] : plan.needed;
    if (fetchList.length > 0) {
      ds.store.ensureFetched(fetchList);
    }

    if (plan.needed.length === 0) continue;

    const targetLevel = plan.needed[0].level;
    const levelMeta = ds.info.levels[targetLevel];
    const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

    const lodKey = `${dsId}/${targetLevel}/${viewT}/${viewC}`;
    const lodKeyChanged = state.lodKeys.get(dsId) !== lodKey;
    const texBytes = widthFull * heightFull * depthFull * 2;

    let cached = state.uploaded.get(lodKey);
    if (cached) {
      state.uploaded.delete(lodKey);
      state.uploaded.set(lodKey, cached);
    } else {
      while (state.uploaded.size > 0 && state.cacheBytes + texBytes > VOL_CACHE_BUDGET) {
        const oldestKey = state.uploaded.keys().next().value!;
        const oldest = state.uploaded.get(oldestKey)!;
        state.cacheBytes -= oldest.byteSize;
        state.uploaded.delete(oldestKey);
      }
      cached = { uploaded: new Set(), byteSize: texBytes };
      state.uploaded.set(lodKey, cached);
      state.cacheBytes += texBytes;
    }
    state.lodKeys.set(dsId, lodKey);

    const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
    for (const coord of plan.needed) {
      if (cached.uploaded.has(coord.key)) continue;
      const buf = ds.store.get(coord.key);
      if (!buf || buf.byteLength === 0) { hasPending = true; continue; }
      newChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
      cached.uploaded.add(coord.key);
      budgetRemaining -= buf.byteLength;
      if (budgetRemaining <= 0) {
        exhausted = true;
        break;
      }
    }

    if (newChunks.length > 0 || lodKeyChanged) {
      client.volumeUploadChunksForLayer(
        dsId,
        newChunks,
        targetLevel, viewT, viewC,
        widthFull, heightFull, depthFull,
        chunkX, chunkY, chunkZ,
      );
    }

    if (budgetRemaining <= 0) break;
  }

  // Build layer params for visible layers in order
  const invVP = new Float32Array(scene.inv_view_proj_3d());
  const eye = new Float32Array(scene.eye_position_3d());

  const layers: VolumeLayerParams[] = [];
  for (const dsId of layerOrder) {
    const dsVol = datasets.get(dsId);
    if (!dsVol) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    // Skip layers whose C/T are exceeded (volume renders all Z slices)
    const dsShapeV = dsVol.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShapeV[1] || viewT >= dsShapeV[0]) continue;

    const model = new Float32Array(scene.model_matrix_for(dsId));
    const invModel = new Float32Array(scene.inv_model_matrix_for(dsId));

    layers.push({
      datasetId: dsId,
      modelMatrix: model,
      invModelMatrix: invModel,
      contrastMin: settings.contrast_min,
      contrastMax: settings.contrast_max,
      gamma: settings.gamma,
      opacity: settings.opacity,
      blendMode: settings.blend_mode as "alpha" | "additive" | "max",
      renderMode: (settings.render_mode || "translucent") as "translucent" | "max_intensity",
    });
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH);

  return exhausted || hasPending;
}

export function clearVolumeForDataset(state: VolumeState, dsId: string): void {
  for (const key of [...state.uploaded.keys()]) {
    if (key.startsWith(dsId + "/")) {
      const entry = state.uploaded.get(key)!;
      state.cacheBytes -= entry.byteSize;
      state.uploaded.delete(key);
    }
  }
  state.lodKeys.delete(dsId);
}

export function resetVolumeState(state: VolumeState): void {
  state.uploaded.clear();
  state.cacheBytes = 0;
  state.lodKeys.clear();
}
