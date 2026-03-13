/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { WasmScene } from "lucida-core";
import type { DatasetInfo } from "./zarr/metadata.ts";
import { ChunkStore, type ChunkCoord } from "./zarr/chunkStore.ts";
import { RenderClient } from "./renderer/renderClient.ts";
import { VOL_CACHE_BUDGET } from "./renderer/workerProtocol.ts";
import type { VolumeLayerParams, SliceLayerParams, MinimapLayerParams } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";

export interface DatasetEntry {
  store: ChunkStore;
  info: DatasetInfo;
}

export interface RenderLoopOptions {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
}

export interface MinimapOverlayData {
  viewProj: Float32Array;
  layers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[];
  mode: "slice" | "volume";
  theta: number;
  phi: number;
  canvasW: number;
  canvasH: number;
  currentZ: number;
  datasetDims: Map<string, { width: number; height: number; depth: number }>;
  sliceViewBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  mainInvViewProj: Float32Array | null;
}

/** Max bytes of chunk data to upload to the GPU per RAF tick. */
const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024; // 4 MB per frame

/** Separate budget for minimap overview uploads (independent from main view). */
const MINIMAP_UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB per frame

export class RenderLoop {
  private scene: WasmScene;
  private datasets: Map<string, DatasetEntry>;
  private client: RenderClient;
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private dirty = true;
  private rafId: number | null = null;
  private unsubs = new Map<string, () => void>();

  // Per-dataset slice upload tracking
  private sliceUploaded = new Map<string, Set<string>>();
  private sliceCurrentLod = new Map<string, { level: number; z: number; t: number; c: number }>();

  // Volume-specific LRU cache of uploaded sets (byte-budget eviction, matches GPU worker)
  private volumeUploaded = new Map<string, { uploaded: Set<string>; byteSize: number }>();
  private volumeCacheBytes = 0;
  private volumeLodKeys = new Map<string, string>(); // per-dataset lod key

  // Minimap overview tracking
  private minimapOverviewKey = new Map<string, string>();           // dsId -> "dsId/level/t/c"
  private minimapOverviewUploaded = new Map<string, Set<string>>(); // dsId -> uploaded chunk keys
  private minimapOverviewSeeded = new Set<string>();                // dsIds with full upload done
  private minimapPendingFetch = new Map<string, ChunkCoord[]>();    // deferred to next frame's main fetch

  // Minimap
  private minimapEnabled = false;
  private minimapSize = 200;
  private minimapOverlayCallback: ((data: MinimapOverlayData) => void) | null = null;

  // Slice-specific params
  private sliceZ = 0;
  private sliceT = 0;
  private sliceC = 0;

  constructor(opts: RenderLoopOptions) {
    this.scene = opts.scene;
    this.datasets = new Map();
    for (const [id, entry] of opts.datasets) {
      this.datasets.set(id, { store: entry.store, info: entry.info });
    }
    this.client = opts.client;
    this.canvas = opts.canvas;
    this.mode = opts.mode;
  }

