import type { SliceRenderer } from "./sliceRenderer.ts";
import type { VolumeRenderer } from "./volumeRenderer.ts";
import type { LayerCompositor } from "./layerCompositor.ts";
import type { ViewLander } from "./viewLander.ts";
import type { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerToMainMessage } from "./workerProtocol.ts";
import type { EntityDescriptorIndex } from "./descriptorBuffer.ts";
import type { FrameTiming } from "./passTiming.ts";
import type { RendererState } from "./worker/state.ts";

export interface WorkerCtx {
  /** Replaced when a lost device is (`worker/deviceLoss.ts`), so read it where it is used rather than keeping it. */
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  /** Per-session worker state. Owned by the dispatcher; handlers mutate it directly. */
  state: RendererState;
  /**
   * The GPU pass timing for viewport frames, a no-op on a device without
   * timestamp queries. The frame handlers bracket each frame with it and hand
   * it to every viewport pass; the minimap and thumbnail paths never touch it.
   */
  passTimer: FrameTiming;
  getSliceRenderer(): SliceRenderer;
  getVolumeRenderer(): VolumeRenderer;
  getCompositor(): LayerCompositor;
  getCursorRenderer(): CursorRenderer;
  getViewLander(): ViewLander;
  /** At least `count` layer targets of `w`×`h` for `view` (`worker/viewResources.ts`). */
  ensureOffscreenPool(view: number, count: number, w: number, h: number): GPUTexture[];
  getOrCreateLUT(name: string): GPUTexture;
  /** Post a message to the main thread. `transfer` moves transferables instead of cloning them. */
  post(msg: WorkerToMainMessage, transfer?: Transferable[]): void;
  /**
   * Recompute and post the wanted-set delta and level report for one
   * dataset: the one named, else the dataset whose cold state arrived last.
   * An upload names the dataset its member belongs to, so a workspace with
   * several datasets keeps each one's report current.
   */
  postWantedSet(datasetId?: string): void;
  /** The dataset's entity descriptor buffer and index maps, or null before its first cold state. */
  lookupEntityDescriptor(datasetId: string): EntityDescriptorIndex | null;
}
