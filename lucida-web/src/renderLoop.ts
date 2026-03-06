/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { WasmScene } from "lucida-core";
import type { DatasetInfo } from "./zarr/metadata.ts";
import { ChunkStore } from "./zarr/chunkStore.ts";
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import { RenderClient } from "./renderer/renderClient.ts";
import { evaluateChunkPlan } from "./zarr/chunkPlan.ts";

export interface RenderLoopOptions {
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
}

export class RenderLoop {
  private scene: WasmScene;
  private store: ChunkStore;
  private datasetInfo: DatasetInfo;
  private client: RenderClient;
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private dirty = true;
  private rafId: number | null = null;
  private unsub: (() => void) | null = null;

  private uploaded = new Set<string>();
  private currentLod: { level: number; z?: number; t: number; c: number } | null = null;

  // Slice-specific params
  private sliceZ = 0;
  private sliceT = 0;
  private sliceC = 0;

  constructor(opts: RenderLoopOptions) {
    this.scene = opts.scene;
    this.store = opts.store;
    this.datasetInfo = opts.datasetInfo;
    this.client = opts.client;
    this.canvas = opts.canvas;
    this.mode = opts.mode;
  }

  start(): void {
    this.unsub = this.store.subscribe(() => {
      this.dirty = true;
    });
    this.tick();
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  markDirty(): void {
    this.dirty = true;
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
    const { scene, store, datasetInfo, client, canvas } = this;
    const z = this.sliceZ;
    const t = this.sliceT;
    const c = this.sliceC;

    scene.set_z(z);
    scene.set_t(t);
    scene.set_c(c);

    const plan = evaluateChunkPlan(scene);
    if (!plan) return;

    if (plan.needed.length > 0) {
      store.ensureFetched(plan.needed);
    }

    const level = plan.needed[0]?.level;
    if (level !== undefined) {
      const levelMeta = datasetInfo.levels[level];
      if (levelMeta) {
        const [, , , levelHeight, levelWidth] = levelMeta.shape;
        const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        const fullResDepth = datasetInfo.levels[0].shape[2];
        const levelDepth = levelMeta.shape[2];

        // Reset uploaded set when view params change
        const lod = this.currentLod;
        if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
          this.uploaded = new Set();
          this.currentLod = { level, z, t, c };
        }

        // Collect newly-available chunks
        const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
        for (const coord of plan.needed) {
          if (coord.level !== level) continue;
          if (this.uploaded.has(coord.key)) continue;
          const buf = store.get(coord.key);
          if (buf) {
            availableChunks.push({ data: new Uint16Array(buf), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
            this.uploaded.add(coord.key);
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

    const fullResWidth = datasetInfo.levels[0].shape[4];
    const fullResHeight = datasetInfo.levels[0].shape[3];

    const currentZoom = scene.zoom();
    const centerArr = scene.center();
    const cx = centerArr[0];
    const cy = centerArr[1];

    client.resize(canvasW, canvasH);
    client.sliceRender(currentZoom, cx, cy, canvasW, canvasH, fullResWidth, fullResHeight);
  }

  private tickVolume(): void {
    const { scene, store, datasetInfo, client, canvas } = this;

    const viewT = scene.t();
    const viewC = scene.c();

    const plan = evaluateChunkPlan(scene);
    if (!plan) return;

    if (plan.needed.length > 0) {
      store.ensureFetched(plan.needed);

      const targetLevel = plan.needed[0].level;
      const levelMeta = datasetInfo.levels[targetLevel];
      const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

      // Reset uploaded set when target level/t/c changes
      const lod = this.currentLod;
      if (!lod || lod.level !== targetLevel || lod.t !== viewT || lod.c !== viewC) {
        this.uploaded = new Set();
        this.currentLod = { level: targetLevel, t: viewT, c: viewC };
      }

      // Collect newly available chunks
      const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of plan.needed) {
        if (this.uploaded.has(coord.key)) continue;
        const buf = store.get(coord.key);
        if (!buf) continue;
        newChunks.push({ data: new Uint16Array(buf), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        this.uploaded.add(coord.key);
      }

      if (newChunks.length > 0) {
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
    const model = new Float32Array(scene.model_matrix());
    const invModel = new Float32Array(scene.inv_model_matrix());
    const eye = new Float32Array(scene.eye_position_3d());
    const canvasW = canvas.clientWidth * devicePixelRatio;
    const canvasH = canvas.clientHeight * devicePixelRatio;

    client.volumeRender(invVP, model, invModel, eye, canvasW, canvasH);
  }
}
