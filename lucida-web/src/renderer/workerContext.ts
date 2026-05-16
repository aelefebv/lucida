import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";
import type { ProxyAtlasState, ProxyHandle } from "./proxyAtlas.ts";
import type { EntityDescriptorIndex } from "./descriptorBuffer.ts";
import type { RendererState } from "./worker/state.ts";

/**
 * Per-entity proxy descriptor — handles into the GPU proxy atlases.
 * Owned by gpu.worker.ts and exposed to render handlers through
 * `WorkerCtx.lookupProxyDescriptor` so they can bind the right proxy
 * textures + pass slot info to the shader.
 */
export interface EntityProxyDescriptor {
  fieldProxyHandle: ProxyHandle | null;
  wellProxyHandle: ProxyHandle | null;
}

export interface WorkerCtx {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  /**
   * Per-session worker state. Owned by the dispatcher; handlers mutate
   * it directly. See {@link RendererState} for the shape.
   */
  state: RendererState;
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
  /**
   * Look up the proxy descriptor for an entity. Returns null if no
   * proxy has been uploaded yet for the entity (handlers should fall
   * back to the chunk-only render path).
   */
  lookupProxyDescriptor(entityId: string): EntityProxyDescriptor | null;
  /**
   * Resolve a proxy pool for the given dataset by its pool key
   * (`proxyPoolKey()`). Returns null if no such pool. Handlers use this
   * to fetch the GPU texture + slot dims for binding.
   */
  lookupProxyPool(datasetId: string, poolKey: string): ProxyAtlasState | null;
  /**
   * Look up the per-dataset entity descriptor buffer + index maps.
   * Returns null until the first cold state for this dataset arrives.
   * Render handlers bind `idx.buffer` plus a small uniform with the
   * layer's `entityIndex`; the shader reads
   * `entityDescriptors[currentEntity.x]` for matrix and per-LOD geometry.
   */
  lookupEntityDescriptor(datasetId: string): EntityDescriptorIndex | null;
}
