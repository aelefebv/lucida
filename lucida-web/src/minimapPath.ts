/** Minimap render path: overview seeding + render + overlay callback. */
import type { WasmScene } from "lucida-core";
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
  /**
   * Hash of the GEOMETRY inputs that change what the overview draws, where, and
   * at what backing resolution: mode, z/channel, dataset order, upload
   * generation, the scene's content + layout epochs, the minimap size and
   * devicePixelRatio (which set the backing pixel size the camera and overview
   * are rendered at), and — in volume mode only — the camera orientation. When
   * this is unchanged the cached member geometry is reused and no members are
   * re-read. Per-layer display values (contrast/gamma/colormap/opacity) are NOT
   * here — those ride the settings snapshot below so a display-only edit skips
   * the O(N) member re-read.
   */
  overviewGeometryKey: string | null;
  /**
   * The raw `all_dataset_settings()` snapshot the cached overview was rendered
   * from. A change flags a settings edit; whether that edit is display-only (a
   * cheap re-render from cached geometry) or a visibility change (a full
   * rebuild) is decided against `overviewVisibilitySig`.
   */
  overviewSettingsSnap: string | null;
  /**
   * Signature of which datasets are drawn (visible) in draw order. Recomputed
   * only when the settings snapshot changes; it distinguishes a geometry change
   * (a layer appears/disappears → full rebuild) from a display-only edit (same
   * drawn set → cheap display re-render).
   */
  overviewVisibilitySig: string | null;
  /**
   * Hash of the camera inputs that only move the viewport/frustum rectangle on
   * the 2D overlay (slice zoom/center; volume dolly). A change here recomputes
   * just the cheap overlay and reuses the cached overview.
   */
  overlayRenderKey: string | null;
  /** Camera-invariant overview outputs, cached keyed by `overviewGeometryKey`. */
  overviewCache: MinimapOverviewCache | null;
  /** Set by tickMinimapOverview when new chunks are uploaded to GPU. */
  uploadGeneration: number;
}

/**
 * One drawn member's placement, with the owning dataset id so the per-layer
 * display params (contrast/gamma/colormap) can be resolved from fresh settings
 * without re-reading the member. Display values are deliberately absent — they
 * are applied at render time, so a display-only edit reuses this unchanged.
 */
export interface MinimapRenderLayerGeometry {
  memberId: string;
  ownerDatasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
}

/**
 * The overview-derived outputs that do not depend on the main camera's
 * pan/zoom (slice) or dolly (volume). Cached across ticks so a camera-only
 * change recomputes only the 2D overlay instead of re-reading every member and
 * re-issuing the O(N) GPU overview render, and so a display-only edit re-issues
 * the overview render from the cached geometry without re-reading members.
 */
