/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { WasmScene } from "lucida-core";
import type { DatasetInfo } from "./zarr/metadata.ts";
import { ChunkStore } from "./zarr/chunkStore.ts";
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import { RenderClient } from "./renderer/renderClient.ts";
import { VOL_CACHE_BUDGET } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";

export interface DatasetEntry {
  store: ChunkStore;
  info: DatasetInfo;
}

export interface RenderLoopOptions {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  selectedDatasetId: string;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
}

/** Max bytes of chunk data to upload to the GPU per RAF tick. */
const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024; // 4 MB per frame

export class RenderLoop {
  private scene: WasmScene;
  private datasets: Map<string, DatasetEntry>;
  private selectedDatasetId: string;
  private client: RenderClient;
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private dirty = true;
  private rafId: number | null = null;
  private unsubs = new Map<string, () => void>();

  private uploaded = new Set<string>();
  private currentLod: { level: number; z?: number; t: number; c: number } | null = null;

  // Volume-specific LRU cache of uploaded sets (byte-budget eviction, matches GPU worker)
  // VOL_CACHE_BUDGET imported from workerProtocol.ts
  private volumeUploaded = new Map<string, { uploaded: Set<string>; byteSize: number }>();
  private volumeCacheBytes = 0;
  private volumeLodKey: string | null = null;

  // Slice-specific params
  private sliceZ = 0;
  private sliceT = 0;
  private sliceC = 0;

  constructor(opts: RenderLoopOptions) {
    this.scene = opts.scene;
    this.datasets = opts.datasets;
    this.selectedDatasetId = opts.selectedDatasetId;
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
    if (this.volumeLodKey?.startsWith(id + "/")) {
      this.volumeLodKey = null;
    }

    this.dirty = true;
  }

