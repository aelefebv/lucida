/** Minimap render path: overview seeding + render + overlay callback. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { MinimapLayerParams } from "./renderer/workerProtocol.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext, MinimapOverlayData } from "./renderLoopTypes.ts";
import { MINIMAP_UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface MinimapState {
  overviewKey: Map<string, string>;
  overviewUploaded: Map<string, Set<string>>;
  overviewSeeded: Set<string>;
  pendingFetch: Map<string, ChunkCoord[]>;
  enabled: boolean;
  size: number;
  overlayCallback: ((data: MinimapOverlayData) => void) | null;
}

export function createMinimapState(): MinimapState {
  return {
    overviewKey: new Map(),
    overviewUploaded: new Map(),
    overviewSeeded: new Set(),
    pendingFetch: new Map(),
    enabled: false,
    size: 200,
    overlayCallback: null,
  };
}

/**
 * Mark a dataset's coarsest level as fully seeded (all chunks already uploaded).
 * Called when overview data was bulk-uploaded externally.
 */
export function markMinimapOverviewSeeded(
  ctx: TickContext,
  state: MinimapState,
  datasetId: string,
  t: number,
  c: number,
): void {
  const ds = ctx.datasets.get(datasetId);
  if (!ds) return;
  const coarsestIdx = ds.info.levels.length - 1;
  const key = `${datasetId}/${coarsestIdx}/${t}/${c}`;
  state.overviewKey.set(datasetId, key);
  state.overviewSeeded.add(datasetId);
  // Mark all chunks as uploaded so progressive path skips
  const levelMeta = ds.info.levels[coarsestIdx];
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
  const nz = Math.ceil(levelDepth / chunkZ);
  const ny = Math.ceil(levelHeight / chunkY);
  const nx = Math.ceil(levelWidth / chunkX);
  const uploadedSet = new Set<string>();
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        uploadedSet.add(`${coarsestIdx}/${t}/${c}/${iz}/${iy}/${ix}`);
      }
    }
  }
  state.overviewUploaded.set(datasetId, uploadedSet);
}

/**
 * Upload coarsest-level overview chunks for the minimap.
 * Returns true if there are still missing chunks (caller should schedule another frame).
 */
export function tickMinimapOverview(ctx: TickContext, state: MinimapState): boolean {
  if (!state.enabled) return false;

  const { scene, client, datasets } = ctx;
  const t = scene.t();
  const c = scene.c();

  let budgetRemaining = MINIMAP_UPLOAD_BUDGET_BYTES;
  let needsRetry = false;

  for (const [dsId, ds] of datasets) {
    const coarsestIdx = ds.info.levels.length - 1;
    const overviewKey = `${dsId}/${coarsestIdx}/${t}/${c}`;

    // If key changed, reset tracking
    if (state.overviewKey.get(dsId) !== overviewKey) {
      state.overviewUploaded.set(dsId, new Set());
      state.overviewSeeded.delete(dsId);
      state.overviewKey.set(dsId, overviewKey);
    }

    // Already fully seeded at matching key
    if (state.overviewSeeded.has(dsId)) continue;

    const levelMeta = ds.info.levels[coarsestIdx];
    const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
    const nz = Math.ceil(levelDepth / chunkZ);
    const ny = Math.ceil(levelHeight / chunkY);
    const nx = Math.ceil(levelWidth / chunkX);

    const uploaded = state.overviewUploaded.get(dsId)!;
    const missing: { level: number; x: number; y: number; z: number; t: number; c: number; key: string }[] = [];
    const available: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];

    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const chunkKey = `${coarsestIdx}/${t}/${c}/${iz}/${iy}/${ix}`;
          if (uploaded.has(chunkKey)) continue;

          const buf = ds.store.get(chunkKey);
          if (buf && buf.byteLength > 0) {
            available.push({
              data: bufferToUint16(buf, levelMeta.dataType),
              x: ix, y: iy, z: iz, key: chunkKey,
            });
            uploaded.add(chunkKey);
            budgetRemaining -= buf.byteLength;
            if (budgetRemaining <= 0) break;
          } else {
            missing.push({ level: coarsestIdx, x: ix, y: iy, z: iz, t, c, key: chunkKey });
          }
        }
        if (budgetRemaining <= 0) break;
      }
      if (budgetRemaining <= 0) break;
    }

    if (missing.length > 0) {
      state.pendingFetch.set(dsId, missing);
      needsRetry = true;
    } else {
      state.pendingFetch.delete(dsId);
    }

    if (available.length > 0) {
      client.minimapUploadOverviewChunksForLayer(
        dsId, available, t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
      );
    }

    // Check if all chunks are now uploaded
    const totalChunks = nz * ny * nx;
    if (uploaded.size >= totalChunks) {
      state.overviewSeeded.add(dsId);
    }

    if (budgetRemaining <= 0) break;
  }

  return needsRetry;
}