export interface MinimapOverviewCache {
  /** minimap camera view-projection (for the overlay draw). */
  viewProj: Float32Array;
  /**
   * The camera-invariant per-layer GEOMETRY the GPU overview render needs
   * (member id, owning dataset, placement matrices) with NO display values
   * baked in. A display-only edit rebuilds the overview render from these plus
   * the fresh settings — no members are re-read. In draw order.
   */
  renderLayers: MinimapRenderLayerGeometry[];
  /** minimap camera inverse view-projection passed to the overview render. */
  invViewProj: Float32Array;
  /** minimap camera eye position passed to the overview render. */
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
    overviewSettingsSnap: null,
    overviewVisibilitySig: null,
    overlayRenderKey: null,
    overviewCache: null,
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

/** A member's forward/inverse placement matrices, as one bulk-read entry. */
export interface MemberRenderMatrices {
  model: Float32Array;
  invModel: Float32Array;
}

/** Identity matrix — the same fallback the per-id wasm matrix lookups return
 *  for an unknown member, so bulk consumers degrade identically. */
export function identityModelMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/**
 * Read every member's forward + inverse model matrix for a dataset in two
 * wasm calls (`member_render_ids` + `member_render_matrices`) instead of two
 * calls *per member* (`member_model_matrix` / `inv_member_model_matrix`).
 * A wide collection has tens of thousands of members, so the per-member form
 * crosses the wasm boundary tens of thousands of times per pass; the bulk
 * form crosses twice and yields byte-identical matrices (same
 * `Scene::rendering_transform` source). Duplicate ids keep the first entry,
 * matching the per-id lookups' first-match resolution.
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

/** Parsed per-dataset settings, keyed by dataset id (from `all_dataset_settings`). */
type MinimapAllSettings = Record<string, {
  visible: boolean;
  opacity: number;
  blend_mode: string;
} & MinimapDatasetSettings>;

/**
 * Build the per-layer display params from cached member geometry + the current
 * settings and issue the GPU overview render. The one place layer params are
 * assembled, so the full rebuild and the display-only re-render produce a
 * byte-identical render call: same layer order, same resolved
 * contrast/gamma/colormap, same camera. Only the display values differ between
 * calls — the geometry (ids, matrices) is reused verbatim.
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

/**
 * Re-issue the overview render for a display-only edit (contrast/gamma/colormap/
 * opacity): reuse the cached member geometry and camera, recompute only the
 * per-layer display params from the fresh settings. No members are re-read and
 * no geometry is rebuilt — the O(N) `member_render_*` / `member_positions` /
 * `scene_model_matrix_for` reads are skipped entirely.
 */
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
 * Signature of the drawn (visible) dataset set in draw order. Recomputed only
 * when the settings snapshot changes, it separates a display-only edit (same
 * signature → cheap `updateMinimapDisplay`) from a visibility change (a layer
 * appears/disappears → full `buildMinimapOverview`). The dataset SET and order
 * are covered by the geometry key (content/layout epochs + dataset order), so
 * this only needs to track each drawn dataset's `visible` flag.
 */
function minimapVisibilitySignature(layerOrder: string[], allSettings: MinimapAllSettings): string {
  // JSON-encode [dsId, flag] pairs in draw order rather than delimiter-joining
  // them: a raw `${dsId}:${flag}` join could alias two distinct visibility states
  // if a dataset id contained the delimiter. Structural encoding removes that
  // collision class entirely, mirroring how the geometry key embeds JSON.
  const entries: [string, 0 | 1][] = [];
  for (const dsId of layerOrder) {
    const settings = allSettings[dsId];
    entries.push([dsId, settings && settings.visible ? 1 : 0]);
  }
  return JSON.stringify(entries);
}

/**
 * Read every member, cache the camera-invariant + display-invariant GEOMETRY,
 * and issue the O(N) GPU overview redraw. Split out of `tickMinimap` so a
 * camera-only change reuses the cache and skips all of this, and a display-only
 * change reuses `cache.renderLayers` via `updateMinimapDisplay` instead.
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

  const backingSize = Math.round(cssSize * devicePixelRatio);

  const camData = new Float32Array(scene.minimap_camera(theta, phi, backingSize, backingSize));
  const invViewProj = new Float32Array(camData.subarray(0, 16));
  const eye = new Float32Array(camData.subarray(16, 19));
  const viewProj = camData.subarray(19, 35);

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

  issueMinimapRender(client, renderLayers, allSettings, activeC, invViewProj, eye, backingSize);

  // Dataset dimensions (per member — all members share the same tile shape).
  // Member id → owning dataset's first-image level-0 shape, built in one pass
  // over the datasets: resolving each overlay layer by scanning every dataset's
  // image list would be quadratic in member count.
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
    viewProj: new Float32Array(viewProj),
    renderLayers,
    invViewProj,
    eye,
    overlayLayers,
    datasetOverlayLayers,
    sliceViewportMembers,
    datasetDims,
    backingSize,
  };
}

/**
 * Read the scene's `content` and `layout` epoch counters — the placement/set
 * inputs the overview key must track.
 *
 * The overview draws every member at its render matrix and reflects the current
 * dataset set. A layout switch reflows member positions + render matrices and
 * bumps `layout`; a dataset add/remove bumps `content` (and `layout`). Neither
 * necessarily changes the other overview inputs (dataset order, settings,
 * upload generation, channel, z), so without the epochs a camera-only tick
 * would keep reusing a cache that draws the *old* placement/set. Folding both
 * epochs into the overview key forces a rebuild whenever placement or the
 * dataset set moves, even on a pure pan/zoom, and guarantees the cache can
 * never serve a removed dataset.
 *
 * Parsed once per tick. Mirrors how `tickCoordinator` reads `epochs()`
 * defensively: an older build without the binding (or a malformed payload)
 * falls back to a stable constant so the key stays well-formed and the
 * remaining inputs still drive rebuilds.
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
  // The active channel selects which channel_settings the layer contrast comes
  // from (resolveMinimapLayerContrast), so it is an overview render input — keep
  // it in the overview key or switching channels leaves the minimap stale (see
  // the minimap-render-key gotcha).
  const activeC = scene.c();

  // The content + layout epochs cover placement/set changes that do NOT move any
  // other overview input: a layout switch reflows member matrices and bumps
  // `layout` only; a dataset add/remove bumps `content` (and `layout`). Folding
  // them in rebuilds the overview when placement or the dataset set moves even on
  // a camera-only tick (see readMinimapOverviewEpochs).
  const { content: contentEpoch, layout: layoutEpoch } = readMinimapOverviewEpochs(scene);

  // Three keys split the per-tick work by what each input actually affects:
  //  - geometry key: inputs that change WHAT the overview draws, WHERE, and at
  //    what backing resolution. In slice mode the placement is camera-invariant;
  //    in volume mode rotating the camera (theta/phi) reorients it, so those join
  //    this key. uploadGeneration re-renders when new overview chunks arrive; the
  //    content + layout epochs re-render when the dataset set or member placement
  //    changes; devicePixelRatio + size re-render when the backing pixel size
  //    moves (monitor DPR change or resize). Per-layer display values are
  //    deliberately NOT here.
  //  - settings snapshot: any per-dataset display/visibility edit. A display-only
  //    edit (contrast/gamma/colormap/opacity) re-issues the overview render from
  //    the cached geometry with no member re-read; a visibility edit (a drawn
  //    layer appears/disappears, detected via the visibility signature) forces a
  //    full geometry rebuild.
  //  - overlay key: the camera inputs that only move the viewport/frustum
  //    rectangle on the 2D overlay — slice zoom/center, volume dolly
  //    (eye_position). theta/phi live in the geometry key (a rotation also moves
  //    the frustum, and the overview must redraw anyway).
  const overviewCamSnap = mode === "volume" ? `${theta}|${phi}` : "";
  // devicePixelRatio and the minimap size set the backing pixel size the camera
  // and overview are rendered at (backingSize = round(size × devicePixelRatio)),
  // so a DPR change (window dragged across monitors) or a resize must force a
  // full rebuild — otherwise a later display-only edit re-issues the render with
  // the stale backing size/camera cached from the old DPR (see the retina DPR 2
  // gotcha). This repo is DPR-sensitive.
  const geometryKey = `${mode}|${sliceZ}|${activeC}|${overviewCamSnap}|${contentEpoch}|${layoutEpoch}|${orderSnap}|${state.uploadGeneration}|${devicePixelRatio}|${state.size}`;
  const overlayCamSnap = mode === "volume" ? `${scene.eye_position()}` : `${scene.zoom()}|${scene.center()}`;
  const overlayKey = `${mode}|${overlayCamSnap}`;

  const geometryChanged = geometryKey !== state.overviewGeometryKey;
  const settingsChanged = settingsSnap !== state.overviewSettingsSnap;
  const overlayChanged = overlayKey !== state.overlayRenderKey;
  if (!geometryChanged && !settingsChanged && !overlayChanged && state.overviewCache) return;

  let rebuilt = false;
  if (geometryChanged || !state.overviewCache) {
    // Geometry changed (or first render): re-read members and redraw the GPU
    // overview, caching the camera- and display-invariant geometry for later
    // camera-only and display-only ticks. Parsed here so the visibility signature
    // and the build share one parse.
    const layerOrder: string[] = JSON.parse(orderSnap);
    const allSettings: MinimapAllSettings = JSON.parse(settingsSnap);
    state.overviewCache = buildMinimapOverview(ctx, state.size, activeC, layerOrder, allSettings, theta, phi);
    state.overviewVisibilitySig = minimapVisibilitySignature(layerOrder, allSettings);
    rebuilt = true;
  } else if (settingsChanged) {
    // Settings moved but the geometry key did not. Parse to tell a visibility
    // change (a drawn layer in/out → full rebuild) from a display-only edit
    // (same drawn set → cheap re-render from cached geometry).
    const layerOrder: string[] = JSON.parse(orderSnap);
    const allSettings: MinimapAllSettings = JSON.parse(settingsSnap);
    const visibilitySig = minimapVisibilitySignature(layerOrder, allSettings);
    if (visibilitySig !== state.overviewVisibilitySig) {
      state.overviewCache = buildMinimapOverview(ctx, state.size, activeC, layerOrder, allSettings, theta, phi);
      state.overviewVisibilitySig = visibilitySig;
      rebuilt = true;
    } else {
      // Display-only edit: reuse cached member geometry + camera, recompute only
      // the per-layer display params. No member re-read, no geometry rebuild.
      updateMinimapDisplay(ctx.client, state.overviewCache, allSettings, activeC);
    }
  }
  // A camera-only change falls through: the cached overview texture already sits
  // on the minimap canvas, so we skip readMemberRenderMatrices + minimapRender
  // and recompute only the cheap 2D overlay below.
  state.overviewGeometryKey = geometryKey;
  state.overviewSettingsSnap = settingsSnap;
  state.overlayRenderKey = overlayKey;

  const cache = state.overviewCache;

  // The overlay (viewport/frustum rectangle) depends on camera + geometry, not
  // display values — so a display-only edit skips it; only a geometry rebuild or
  // a camera move recomputes it.
  if (state.overlayCallback && cache && (rebuilt || overlayChanged)) {
    // Slice view bounds (2D only), expressed in scene XY coordinates. Recomputed
    // every camera change from the fresh zoom/center over the cached members.
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

    // Main camera inv view-proj (3D only) — tracks the dolly on a camera-only tick.
    const mainInvViewProj = mode === "volume" ? new Float32Array(scene.inv_view_proj()) : null;
    const currentZ = mode === "slice" ? sliceZ : scene.z();

    state.overlayCallback({
      viewProj: cache.viewProj,
      layers: cache.overlayLayers,
      datasetLayers: cache.datasetOverlayLayers,
      sliceViewports,
      mode,
      theta,
      phi,
      canvasW: cache.backingSize,
      canvasH: cache.backingSize,
      currentZ,
      datasetDims: cache.datasetDims,
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
