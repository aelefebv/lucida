/** Main-thread API wrapping the GPU render worker. */
import type {
  SliceTile,
  VolumeChunk,
  VolumeLayerParams,
  SliceLayerParams,
  MinimapLayerParams,
  WorkerToMainMessage,
} from "./workerProtocol.ts";

export class RenderClient {
  private worker: Worker;
  private readyPromise: Promise<void>;

  onIntensityRange: ((datasetId: string, min: number, max: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL("./gpu.worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const handler = (e: MessageEvent<WorkerToMainMessage>) => {
        if (e.data.type === "ready") {
          resolve();
          this.worker.removeEventListener("message", handler);
          this.worker.addEventListener("message", this.onMessage);
        } else if (e.data.type === "error") {
          reject(new Error(e.data.message));
          this.worker.removeEventListener("message", handler);
        }
      };
      this.worker.addEventListener("message", handler);
    });

    this.worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  private onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
    const msg = e.data;
    if (msg.type === "intensityRange" && this.onIntensityRange) {
      this.onIntensityRange(msg.datasetId, msg.min, msg.max);
    } else if (msg.type === "error") {
      console.error("Render worker error:", msg.message);
    }
  };

  resize(width: number, height: number) {
    this.worker.postMessage({ type: "resize", width, height });
  }

  volumeSetInitialForLayer(datasetId: string, data: Uint16Array, width: number, height: number, depth: number) {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.worker.postMessage(
      { type: "volumeSetInitialForLayer", datasetId, data: buf, width, height, depth },
      [buf],
    );
  }

  volumeUploadChunksForLayer(
    datasetId: string,
    chunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[],
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: VolumeChunk[] = chunks.map(chunk => {
      const buf = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength);
      transferList.push(buf);
      return { data: buf, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "volumeUploadChunksForLayer",
        datasetId,
        chunks: workerChunks,
        level, t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
      },
      transferList,
    );
  }

  sliceSetFallbackForLayer(datasetId: string, data: Uint16Array, width: number, height: number) {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.worker.postMessage(
      { type: "sliceSetFallbackForLayer", datasetId, data: buf, width, height },
      [buf],
    );
  }

  sliceUploadTilesForLayer(
    datasetId: string,
    tiles: { data: Uint16Array; x: number; y: number; z: number; key: string }[],
    level: number,
    z: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    fullResDepth: number,
    levelDepth: number,
    fullResZ: number,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerTiles: SliceTile[] = tiles.map(tile => {
      const buf = tile.data.buffer.slice(tile.data.byteOffset, tile.data.byteOffset + tile.data.byteLength);
      transferList.push(buf);
      return { data: buf, x: tile.x, y: tile.y, z: tile.z, key: tile.key };
    });
    this.worker.postMessage(
      {
        type: "sliceUploadTilesForLayer",
        datasetId,
        tiles: workerTiles,
        level, z, t, c,
        levelWidth, levelHeight,
        chunkX, chunkY, chunkZ,
        fullResDepth, levelDepth, fullResZ,
      },
      transferList,
    );
  }

  volumeRenderMultiPass(
    layers: VolumeLayerParams[],
    invViewProj: Float32Array,
    eye: Float32Array,
    canvasW: number,
    canvasH: number,
  ) {
    this.worker.postMessage({
      type: "volumeRenderMultiPass",
      layers, invViewProj, eye,
      canvasW, canvasH,
    });
  }

  sliceRenderMultiPass(
    layers: SliceLayerParams[],
    zoom: number,
    cx: number,
    cy: number,
    canvasW: number,
    canvasH: number,
  ) {
    this.worker.postMessage({
      type: "sliceRenderMultiPass",
      layers, zoom, cx, cy,
      canvasW, canvasH,
    });
  }

  minimapInit(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: "minimapInit", canvas: offscreen }, [offscreen]);
  }

  minimapRender(layers: MinimapLayerParams[], invViewProj: Float32Array, eye: Float32Array, canvasW: number, canvasH: number) {
    this.worker.postMessage({ type: "minimapRender", layers, invViewProj, eye, canvasW, canvasH });
  }

  minimapDestroy() {
    this.worker.postMessage({ type: "minimapDestroy" });
  }

  removeLayerResources(datasetId: string) {
    this.worker.postMessage({ type: "removeLayerResources", datasetId });
  }

  destroy() {
    this.worker.postMessage({ type: "destroy" });
    this.worker.terminate();
  }
}