/** Render the minimap and invoke the overlay callback. */
export function tickMinimap(ctx: TickContext, state: MinimapState, sliceZ: number): void {
  if (!state.enabled) return;

  const { scene, client, canvas, datasets, mode } = ctx;

  const theta = scene.camera_theta();
  const phi = scene.camera_phi();
  const cssSize = state.size;
  const backingSize = Math.round(cssSize * devicePixelRatio);

  const camData = new Float32Array(scene.minimap_camera(theta, phi, backingSize, backingSize));
  const invViewProj = camData.subarray(0, 16);
  const eye = camData.subarray(16, 19);
  const viewProj = camData.subarray(19, 35);

  const layerOrder: string[] = JSON.parse(scene.dataset_order());
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    contrast_min: number;
    contrast_max: number;
    gamma: number;
    blend_mode: string;
  }> = JSON.parse(scene.all_dataset_settings());

  const layers: MinimapLayerParams[] = [];
  const overlayLayers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[] = [];

  for (const dsId of layerOrder) {
    if (!datasets.has(dsId)) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    const model = new Float32Array(scene.scene_model_matrix_for(dsId));
    const invModel = new Float32Array(scene.inv_scene_model_matrix_for(dsId));

    layers.push({
      datasetId: dsId,
      modelMatrix: model,
      invModelMatrix: invModel,
      contrastMin: settings.contrast_min,
      contrastMax: settings.contrast_max,
      gamma: settings.gamma,
    });

    overlayLayers.push({ datasetId: dsId, modelMatrix: model, invModelMatrix: invModel });
  }

  if (layers.length > 0) {
    client.minimapRender(layers, invViewProj, eye, backingSize, backingSize);
  }

  if (state.overlayCallback) {
    // Dataset dimensions
    const datasetDims = new Map<string, { width: number; height: number; depth: number }>();
    for (const layer of overlayLayers) {
      const ds = datasets.get(layer.datasetId);
      if (ds) {
        const shape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
        datasetDims.set(layer.datasetId, { width: shape[4], height: shape[3], depth: shape[2] });
      }
    }

    // Slice view bounds (2D only)
    let sliceViewBounds: MinimapOverlayData["sliceViewBounds"] = null;
    if (mode === "slice") {
      const mainW = canvas.clientWidth;
      const mainH = canvas.clientHeight;
      const z = scene.zoom();
      const c = scene.center();
      const halfW = mainW / (2 * z);
      const halfH = mainH / (2 * z);
      sliceViewBounds = { minX: c[0] - halfW, minY: c[1] - halfH, maxX: c[0] + halfW, maxY: c[1] + halfH };
    }

    // Main camera inv view-proj (3D only)
    const mainInvViewProj = mode === "volume" ? new Float32Array(scene.inv_view_proj()) : null;
    const currentZ = mode === "slice" ? sliceZ : scene.z();

    state.overlayCallback({
      viewProj,
      layers: overlayLayers,
      mode,
      theta,
      phi,
      canvasW: backingSize,
      canvasH: backingSize,
      currentZ,
      datasetDims,
      sliceViewBounds,
      mainInvViewProj,
    });
  }
}

export function clearMinimapForDataset(state: MinimapState, dsId: string): void {
  state.overviewKey.delete(dsId);
  state.overviewUploaded.delete(dsId);
  state.overviewSeeded.delete(dsId);
  state.pendingFetch.delete(dsId);
}
