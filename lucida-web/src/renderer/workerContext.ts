import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";
import type { ProxyAtlasState, ProxyHandle } from "./proxyAtlas.ts";

/**
 * S8: per-entity proxy descriptor — handles into the GPU proxy atlases.
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
   * S8: look up the proxy descriptor for an entity. Returns null if no
   * proxy has been uploaded yet for the entity (handlers should fall
   * back to the chunk-only render path).
   */
  lookupProxyDescriptor(entityId: string): EntityProxyDescriptor | null;
  /**
   * S8: resolve a proxy pool for the given dataset by its pool key
   * (`proxyPoolKey()`). Returns null if no such pool. Handlers use this
   * to fetch the GPU texture + slot dims for binding.
   */
  lookupProxyPool(datasetId: string, poolKey: string): ProxyAtlasState | null;
}
