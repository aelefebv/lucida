/** Minimap render path: overview seeding + render + overlay callback. */
import { Axis } from "./axes.ts";
import type { MultiscaleInfo } from "./manifestTypes.ts";
import type { MinimapLayerParams } from "./renderer/workerProtocol.ts";
import type { TickContext, MinimapOverlayData } from "./renderLoopTypes.ts";
import { MINIMAP_UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";
import type { MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";

export interface MinimapState {
  overviewKey: Map<string, string>;
  overviewUploaded: Map<string, Set<string>>;
  overviewSeeded: Set<string>;
  pendingFetch: Map<string, MinimapChunkCoord[]>;
  enabled: boolean;
  /**
   * The Explore panel wants the per-dataset coarse overview textures uploaded so
   * it can render thumbnails, even when the minimap itself is hidden
   * (`enabled === false`). This flag drives `tickMinimapOverview` (the GPU
   * upload) WITHOUT enabling the minimap's own render in `tickMinimap` — the
   * thumbnails are rendered on demand by the worker's `thumbnailRender`, not by
   * the loop. Set via `RenderLoop.setThumbnailOverview`.
   */
  overviewActive: boolean;
  size: number;
  overlayCallback: ((data: MinimapOverlayData) => void) | null;
  /** Hash of inputs that affect minimap output — skip render if unchanged. */
  lastRenderKey: string | null;
  /** Set by tickMinimapOverview when new chunks are uploaded to GPU. */
  uploadGeneration: number;
}

export function createMinimapState(): MinimapState {
  return {
    overviewKey: new Map(),
    overviewUploaded: new Map(),
    overviewSeeded: new Set(),
    pendingFetch: new Map(),
    enabled: false,
    overviewActive: false,
    size: 200,
    overlayCallback: null,
    lastRenderKey: null,
    uploadGeneration: 0,
  };
}

export function minimapCoarseLevelIndex(multiscale: Pick<MultiscaleInfo, "levels" | "coarse_level_index">): number | null {
  const explicit = multiscale.coarse_level_index;
  if (typeof explicit === "number") {
    const byLevelIndex = multiscale.levels.findIndex((level) => level.level_index === explicit);
    if (byLevelIndex >= 0) return byLevelIndex;
    if (explicit >= 0 && explicit < multiscale.levels.length) return explicit;
  }
  return null;
}

export interface MinimapDatasetSettings {
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  channel_settings?: { contrast_min: number; contrast_max: number; gamma: number; colormap?: string }[];
}

/**
 * Resolve the colormap the minimap renders a layer with for the active channel.
 *
 * The colormap is per-channel (`channel_settings[c].colormap`). The minimap
 * render reuses the shared volume renderer, whose LUT is only set as a side
 * effect of the 3D main view — so without this the 2D minimap renders gray
 * (the renderer's default LUT) while 3D happens to show the channel colormap.
 * Resolve it here (mirroring `useDatasetSettings.buildLayerInfos`) and bind it
 * for the minimap's own draw so 2D and 3D match.
 */
export function resolveMinimapLayerColormap(settings: MinimapDatasetSettings, activeC: number): string {
  return settings.channel_settings?.[activeC]?.colormap ?? "gray";
}

/**
 * Resolve the contrast/gamma the minimap renders a layer with for the active
 * channel.
 *
 * Auto-contrast (and per-channel user adjustments) are applied at the *channel*
 * level via the `set_channel_contrast` command, so the dataset-level contrast
 * stays at its full-range default (e.g. [0, 65535]) while the active channel
 * holds the data's real range. Rendering the overview with the dataset-level
 * default makes a low-valued volume invisibly dark. Prefer the active channel's
 * values and fall back to dataset-level — mirroring
 * `useDatasetSettings.buildLayerInfos` so the minimap matches the main view.
 */
export function resolveMinimapLayerContrast(
  settings: MinimapDatasetSettings,
  activeC: number,
): { contrastMin: number; contrastMax: number; gamma: number } {
  const ch = settings.channel_settings?.[activeC];
  return {
    contrastMin: ch?.contrast_min ?? settings.contrast_min,
    contrastMax: ch?.contrast_max ?? settings.contrast_max,
    gamma: ch?.gamma ?? settings.gamma,
  };
}

export interface SliceViewBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SliceViewportMemberInput {
  datasetId: string;
  memberId: string;
  modelMatrix: Float32Array;
  position: [number, number];
  width: number;
  height: number;
  depth: number;
}

export function intersectSliceViewWithMember(
  sceneBounds: SliceViewBounds,
  member: SliceViewportMemberInput,
): MinimapOverlayData["sliceViewports"][number] | null {
  const localMinX = Math.max(0, sceneBounds.minX - member.position[0]);
  const localMinY = Math.max(0, sceneBounds.minY - member.position[1]);
  const localMaxX = Math.min(member.width, sceneBounds.maxX - member.position[0]);
  const localMaxY = Math.min(member.height, sceneBounds.maxY - member.position[1]);

  if (localMaxX <= localMinX || localMaxY <= localMinY) {
    return null;
  }

  return {
    datasetId: member.datasetId,
    memberId: member.memberId,
    modelMatrix: member.modelMatrix,
    bounds: { minX: localMinX, minY: localMinY, maxX: localMaxX, maxY: localMaxY },
    width: member.width,
    height: member.height,
    depth: member.depth,
  };
}

/**
 * Mark a dataset's explicit coarse level as fully seeded (all chunks already uploaded).
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
  const multiscale = ds.manifest.images[0].multiscale;
  const coarsestIdx = minimapCoarseLevelIndex(multiscale);
  if (coarsestIdx === null) return;
  const key = `${datasetId}/${coarsestIdx}/${t}/${c}`;
  state.overviewKey.set(datasetId, key);
  state.overviewSeeded.add(datasetId);
  // Mark all chunks as uploaded so progressive path skips
  const levelMeta = multiscale.levels[coarsestIdx];
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
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
 * Upload explicit coarse-level overview chunks for the minimap.
 * Returns true if there are still missing chunks (caller should schedule another frame).
 */
export function tickMinimapOverview(ctx: TickContext, state: MinimapState): boolean {
  // Seed the coarse overview textures whenever the minimap OR the Explore-panel
  // thumbnails need them. The minimap's own render (`tickMinimap`) stays gated on
  // `enabled` alone — thumbnails render via the worker, not the loop.
  if (!state.enabled && !state.overviewActive) return false;

  const { scene, client, datasets } = ctx;
  const t = scene.t();
  const c = scene.c();

  let budgetRemaining = MINIMAP_UPLOAD_BUDGET_BYTES;

  for (const [, ds] of datasets) {
    // Iterate per-member so each tile gets its own minimap overview texture.
    for (const img of ds.manifest.images) {
      const memberId = img.image_id;
      const multiscale = img.multiscale;
      const coarsestIdx = minimapCoarseLevelIndex(multiscale);
      if (coarsestIdx === null) {
        state.pendingFetch.delete(memberId);
        continue;
      }
      const levelMeta = multiscale.levels[coarsestIdx];
      if (!levelMeta) continue;
      const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
      const nz = Math.ceil(levelDepth / chunkZ);
      const ny = Math.ceil(levelHeight / chunkY);
      const nx = Math.ceil(levelWidth / chunkX);
      const totalChunks = nz * ny * nx;
      const overviewKey = `${memberId}/${coarsestIdx}/${t}/${c}`;

      if (state.overviewKey.get(memberId) !== overviewKey) {
        state.overviewUploaded.set(memberId, new Set());
        state.overviewSeeded.delete(memberId);
        state.overviewKey.set(memberId, overviewKey);
      }

      if (state.overviewSeeded.has(memberId)) continue;

      const uploaded = state.overviewUploaded.get(memberId)!;
      const missing: { level: number; x: number; y: number; z: number; t: number; c: number; key: string }[] = [];
      const available: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];

      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const chunkKey = `${coarsestIdx}/${t}/${c}/${iz}/${iy}/${ix}`;
            if (uploaded.has(chunkKey)) continue;

            const cached = ctx.cpuCache.getCachedChunk(memberId, chunkKey);
            if (cached && cached.data.byteLength > 0) {
              // GPU expects uint16 — expand uint8 if needed
              let u16: Uint16Array;
              if (cached.dataType.toLowerCase() === "uint8") {
                const src = new Uint8Array(cached.data);
                u16 = new Uint16Array(src.length);
                u16.set(src);
              } else {
                u16 = new Uint16Array(cached.data);
              }
              available.push({
                data: u16,
                x: ix, y: iy, z: iz, key: chunkKey,
              });
              uploaded.add(chunkKey);
              budgetRemaining -= cached.data.byteLength;
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
        state.pendingFetch.set(memberId, missing);
      } else {
        state.pendingFetch.delete(memberId);
      }

      if (available.length > 0) {
        client.minimapUploadOverviewChunksForLayer(
          memberId, available, t, c,
          levelWidth, levelHeight, levelDepth,
          chunkX, chunkY, chunkZ,
        );
        state.uploadGeneration++;
      }

      if (uploaded.size >= totalChunks) {
        state.overviewSeeded.add(memberId);
      }

      if (budgetRemaining <= 0) break;
    }

    if (budgetRemaining <= 0) break;
  }

  return budgetRemaining <= 0;
}

export function tickMinimap(ctx: TickContext, state: MinimapState, sliceZ: number): void {
  if (!state.enabled) return;

  const { scene, client, canvas, datasets, mode } = ctx;

  const theta = scene.camera_theta();
  const phi = scene.camera_phi();

  // Build a key from minimap-relevant state; skip if unchanged.
  // uploadGeneration ensures we re-render when new overview chunks arrive.
  const settingsSnap = scene.all_dataset_settings();
  const orderSnap = scene.dataset_order();
  // The active channel selects which channel_settings the layer contrast comes
  // from (resolveMinimapLayerContrast), so it is a minimap render input — keep it
  // in the key or switching channels leaves the minimap stale (see the
  // minimap-render-key gotcha).
  const activeC = scene.c();
  // In volume mode, the main camera position affects the frustum overlay
  const mainCamSnap = mode === "volume" ? `${scene.eye_position()}` : `${scene.zoom()}|${scene.center()}`;
  const renderKey = `${theta}|${phi}|${mode}|${sliceZ}|${activeC}|${mainCamSnap}|${orderSnap}|${settingsSnap}|${state.uploadGeneration}`;
  if (renderKey === state.lastRenderKey) return;
  state.lastRenderKey = renderKey;

  const cssSize = state.size;
  const backingSize = Math.round(cssSize * devicePixelRatio);

  const camData = new Float32Array(scene.minimap_camera(theta, phi, backingSize, backingSize));
  const invViewProj = camData.subarray(0, 16);
  const eye = camData.subarray(16, 19);
  const viewProj = camData.subarray(19, 35);

  const layerOrder: string[] = JSON.parse(orderSnap);
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    blend_mode: string;
  } & MinimapDatasetSettings> = JSON.parse(settingsSnap);

  const layers: MinimapLayerParams[] = [];
  const overlayLayers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[] = [];
  const datasetOverlayLayers: MinimapOverlayData["datasetLayers"] = [];
  const sliceViewportMembers: SliceViewportMemberInput[] = [];

  for (const dsId of layerOrder) {
    const ds = datasets.get(dsId);
    if (!ds) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    let memberPositions: Record<string, [number, number]> = {};
    try {
      memberPositions = JSON.parse(scene.member_positions(dsId));
    } catch {
      memberPositions = {};
    }

    for (const img of ds.manifest.images) {
      const memberId = img.image_id;
      const model = new Float32Array(scene.member_model_matrix(dsId, memberId));
      const invModel = new Float32Array(scene.inv_member_model_matrix(dsId, memberId));
      const level0 = img.multiscale.levels[0];

      const { contrastMin, contrastMax, gamma } = resolveMinimapLayerContrast(settings, activeC);
      layers.push({
        datasetId: memberId,
        modelMatrix: model,
        invModelMatrix: invModel,
        contrastMin,
        contrastMax,
        gamma,
        colormap: resolveMinimapLayerColormap(settings, activeC),
      });

      overlayLayers.push({ datasetId: memberId, modelMatrix: model, invModelMatrix: invModel });
      if (level0) {
        sliceViewportMembers.push({
          datasetId: dsId,
          memberId,
          modelMatrix: model,
          position: memberPositions[img.owner] ?? memberPositions[memberId] ?? [0, 0],
          width: level0.shape[Axis.X],
          height: level0.shape[Axis.Y],
          depth: level0.shape[Axis.Z],
        });
      }
    }

    // Dataset-level overlay layer for volume frustum
    const dsModel = new Float32Array(scene.scene_model_matrix_for(dsId));
    const dsInvModel = new Float32Array(scene.inv_scene_model_matrix_for(dsId));
    const volShape = scene.dataset_volume_shape(dsId);
    datasetOverlayLayers.push({
      datasetId: dsId,
      modelMatrix: dsModel,
      invModelMatrix: dsInvModel,
      width: volShape[2],
      height: volShape[1],
      depth: volShape[0],
    });
  }

  if (layers.length > 0) {
    client.minimapRender(layers, invViewProj, eye, backingSize, backingSize);
  }

  if (state.overlayCallback) {
    // Dataset dimensions (per member — all members share the same tile shape)
    const datasetDims = new Map<string, { width: number; height: number; depth: number }>();
    for (const layer of overlayLayers) {
      // Find the parent dataset for this member
      let shape: number[] | undefined;
      for (const [, ds] of datasets) {
        if (ds.manifest.images.some(img => img.image_id === layer.datasetId)) {
          shape = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
          break;
        }
      }
      if (shape) {
        datasetDims.set(layer.datasetId, { width: shape[Axis.X], height: shape[Axis.Y], depth: shape[Axis.Z] });
      }
    }

    // Slice view bounds (2D only), expressed in scene XY coordinates.
    let sliceViewports: MinimapOverlayData["sliceViewports"] = [];
    if (mode === "slice") {
      const mainW = Math.round(canvas.clientWidth * devicePixelRatio);
      const mainH = Math.round(canvas.clientHeight * devicePixelRatio);
      const z = scene.zoom();
      const c = scene.center();
      const halfW = mainW / (2 * z);
      const halfH = mainH / (2 * z);
      const sceneBounds = { minX: c[0] - halfW, minY: c[1] - halfH, maxX: c[0] + halfW, maxY: c[1] + halfH };
      sliceViewports = sliceViewportMembers
        .map((member) => intersectSliceViewWithMember(sceneBounds, member))
        .filter((viewport): viewport is MinimapOverlayData["sliceViewports"][number] => viewport !== null);
    }

    // Main camera inv view-proj (3D only)
    const mainInvViewProj = mode === "volume" ? new Float32Array(scene.inv_view_proj()) : null;
    const currentZ = mode === "slice" ? sliceZ : scene.z();

    state.overlayCallback({
      viewProj,
      layers: overlayLayers,
      datasetLayers: datasetOverlayLayers,
      sliceViewports,
      mode,
      theta,
      phi,
      canvasW: backingSize,
      canvasH: backingSize,
      currentZ,
      datasetDims,
      mainInvViewProj,
    });
  }
}

export function clearMinimapForDataset(state: MinimapState, dsId: string): void {
  // Clear the dataset ID itself (single-member case).
  state.overviewKey.delete(dsId);
  state.overviewUploaded.delete(dsId);
  state.overviewSeeded.delete(dsId);
  state.pendingFetch.delete(dsId);
  // Clear any member-keyed entries (collection case, e.g. "dsId:A/1/0").
  const prefix = dsId + ":";
  for (const key of [...state.overviewKey.keys()]) {
    if (key.startsWith(prefix)) {
      state.overviewKey.delete(key);
      state.overviewUploaded.delete(key);
      state.overviewSeeded.delete(key);
      state.pendingFetch.delete(key);
    }
  }
}
