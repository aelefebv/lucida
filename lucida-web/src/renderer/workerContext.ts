import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";

export interface WorkerCtx {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  getSliceRenderer(): SliceRenderer;
  getVolumeRenderer(): VolumeRenderer;
  getCompositor(): LayerCompositor;
  getCursorRenderer(): CursorRenderer;
  ensureOffscreenPool(count: number, w: number, h: number): GPUTexture[];
  getDummyTexture(): GPUTexture;
  getDummy3DTexture(): GPUTexture;
  getOrCreateLUT(name: string): GPUTexture;
  post(msg: WorkerToMainMessage): void;
  /** Recompute and post wanted-set delta after eviction. */
  postWantedSet(): void;
}
