import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";
import type { ProxyAtlasState, ProxyHandle } from "./proxyAtlas.ts";
import type { EntityDescriptorIndex } from "./descriptorBuffer.ts";
import type { RendererState } from "./worker/state.ts";

/**
 * Proxy descriptor for one `(entity, t, c)` tuple — handles into the
 * GPU proxy atlases. Proxy pools are channel-scoped, so a single entity
 * can have several live descriptors at once during multi-channel and
 * time scrubbing.
 */
export interface EntityProxyDescriptor {
  tileProxyHandle: ProxyHandle | null;
  groupProxyHandle: ProxyHandle | null;
}

export function proxyDescriptorKey(entityId: string, t: number, c: number): string {
  return `${entityId}|${t}|${c}`;
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
   * Look up the proxy descriptor for an entity/time/channel. Returns
   * null if no proxy has been uploaded yet for that tuple.
   */
  lookupProxyDescriptor(entityId: string, t: number, c: number): EntityProxyDescriptor | null;
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