  setSelectedDataset(id: string): void {
    if (this.selectedDatasetId !== id) {
      this.selectedDatasetId = id;
      this.dirty = true;
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  resetVolumeCache(): void {
    this.volumeUploaded.clear();
    this.volumeCacheBytes = 0;
    this.volumeLodKey = null;
  }

  setSliceParams(z: number, t: number, c: number): void {
    if (z !== this.sliceZ || t !== this.sliceT || c !== this.sliceC) {
      this.sliceZ = z;
      this.sliceT = t;
      this.sliceC = c;
      this.dirty = true;
    }
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

    this.rafId = requestAnimationFrame(this.tick);
  };

  private tickSlice(): void {
    const { scene, client, canvas } = this;
    const selectedDs = this.datasets.get(this.selectedDatasetId);
    if (!selectedDs) return;

    const z = this.sliceZ;
    const t = this.sliceT;
    const c = this.sliceC;

    scene.set_z(z);
    scene.set_t(t);
    scene.set_c(c);

    // Warm chunks for all datasets
    for (const [dsId, ds] of this.datasets) {
      const plan = evaluateChunkPlanFor(scene, dsId);
      if (plan && plan.needed.length > 0) {
        ds.store.ensureFetched(plan.needed);
      }
    }

    // Upload + render only the selected dataset
    const plan = evaluateChunkPlanFor(scene, this.selectedDatasetId);
    if (!plan) return;

    const level = plan.needed[0]?.level;
    if (level !== undefined) {
      const levelMeta = selectedDs.info.levels[level];
      if (levelMeta) {
        const [, , , levelHeight, levelWidth] = levelMeta.shape;
        const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        const fullResDepth = selectedDs.info.levels[0].shape[2];
        const levelDepth = levelMeta.shape[2];

        // Reset uploaded set when view params change
        const lod = this.currentLod;
        if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
          this.uploaded = new Set();
          this.currentLod = { level, z, t, c };
        }

        // Collect newly-available chunks (up to byte budget)
        const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
        let budgetRemaining = UPLOAD_BUDGET_BYTES;
        for (const coord of plan.needed) {
          if (coord.level !== level) continue;
          if (this.uploaded.has(coord.key)) continue;
          const buf = selectedDs.store.get(coord.key);
          if (!buf) continue;
          availableChunks.push({ data: new Uint16Array(buf), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
          this.uploaded.add(coord.key);
          budgetRemaining -= buf.byteLength;
          if (budgetRemaining <= 0) {
            this.dirty = true; // more chunks remain — continue next frame
            break;
          }
        }

        if (availableChunks.length > 0) {
          client.sliceUploadTiles(
            availableChunks,
            level, z, t, c,
            levelWidth, levelHeight,
            chunkX, chunkY, chunkZ,
            fullResDepth, levelDepth, z,
          );
        }
      }
    }

    // Render
    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    scene.set_viewport(canvasW, canvasH);

    const fullResWidth = selectedDs.info.levels[0].shape[4];
    const fullResHeight = selectedDs.info.levels[0].shape[3];

    const currentZoom = scene.zoom();
    const centerArr = scene.center();
    const cx = centerArr[0];
    const cy = centerArr[1];

    client.resize(canvasW, canvasH);
    client.sliceRender(currentZoom, cx, cy, canvasW, canvasH, fullResWidth, fullResHeight);
  }

  private tickVolume(): void {
    const { scene, client, canvas } = this;
    const selectedDs = this.datasets.get(this.selectedDatasetId);
    if (!selectedDs) return;

    const viewT = scene.t();
    const viewC = scene.c();

    // Warm chunks for all datasets
    for (const [dsId, ds] of this.datasets) {
      const plan = evaluateChunkPlanFor(scene, dsId);
      if (plan && plan.needed.length > 0) {
        ds.store.ensureFetched(plan.needed);
      }
    }

    // Upload + render only the selected dataset
    const plan = evaluateChunkPlanFor(scene, this.selectedDatasetId);
    if (!plan) return;

    if (plan.needed.length > 0) {
      const targetLevel = plan.needed[0].level;
      const levelMeta = selectedDs.info.levels[targetLevel];
      const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

      const lodKey = `${this.selectedDatasetId}/${targetLevel}/${viewT}/${viewC}`;
      const lodKeyChanged = this.volumeLodKey !== lodKey;
      const texBytes = widthFull * heightFull * depthFull * 2; // r16uint

      // Look up (or create) the uploaded set for this lodKey
      let cached = this.volumeUploaded.get(lodKey);
      if (cached) {
        // LRU touch
        this.volumeUploaded.delete(lodKey);
        this.volumeUploaded.set(lodKey, cached);
      } else {
        // Evict oldest entries until new texture fits within budget
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
      this.volumeLodKey = lodKey;

      // Collect newly available chunks (up to byte budget)
      const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      let budgetRemaining = UPLOAD_BUDGET_BYTES;
      for (const coord of plan.needed) {
        if (cached.uploaded.has(coord.key)) continue;
        const buf = selectedDs.store.get(coord.key);
        if (!buf) continue;
        newChunks.push({ data: new Uint16Array(buf), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        cached.uploaded.add(coord.key);
        budgetRemaining -= buf.byteLength;
        if (budgetRemaining <= 0) {
          this.dirty = true; // more chunks remain — continue next frame
          break;
        }
      }

      // Send to GPU worker if there are new chunks OR if lodKey changed (to activate cached texture)
      if (newChunks.length > 0 || lodKeyChanged) {
        client.volumeUploadChunks(
          newChunks,
          targetLevel, viewT, viewC,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
        );
      }
    }

    // Render
    const invVP = new Float32Array(scene.inv_view_proj_3d());
    const model = new Float32Array(scene.model_matrix_for(this.selectedDatasetId));
    const invModel = new Float32Array(scene.inv_model_matrix_for(this.selectedDatasetId));
    const eye = new Float32Array(scene.eye_position_3d());
    const canvasW = canvas.clientWidth * devicePixelRatio;
    const canvasH = canvas.clientHeight * devicePixelRatio;

    client.volumeRender(invVP, model, invModel, eye, canvasW, canvasH);
  }
}
