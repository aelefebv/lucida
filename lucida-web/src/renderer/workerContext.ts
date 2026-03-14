import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";

export interface WorkerCtx {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  getSliceRenderer(): SliceRenderer;
  getVolumeRenderer(): VolumeRenderer;
  getCompositor(): LayerCompositor;
  ensureOffscreenPool(count: number, w: number, h: number): GPUTexture[];
  getDummyTexture(): GPUTexture;
  getDummy3DTexture(): GPUTexture;
  post(msg: WorkerToMainMessage): void;
}