  start(): void {
    // Subscribe to all datasets
    for (const [id, ds] of this.datasets) {
      const unsub = ds.store.subscribe(() => {
        this.dirty = true;
      });
      this.unsubs.set(id, unsub);
    }
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const unsub of this.unsubs.values()) {
      unsub();
    }
    this.unsubs.clear();
  }

  addDataset(id: string, store: ChunkStore, info: DatasetInfo): void {
    this.datasets.set(id, { store, info });
    const unsub = store.subscribe(() => {
      this.dirty = true;
    });
    this.unsubs.set(id, unsub);
    this.dirty = true;
  }

  removeDataset(id: string): void {
    const unsub = this.unsubs.get(id);
    if (unsub) {
      unsub();
      this.unsubs.delete(id);
    }
    this.datasets.delete(id);

    // Evict volume cache entries for this dataset
    for (const key of [...this.volumeUploaded.keys()]) {
      if (key.startsWith(id + "/")) {
        const entry = this.volumeUploaded.get(key)!;
        this.volumeCacheBytes -= entry.byteSize;
        this.volumeUploaded.delete(key);
      }
    }
    this.volumeLodKeys.delete(id);
    this.sliceUploaded.delete(id);
    this.sliceCurrentLod.delete(id);
    this.minimapOverviewKey.delete(id);
    this.minimapOverviewUploaded.delete(id);
    this.minimapOverviewSeeded.delete(id);
    this.minimapPendingFetch.delete(id);

    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  resetVolumeCache(): void {
    this.volumeUploaded.clear();
    this.volumeCacheBytes = 0;
    this.volumeLodKeys.clear();
  }

  setSliceParams(z: number, t: number, c: number): void {
    if (z !== this.sliceZ || t !== this.sliceT || c !== this.sliceC) {
      this.sliceZ = z;
      this.sliceT = t;
      this.sliceC = c;
      this.dirty = true;
    }
  }

  setMinimap(enabled: boolean, size?: number, overlayCallback?: ((data: MinimapOverlayData) => void) | null): void {
    this.minimapEnabled = enabled;
    if (size !== undefined) this.minimapSize = size;
    this.minimapOverlayCallback = overlayCallback ?? null;
    if (enabled) this.dirty = true;
  }

  markMinimapOverviewSeeded(datasetId: string, t: number, c: number): void {
    const ds = this.datasets.get(datasetId);
    if (!ds) return;
    const coarsestIdx = ds.info.levels.length - 1;
    const key = `${datasetId}/${coarsestIdx}/${t}/${c}`;
    this.minimapOverviewKey.set(datasetId, key);
    this.minimapOverviewSeeded.add(datasetId);
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
    this.minimapOverviewUploaded.set(datasetId, uploadedSet);
  }

  private tick = (): void => {
    if (!this.dirty) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.dirty = false;

    if (this.mode === "slice") {
      this.tickSlice();
    } else {
      this.tickVolume();
    }

    this.tickMinimapOverview();
    this.tickMinimap();

    this.rafId = requestAnimationFrame(this.tick);
  };

  private tickSlice(): void {
    const { scene, client, canvas } = this;
    if (this.datasets.size === 0) return;

    const z = this.sliceZ;
    const t = this.sliceT;
    const c = this.sliceC;

    scene.set_z(z);
    scene.set_t(t);
    scene.set_c(c);

    // Get layer ordering and settings from scene
    const layerOrder: string[] = JSON.parse(scene.layer_order());
    const allSettings: Record<string, {
      visible: boolean;
      opacity: number;
      contrast_min: number;
      contrast_max: number;
      gamma: number;
      blend_mode: string;
    }> = JSON.parse(scene.all_layer_settings());

    let budgetRemaining = UPLOAD_BUDGET_BYTES;

    // Upload chunks for ALL datasets
    for (const [dsId, ds] of this.datasets) {
      // Skip datasets whose dimensions are exceeded by the current slice position
      const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
      if (z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0]) continue;

      const plan = evaluateChunkPlanFor(scene, dsId);
      if (!plan) continue;
      const mmPending = this.minimapPendingFetch.get(dsId);
      const fetchList = mmPending?.length ? [...plan.needed, ...mmPending] : plan.needed;
      if (fetchList.length > 0) {
        ds.store.ensureFetched(fetchList);
      }

      const level = plan.needed[0]?.level;
      if (level === undefined) continue;

      const levelMeta = ds.info.levels[level];
      if (!levelMeta) continue;

      const [, , , levelHeight, levelWidth] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
      const fullResDepth = ds.info.levels[0].shape[2];
      const levelDepth = levelMeta.shape[2];

      // Per-dataset LOD tracking
      const lod = this.sliceCurrentLod.get(dsId);
      if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
        this.sliceUploaded.set(dsId, new Set());
        this.sliceCurrentLod.set(dsId, { level, z, t, c });
      }

      const uploaded = this.sliceUploaded.get(dsId)!;

      const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of plan.needed) {
        if (coord.level !== level) continue;
        if (uploaded.has(coord.key)) continue;
        const buf = ds.store.get(coord.key);
        if (!buf || buf.byteLength === 0) continue;
        availableChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        uploaded.add(coord.key);
        budgetRemaining -= buf.byteLength;
        if (budgetRemaining <= 0) {
          this.dirty = true;
          break;
        }
      }

      if (availableChunks.length > 0) {
        client.sliceUploadTilesForLayer(
          dsId,
          availableChunks,
          level, z, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY, chunkZ,
          fullResDepth, levelDepth, z,
        );
      }

      if (budgetRemaining <= 0) break;
    }

    // Build layer params for visible layers in order
    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    scene.set_viewport(canvasW, canvasH);

    const currentZoom = scene.zoom();
    const centerArr = scene.center();
    const cx = centerArr[0];
    const cy = centerArr[1];

    const layers: SliceLayerParams[] = [];
    for (const dsId of layerOrder) {
      const ds = this.datasets.get(dsId);
      if (!ds) continue;
      const settings = allSettings[dsId];
      if (!settings || !settings.visible) continue;

      // Skip layers whose dimensions are exceeded by the current slice position
      const dsShapeL = ds.info.levels[0].shape; // [T, C, Z, Y, X]
      if (z >= dsShapeL[2] || c >= dsShapeL[1] || t >= dsShapeL[0]) continue;

      const fullResWidth = ds.info.levels[0].shape[4];
      const fullResHeight = ds.info.levels[0].shape[3];

      layers.push({
        datasetId: dsId,
        dataW: fullResWidth,
        dataH: fullResHeight,
        contrastMin: settings.contrast_min,
        contrastMax: settings.contrast_max,
        gamma: settings.gamma,
        opacity: settings.opacity,
        blendMode: settings.blend_mode as "alpha" | "additive" | "max",
      });
    }

    client.resize(canvasW, canvasH);
    client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH);
  }

  private tickVolume(): void {
    const { scene, client, canvas } = this;

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
    }> = JSON.parse(scene.all_layer_settings());

    let budgetRemaining = UPLOAD_BUDGET_BYTES;

    // Upload chunks for ALL datasets
    for (const [dsId, ds] of this.datasets) {
      // Skip datasets whose C/T are exceeded (volume renders all Z slices)
      const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
      if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

      const plan = evaluateChunkPlanFor(scene, dsId);
      if (!plan) continue;
      const mmPending = this.minimapPendingFetch.get(dsId);
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
      const lodKeyChanged = this.volumeLodKeys.get(dsId) !== lodKey;
      const texBytes = widthFull * heightFull * depthFull * 2;

      let cached = this.volumeUploaded.get(lodKey);
      if (cached) {
        this.volumeUploaded.delete(lodKey);
        this.volumeUploaded.set(lodKey, cached);
      } else {
        while (this.volumeUploaded.size > 0 && this.volumeCacheBytes + texBytes > VOL_CACHE_BUDGET) {
          const oldestKey = this.volumeUploaded.keys().next().value!;
          const oldest = this.volumeUploaded.get(oldestKey)!;
          this.volumeCacheBytes -= oldest.byteSize;
          this.volumeUploaded.delete(oldestKey);
        }
        cached = { uploaded: new Set(), byteSize: texBytes };
        this.volumeUploaded.set(lodKey, cached);
        this.volumeCacheBytes += texBytes;
      }
      this.volumeLodKeys.set(dsId, lodKey);

      const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of plan.needed) {
        if (cached.uploaded.has(coord.key)) continue;
        const buf = ds.store.get(coord.key);
        if (!buf || buf.byteLength === 0) continue;
        newChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        cached.uploaded.add(coord.key);
        budgetRemaining -= buf.byteLength;
        if (budgetRemaining <= 0) {
          this.dirty = true;
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
    const canvasW = canvas.clientWidth * devicePixelRatio;
    const canvasH = canvas.clientHeight * devicePixelRatio;

    const layers: VolumeLayerParams[] = [];
    for (const dsId of layerOrder) {
      const dsVol = this.datasets.get(dsId);
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
      });
    }

    client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH);
  }

  private tickMinimapOverview(): void {
    if (!this.minimapEnabled) return;

    const { scene, client } = this;
    const t = scene.t();
    const c = scene.c();

    let budgetRemaining = MINIMAP_UPLOAD_BUDGET_BYTES;

    for (const [dsId, ds] of this.datasets) {
      const coarsestIdx = ds.info.levels.length - 1;
      const overviewKey = `${dsId}/${coarsestIdx}/${t}/${c}`;

      // If key changed, reset tracking
      if (this.minimapOverviewKey.get(dsId) !== overviewKey) {
        this.minimapOverviewUploaded.set(dsId, new Set());
        this.minimapOverviewSeeded.delete(dsId);
        this.minimapOverviewKey.set(dsId, overviewKey);
      }

      // Already fully seeded at matching key
      if (this.minimapOverviewSeeded.has(dsId)) continue;

      const levelMeta = ds.info.levels[coarsestIdx];
      const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
      const nz = Math.ceil(levelDepth / chunkZ);
      const ny = Math.ceil(levelHeight / chunkY);
      const nx = Math.ceil(levelWidth / chunkX);

      const uploaded = this.minimapOverviewUploaded.get(dsId)!;
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
        this.minimapPendingFetch.set(dsId, missing);
        this.dirty = true; // retry next frame
      } else {
        this.minimapPendingFetch.delete(dsId);
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
        this.minimapOverviewSeeded.add(dsId);
      }

      if (budgetRemaining <= 0) break;
    }
  }

  private tickMinimap(): void {
    if (!this.minimapEnabled) return;

    const { scene, client } = this;

    const theta = scene.camera_theta();
    const phi = scene.camera_phi();
    const cssSize = this.minimapSize;
    const backingSize = Math.round(cssSize * devicePixelRatio);

    const camData = new Float32Array(scene.minimap_camera(theta, phi, backingSize, backingSize));
    const invViewProj = camData.subarray(0, 16);
    const eye = camData.subarray(16, 19);
    const viewProj = camData.subarray(19, 35);

    const layerOrder: string[] = JSON.parse(scene.layer_order());
    const allSettings: Record<string, {
      visible: boolean;
      opacity: number;
      contrast_min: number;
      contrast_max: number;
      gamma: number;
      blend_mode: string;
    }> = JSON.parse(scene.all_layer_settings());

    const layers: MinimapLayerParams[] = [];
    const overlayLayers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[] = [];

    for (const dsId of layerOrder) {
      if (!this.datasets.has(dsId)) continue;
      const settings = allSettings[dsId];
      if (!settings || !settings.visible) continue;

      const model = new Float32Array(scene.model_matrix_for(dsId));
      const invModel = new Float32Array(scene.inv_model_matrix_for(dsId));

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

    if (this.minimapOverlayCallback) {
      // Dataset dimensions
      const datasetDims = new Map<string, { width: number; height: number; depth: number }>();
      for (const layer of overlayLayers) {
        const ds = this.datasets.get(layer.datasetId);
        if (ds) {
          const shape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
          datasetDims.set(layer.datasetId, { width: shape[4], height: shape[3], depth: shape[2] });
        }
      }

      // Slice view bounds (2D only)
      let sliceViewBounds: MinimapOverlayData["sliceViewBounds"] = null;
      if (this.mode === "slice") {
        const mainW = this.canvas.clientWidth;
        const mainH = this.canvas.clientHeight;
        const z = scene.zoom();
        const c = scene.center();
        const halfW = mainW / (2 * z);
        const halfH = mainH / (2 * z);
        sliceViewBounds = { minX: c[0] - halfW, minY: c[1] - halfH, maxX: c[0] + halfW, maxY: c[1] + halfH };
      }

      // Main camera inv view-proj (3D only)
      const mainInvViewProj = this.mode === "volume" ? new Float32Array(scene.inv_view_proj_3d()) : null;
      const currentZ = this.mode === "slice" ? this.sliceZ : scene.z();

      this.minimapOverlayCallback({
        viewProj,
        layers: overlayLayers,
        mode: this.mode,
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
}
