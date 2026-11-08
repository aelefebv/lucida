/** Minimap render path: overview seeding + render + overlay callback. */
import type { WasmScene } from "lucida-core";
import { Axis } from "./axes.ts";
import type { MultiscaleInfo } from "./manifestTypes.ts";
import type { MinimapLayerParams } from "./renderer/workerProtocol.ts";
import type { TickContext, MinimapOverlayData } from "./renderLoopTypes.ts";
import { MINIMAP_UPLOAD_BUDGET_BYTES, MINIMAP_OVERVIEW_SCAN_INTERVAL_MS } from "./renderLoopTypes.ts";
import type { MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";
import { datasetSampleFormat } from "./renderer/dataTypeUtil.ts";

export interface MinimapState {
  overviewKey: Map<string, string>;
  overviewUploaded: Map<string, Set<string>>;
  overviewSeeded: Set<string>;
  pendingFetch: Map<string, MinimapChunkCoord[]>;
  enabled: boolean;
  /**
   * Keeps the coarse overview textures uploading for Explore-panel thumbnails
   * while the minimap is hidden. It drives `tickMinimapOverview` but not
   * `tickMinimap`: the worker's `thumbnailRender` draws thumbnails on demand.
   */
  overviewActive: boolean;
  size: number;
  overlayCallback: ((data: MinimapOverlayData) => void) | null;
  /**
   * Hash of the inputs that change what the overview draws, where, and at what
   * backing resolution. While it holds, cached member geometry is reused. Display
   * values ride `overviewSettingsSnap` and camera orientation rides
   * `overviewCameraKey`, so neither forces the O(N) member re-read.
   */
  overviewGeometryKey: string | null;
  /**
   * Hash of the volume-mode minimap camera orientation (empty in slice mode,
   * whose minimap camera is fixed). Member geometry is camera-invariant, so a
   * pure orbit recomputes the camera and re-renders from cached geometry.
   */
  overviewCameraKey: string | null;
  /**
   * The raw `all_dataset_settings()` snapshot the cached overview was rendered
   * from. A change flags a settings edit; whether that edit is display-only (a
   * cheap re-render from cached geometry) or a visibility change (a full
   * rebuild) is decided against `overviewVisibilitySig`.
   */
  overviewSettingsSnap: string | null;
  /**
   * Which datasets are drawn, in draw order. A change means a full rebuild; a
   * settings edit that leaves it unchanged is display-only.
   */
  overviewVisibilitySig: string | null;
  /**
   * Hash of the camera inputs that only move the viewport/frustum rectangle on
   * the 2D overlay (slice zoom/center; volume dolly). A change here recomputes
   * just the cheap overlay and reuses the cached overview.
   */
  overlayRenderKey: string | null;
  /**
   * {@link overlayRenderKey} without the Z-plane. A change re-strokes the cached
   * static layer (boxes, frustum); a Z-only change moves just the plane
   * indicator. Drives `staticDirty`. In volume mode it carries the full
   * main-camera pose, so a fly look-around with the eye fixed still re-strokes.
   */
  overlayCamKey: string | null;
  /** Camera-invariant overview outputs, keyed by `overviewGeometryKey`. */
  overviewCache: MinimapOverviewCache | null;
  /** Bumped by tickMinimapOverview when new chunks reach the GPU. */
  uploadGeneration: number;
  /**
   * `performance.now` of the last overview seed-scan, which is throttled to
   * {@link MINIMAP_OVERVIEW_SCAN_INTERVAL_MS}.
   */
  lastOverviewScanMs: number;
  /**
   * The last scan ran out of upload budget, so a throttle-skipped frame keeps
   * scheduling and the deferred uploads aren't stranded by the dirty-driven loop.
   */
  overviewBudgetPending: boolean;
}

/**
 * One drawn member's placement and owning dataset. Display values are left out
 * on purpose: they are resolved at render time, so a display-only edit reuses
 * this unchanged.
 */
export interface MinimapRenderLayerGeometry {
  memberId: string;
  ownerDatasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
}

/**
 * Overview outputs that don't depend on the main camera. Cached so a main-camera
 * move recomputes only the 2D overlay, and a display-only edit re-renders from
 * cached geometry without re-reading members.
 */
export interface MinimapOverviewCache {
  /** Minimap camera view-projection, for the overlay draw. */
  viewProj: Float32Array;
  /** Per-layer geometry for the overview render, in draw order, with no display values baked in. */
  renderLayers: MinimapRenderLayerGeometry[];
  invViewProj: Float32Array;
  eye: Float32Array;
  /** Per-member overlay layers (bounding boxes, slice planes). */
  overlayLayers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[];
  /** Per-dataset overlay layers (volume frustum). */
  datasetOverlayLayers: MinimapOverlayData["datasetLayers"];
  /** Per-member inputs for the slice-viewport intersection. */
  sliceViewportMembers: SliceViewportMemberInput[];
  /** Per-member tile dimensions for the overlay. */
  datasetDims: Map<string, { width: number; height: number; depth: number }>;
  /** Backing pixel size the cached camera/overview were rendered at. */
  backingSize: number;
  /** The cached camera looks straight down Z and ignores orientation. */
  topDown: boolean;
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
    overviewGeometryKey: null,
    overviewCameraKey: null,
    overviewSettingsSnap: null,
    overviewVisibilitySig: null,
    overlayRenderKey: null,
    overlayCamKey: null,
    overviewCache: null,
    uploadGeneration: 0,
    lastOverviewScanMs: Number.NEGATIVE_INFINITY,
    overviewBudgetPending: false,
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
 * The active channel's colormap for a minimap layer. The shared volume
 * renderer's LUT is only set as a side effect of the 3D main view, so the
 * minimap binds its own or 2D renders gray. Mirrors
 * `useDatasetSettings.buildLayerInfos`.
 */
export function resolveMinimapLayerColormap(settings: MinimapDatasetSettings, activeC: number): string {
  return settings.channel_settings?.[activeC]?.colormap ?? "gray";
}

/**
 * The active channel's contrast/gamma for a minimap layer, falling back to the
 * dataset level. Auto-contrast writes channel settings and leaves the dataset
 * level at full range, which renders a low-valued volume invisibly dark.
 * Mirrors `useDatasetSettings.buildLayerInfos`.
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

/** A member's forward/inverse placement matrices, as one bulk-read entry. */
export interface MemberRenderMatrices {
  model: Float32Array;
  invModel: Float32Array;
}

/** Identity matrix, the same fallback the per-id wasm matrix lookups return
 *  for an unknown member, so bulk consumers degrade identically. */
export function identityModelMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/**
 * Read every member's forward and inverse model matrix for a dataset in two
 * wasm calls rather than two per member, since a wide collection has tens of
 * thousands of members. Duplicate ids keep the first entry, matching the
 * per-id lookups.
 */
export function readMemberRenderMatrices(
  scene: WasmScene,
  datasetId: string,
): Map<string, MemberRenderMatrices> {
  const out = new Map<string, MemberRenderMatrices>();
  let ids: string[];
  try {
    ids = JSON.parse(scene.member_render_ids(datasetId));
  } catch {
    return out;
  }
  const flat = scene.member_render_matrices(datasetId);
  for (let i = 0; i < ids.length; i++) {
    if (out.has(ids[i])) continue;
    out.set(ids[i], {
      model: flat.slice(i * 32, i * 32 + 16),
      invModel: flat.slice(i * 32 + 16, i * 32 + 32),
    });
  }
  return out;
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
  // Mark every chunk uploaded so the progressive path skips this dataset.
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

/** Whether any chunk a member awaits is now in the cache, with the scan's own test for usable data. */
function awaitedChunkArrived(ctx: TickContext, state: MinimapState): boolean {
  for (const [memberId, coords] of state.pendingFetch) {
    for (const coord of coords) {
      const cached = ctx.cpuCache.getCachedChunk(memberId, coord.key);
      if (cached && cached.data.byteLength > 0) return true;
    }
  }
  return false;
}

/**
 * Upload explicit coarse-level overview chunks for the minimap.
 * Returns true if the next frame has overview work to do (caller should schedule it).
 */
export function tickMinimapOverview(ctx: TickContext, state: MinimapState, now: number): boolean {
  if (!state.enabled && !state.overviewActive) return false;

  // The scan is O(members × chunks), the dominant per-move CPU cost on large
  // collections, so it is throttled. A skipped frame still returns true while
  // the next scan has something to upload: the loop is dirty-driven, and a tail
  // chunk landing inside the interval would otherwise sit un-uploaded until an
  // unrelated interaction. Waiting for chunks that have not arrived is not such
  // work. Their arrival dirties the loop, and asking for frames until then
  // redraws at frame rate for as long as the fetch takes, forever if nothing
  // requests it.
  if (now - state.lastOverviewScanMs < MINIMAP_OVERVIEW_SCAN_INTERVAL_MS) {
    return state.overviewBudgetPending || awaitedChunkArrived(ctx, state);
  }
  state.lastOverviewScanMs = now;

  const { scene, client, datasets } = ctx;
  const t = scene.t();
  const c = scene.c();

  let budgetRemaining = MINIMAP_UPLOAD_BUDGET_BYTES;

  for (const [, ds] of datasets) {
    // Each member gets its own overview texture.
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
      const available: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[] = [];

      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const chunkKey = `${coarsestIdx}/${t}/${c}/${iz}/${iy}/${ix}`;
            if (uploaded.has(chunkKey)) continue;

            const cached = ctx.cpuCache.getCachedChunk(memberId, chunkKey);
            if (cached && cached.data.byteLength > 0) {
              available.push({
                data: cached.data,
                dataType: cached.dataType,
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
          datasetSampleFormat(ds.manifest),
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

  state.overviewBudgetPending = budgetRemaining <= 0;
  return state.overviewBudgetPending;
}

/** Parsed per-dataset settings, keyed by dataset id (from `all_dataset_settings`). */
type MinimapAllSettings = Record<string, {
  visible: boolean;
  opacity: number;
  blend_mode: string;
} & MinimapDatasetSettings>;

/**
 * Resolve per-layer display params from geometry and current settings, then
 * issue the overview render. The only place layer params are assembled, so a
 * full rebuild and a display-only re-render make the same render call.
 */
function issueMinimapRender(
  client: TickContext["client"],
  renderLayers: MinimapRenderLayerGeometry[],
  allSettings: MinimapAllSettings,
  activeC: number,
  invViewProj: Float32Array,
  eye: Float32Array,
  backingSize: number,
): void {
  const layers: MinimapLayerParams[] = [];
  for (const geom of renderLayers) {
    const settings = allSettings[geom.ownerDatasetId];
    if (!settings) continue;
    const { contrastMin, contrastMax, gamma } = resolveMinimapLayerContrast(settings, activeC);
    layers.push({
      datasetId: geom.memberId,
      modelMatrix: geom.modelMatrix,
      invModelMatrix: geom.invModelMatrix,
      contrastMin,
      contrastMax,
      gamma,
      colormap: resolveMinimapLayerColormap(settings, activeC),
    });
  }
  if (layers.length > 0) {
    client.minimapRender(layers, invViewProj, eye, backingSize, backingSize);
  }
}

/** Re-render a display-only edit from the cached geometry and camera, with no member reads. */
function updateMinimapDisplay(
  client: TickContext["client"],
  cache: MinimapOverviewCache,
  allSettings: MinimapAllSettings,
  activeC: number,
): void {
  issueMinimapRender(
    client,
    cache.renderLayers,
    allSettings,
    activeC,
    cache.invViewProj,
    cache.eye,
    cache.backingSize,
  );
}

/**
 * Each drawn dataset's `visible` flag in draw order. The dataset set and order
 * are already in the geometry key, so only the flags are tracked here.
 */
function minimapVisibilitySignature(layerOrder: string[], allSettings: MinimapAllSettings): string {
  // JSON rather than a delimiter join, so an id containing the delimiter can't
  // alias two visibility states.
  const entries: [string, 0 | 1][] = [];
  for (const dsId of layerOrder) {
    const settings = allSettings[dsId];
    entries.push([dsId, settings && settings.visible ? 1 : 0]);
  }
  return JSON.stringify(entries);
}

/** The minimap camera outputs for one orientation at one backing size. */
interface MinimapCamera {
  viewProj: Float32Array;
  invViewProj: Float32Array;
  eye: Float32Array;
  backingSize: number;
  topDown: boolean;
}

/**
 * The only place `scene.minimap_camera(...)` is unpacked, so a full rebuild and
 * an orbit get identical camera outputs. The 36-float payload is
 * [0..16) invViewProj, [16..19) eye, [19..35) viewProj, [35] topDown (1 or 0).
 */
function computeMinimapCamera(
  scene: WasmScene,
  cssSize: number,
  theta: number,
  phi: number,
): MinimapCamera {
  const backingSize = Math.round(cssSize * devicePixelRatio);
  const camData = new Float32Array(scene.minimap_camera(theta, phi, backingSize, backingSize));
  return {
    viewProj: new Float32Array(camData.subarray(19, 35)),
    invViewProj: new Float32Array(camData.subarray(0, 16)),
    eye: new Float32Array(camData.subarray(16, 19)),
    backingSize,
    topDown: camData[35] === 1,
  };
}

/**
 * Volume-mode orbit: recompute the minimap camera in the cache and re-render
 * from cached geometry, with no member reads.
 */
function updateMinimapCamera(
  scene: WasmScene,
  client: TickContext["client"],
  cache: MinimapOverviewCache,
  cssSize: number,
  activeC: number,
  allSettings: MinimapAllSettings,
  theta: number,
  phi: number,
): void {
  const cam = computeMinimapCamera(scene, cssSize, theta, phi);
  cache.viewProj = cam.viewProj;
  cache.invViewProj = cam.invViewProj;
  cache.eye = cam.eye;
  cache.backingSize = cam.backingSize;
  cache.topDown = cam.topDown;
  issueMinimapRender(client, cache.renderLayers, allSettings, activeC, cache.invViewProj, cache.eye, cache.backingSize);
}

/**
 * Read every member, cache the camera- and display-invariant geometry, and issue
 * the O(N) overview render.
 */
function buildMinimapOverview(
  ctx: TickContext,
  cssSize: number,
  activeC: number,
  layerOrder: string[],
  allSettings: MinimapAllSettings,
  theta: number,
  phi: number,
): MinimapOverviewCache {
  const { scene, client, datasets } = ctx;

  const { viewProj, invViewProj, eye, backingSize, topDown } = computeMinimapCamera(scene, cssSize, theta, phi);

  const renderLayers: MinimapRenderLayerGeometry[] = [];
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

    const memberMatrices = readMemberRenderMatrices(scene, dsId);

    for (const img of ds.manifest.images) {
      const memberId = img.image_id;
      const mats = memberMatrices.get(memberId);
      const model = mats?.model ?? identityModelMatrix();
      const invModel = mats?.invModel ?? identityModelMatrix();
      const level0 = img.multiscale.levels[0];

      renderLayers.push({ memberId, ownerDatasetId: dsId, modelMatrix: model, invModelMatrix: invModel });

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

  issueMinimapRender(client, renderLayers, allSettings, activeC, invViewProj, eye, backingSize);

  // All members of a dataset share one tile shape. One pass over the datasets
  // builds the lookup; scanning per overlay layer would be quadratic.
  const shapeByMember = new Map<string, number[] | undefined>();
  for (const [, ds] of datasets) {
    const shape = ds.manifest.images[0]?.multiscale.levels[0]?.shape; // [T, C, Z, Y, X]
    for (const img of ds.manifest.images) {
      if (!shapeByMember.has(img.image_id)) {
        shapeByMember.set(img.image_id, shape);
      }
    }
  }
  const datasetDims = new Map<string, { width: number; height: number; depth: number }>();
  for (const layer of overlayLayers) {
    const shape = shapeByMember.get(layer.datasetId);
    if (shape) {
      datasetDims.set(layer.datasetId, { width: shape[Axis.X], height: shape[Axis.Y], depth: shape[Axis.Z] });
    }
  }

  return {
    viewProj,
    renderLayers,
    invViewProj,
    eye,
    overlayLayers,
    datasetOverlayLayers,
    sliceViewportMembers,
    datasetDims,
    backingSize,
    topDown,
  };
}

/**
 * The scene's `content` and `layout` epochs, for the overview key. A layout
 * switch or dataset add/remove can leave every other overview input unchanged,
 * so without these the cache could keep drawing old placement or a removed
 * dataset. A missing binding or malformed payload falls back to a stable
 * constant, as in `tickCoordinator`.
 */
export function readMinimapOverviewEpochs(scene: WasmScene): { content: number; layout: number } {
  if (typeof scene.epochs !== "function") return { content: 0, layout: 0 };
  try {
    const raw = JSON.parse(scene.epochs());
    return { content: raw.content ?? 0, layout: raw.layout ?? 0 };
  } catch {
    return { content: 0, layout: 0 };
  }
}

export function tickMinimap(ctx: TickContext, state: MinimapState, sliceZ: number): void {
  if (!state.enabled) return;

  const { scene, canvas, mode } = ctx;

  const theta = scene.camera_theta();
  const phi = scene.camera_phi();

  const settingsSnap = scene.all_dataset_settings();
  const orderSnap = scene.dataset_order();
  // The active channel picks which channel_settings the contrast comes from, so
  // it belongs in the overview key or a channel switch leaves the minimap stale.
  const activeC = scene.c();

  const { content: contentEpoch, layout: layoutEpoch } = readMinimapOverviewEpochs(scene);

  // Four keys split the per-tick work by what each input affects:
  //  - geometry key: what the overview draws, where, and at what backing size.
  //    Any change re-reads every member.
  //  - camera key: volume minimap orientation. An orbit re-renders from cached
  //    geometry. Empty in slice mode, whose minimap camera is fixed.
  //  - settings snapshot: a display-only edit re-renders from cached geometry; a
  //    visibility change forces a full rebuild.
  //  - overlay key: inputs that only move the viewport/frustum rectangle on the
  //    2D overlay. Never triggers an overview render.
  const cameraKey = mode === "volume" ? `${theta}|${phi}` : "";
  // DPR and size set the backing pixel size, so a DPR change (window dragged
  // across monitors) or a resize must rebuild, or a later display-only edit
  // renders with the stale camera. Z is left out: the overview render takes no
  // Z, so a Z-scrub refreshes only the overlay.
  const geometryKey = `${mode}|${activeC}|${contentEpoch}|${layoutEpoch}|${orderSnap}|${state.uploadGeneration}|${devicePixelRatio}|${state.size}`;
  // Only slice mode draws a Z-dependent overlay element, so Z joins the overlay
  // key there alone. Volume mode keys on `inv_view_proj()`, the frustum's
  // source: `eye_position()` alone would miss a fly look-around, where the view
  // rotates with the eye fixed and the frustum would freeze.
  const overlayCamSnap =
    mode === "volume"
      ? `${scene.eye_position()}|${scene.inv_view_proj()}`
      : `${scene.zoom()}|${scene.center()}`;
  const overlayCamKey = `${mode}|${overlayCamSnap}`;
  const zForOverlay = mode === "slice" ? sliceZ : 0;
  const overlayKey = `${overlayCamKey}|${zForOverlay}`;

  const geometryChanged = geometryKey !== state.overviewGeometryKey;
  const cameraChanged = cameraKey !== state.overviewCameraKey;
  const settingsChanged = settingsSnap !== state.overviewSettingsSnap;
  const overlayChanged = overlayKey !== state.overlayRenderKey;
  if (!geometryChanged && !cameraChanged && !settingsChanged && !overlayChanged && state.overviewCache) return;
  // A top-down camera ignores orientation, so an orbit leaves it and the
  // overview unchanged.
  const orbited = cameraChanged && !state.overviewCache?.topDown;

  let rebuilt = false;
  if (geometryChanged || !state.overviewCache) {
    const layerOrder: string[] = JSON.parse(orderSnap);
    const allSettings: MinimapAllSettings = JSON.parse(settingsSnap);
    state.overviewCache = buildMinimapOverview(ctx, state.size, activeC, layerOrder, allSettings, theta, phi);
    state.overviewVisibilitySig = minimapVisibilitySignature(layerOrder, allSettings);
    rebuilt = true;
  } else if (settingsChanged) {
    // A visibility change rebuilds; a display-only edit re-renders from cache.
    const layerOrder: string[] = JSON.parse(orderSnap);
    const allSettings: MinimapAllSettings = JSON.parse(settingsSnap);
    const visibilitySig = minimapVisibilitySignature(layerOrder, allSettings);
    if (visibilitySig !== state.overviewVisibilitySig) {
      state.overviewCache = buildMinimapOverview(ctx, state.size, activeC, layerOrder, allSettings, theta, phi);
      state.overviewVisibilitySig = visibilitySig;
      rebuilt = true;
    } else if (orbited) {
      updateMinimapCamera(scene, ctx.client, state.overviewCache, state.size, activeC, allSettings, theta, phi);
    } else {
      updateMinimapDisplay(ctx.client, state.overviewCache, allSettings, activeC);
    }
  } else if (orbited) {
    // A rotated volume looks different, so the overview must still redraw.
    const allSettings: MinimapAllSettings = JSON.parse(settingsSnap);
    updateMinimapCamera(scene, ctx.client, state.overviewCache, state.size, activeC, allSettings, theta, phi);
  }
  // A dolly, pan, zoom, or Z-scrub falls through to the overlay alone.
  //
  // The static layer is drawn in the minimap's own viewProj. In slice mode that
  // camera is fixed, so only a rebuild re-strokes it. In volume mode the layer
  // also carries the main camera's frustum, so an orbit or any main-camera move
  // re-strokes too. Computed before the keys advance.
  const staticDirty =
    mode === "volume"
      ? rebuilt || cameraChanged || overlayCamKey !== state.overlayCamKey
      : rebuilt;

  state.overviewGeometryKey = geometryKey;
  state.overviewCameraKey = cameraKey;
  state.overviewSettingsSnap = settingsSnap;
  state.overlayRenderKey = overlayKey;
  state.overlayCamKey = overlayCamKey;

  const cache = state.overviewCache;

  // The overlay depends on camera and geometry, not display values.
  if (state.overlayCallback && cache && (rebuilt || cameraChanged || overlayChanged)) {
    // Slice view bounds in scene XY.
    let sliceViewports: MinimapOverlayData["sliceViewports"] = [];
    if (mode === "slice") {
      const mainW = Math.round(canvas.clientWidth * devicePixelRatio);
      const mainH = Math.round(canvas.clientHeight * devicePixelRatio);
      const z = scene.zoom();
      const c = scene.center();
      const halfW = mainW / (2 * z);
      const halfH = mainH / (2 * z);
      const sceneBounds = { minX: c[0] - halfW, minY: c[1] - halfH, maxX: c[0] + halfW, maxY: c[1] + halfH };
      sliceViewports = cache.sliceViewportMembers
        .map((member) => intersectSliceViewWithMember(sceneBounds, member))
        .filter((viewport): viewport is MinimapOverlayData["sliceViewports"][number] => viewport !== null);
    }

    const mainInvViewProj = mode === "volume" ? new Float32Array(scene.inv_view_proj()) : null;
    const currentZ = mode === "slice" ? sliceZ : scene.z();

    state.overlayCallback({
      viewProj: cache.viewProj,
      layers: cache.overlayLayers,
      datasetLayers: cache.datasetOverlayLayers,
      sliceViewports,
      mode,
      topDown: cache.topDown,
      theta,
      phi,
      canvasW: cache.backingSize,
      canvasH: cache.backingSize,
      currentZ,
      datasetDims: cache.datasetDims,
      mainInvViewProj,
      staticDirty,
    });
  }
}

/** Make the next tick rebuild the overview and redraw every overlay layer. */
export function invalidateMinimapOverview(state: MinimapState): void {
  state.overviewGeometryKey = null;
}

/** The worker lost every overview texture with its device: upload them all again, starting next tick. */
export function forgetMinimapOverviewUploads(state: MinimapState): void {
  state.overviewKey.clear();
  state.overviewUploaded.clear();
  state.overviewSeeded.clear();
  state.lastOverviewScanMs = Number.NEGATIVE_INFINITY;
  invalidateMinimapOverview(state);
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
