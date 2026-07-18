import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";
import type { EntityDescriptorIndex } from "./descriptorBuffer.ts";
import type { RendererState } from "./worker/state.ts";
import type { GpuResourceBudget } from "./gpuResourceBudget.ts";

export interface WorkerCtx {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  /** One accounting/ownership boundary for the entire GPU device session. */
  gpuResources: GpuResourceBudget;
  /**
   * Per-session worker state. Owned by the dispatcher; handlers mutate
   * it directly. See {@link RendererState} for the shape.
   */
  state: RendererState;
  getSliceRenderer(): SliceRenderer;
  getVolumeRenderer(): VolumeRenderer;
  getCompositor(): LayerCompositor;
  getCursorRenderer(): CursorRenderer;
  /** Tear down renderer-class resources without lazily constructing them. */
  destroyRenderers(): void;
  ensureOffscreenPool(count: number, w: number, h: number): GPUTexture[];
  getDummyTexture(): GPUTexture;
  getDummy3DTexture(): GPUTexture;
  getOrCreateLUT(name: string): GPUTexture;
  /**
   * Post a message to the main thread. `transfer` moves transferable objects
   * (e.g. an `ImageBitmap` for a thumbnail reply) instead of structured-cloning
   * them — omit it for plain messages.
   */
  post(msg: WorkerToMainMessage, transfer?: Transferable[]): void;
  /** Recompute and post wanted-set delta after eviction. */
  postWantedSet(): void;
  /**
   * Look up the per-dataset entity descriptor buffer + index maps.
   * Returns null until the first cold state for this dataset arrives.
   * Render handlers bind `idx.buffer` plus a small uniform with the
   * layer's `entityIndex`; the shader reads
   * `entityDescriptors[currentEntity.x]` for matrix and per-LOD geometry.
   */
  lookupEntityDescriptor(datasetId: string): EntityDescriptorIndex | null;
}
