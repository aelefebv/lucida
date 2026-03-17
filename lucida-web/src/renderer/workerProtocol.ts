/** Discriminated-union message types for main <-> render worker communication. */

/** Atlas budget for the fixed-size 3D volume atlas (per dataset). */
export const VOLUME_ATLAS_BUDGET = 512 * 1024 * 1024; // 512 MB

/** Atlas budget for the fixed-size 2D slice atlas (per dataset). */
export const SLICE_ATLAS_BUDGET = 64 * 1024 * 1024; // 64 MB

// --- Main -> Worker ---

export interface InitMessage {
  type: "init";
  canvas: OffscreenCanvas;
}

export interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
}

export interface SliceTile {
  data: ArrayBuffer;
  x: number;
  y: number;
  z: number;
  key: string;
}

export interface SliceSetFallbackForLayerMessage {
  type: "sliceSetFallbackForLayer";
  datasetId: string;
  data: ArrayBuffer;
  width: number;
  height: number;
}

export interface SliceUploadTilesForLayerMessage {
  type: "sliceUploadTilesForLayer";
  datasetId: string;
  tiles: SliceTile[];
  level: number;
  z: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  fullResDepth: number;
  levelDepth: number;
  fullResZ: number;
}

export interface VolumeChunk {
  data: ArrayBuffer;
  x: number;
  y: number;
  z: number;
  key: string;
}

export interface VolumeSetInitialForLayerMessage {
  type: "volumeSetInitialForLayer";
  datasetId: string;
  data: ArrayBuffer;
  width: number;
  height: number;
  depth: number;
}

export interface VolumeUploadChunksForLayerMessage {
  type: "volumeUploadChunksForLayer";
  datasetId: string;
  chunks: VolumeChunk[];
  level: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  levelDepth: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  cameraLocal: [number, number, number];
}

// Multi-pass render messages

export interface VolumeLayerParams {
  datasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  opacity: number;
  blendMode: "alpha" | "additive" | "max";
  renderMode: "translucent" | "max_intensity";
}

export interface VolumeRenderMultiPassMessage {
  type: "volumeRenderMultiPass";
  layers: VolumeLayerParams[];
  invViewProj: Float32Array;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
}

export interface SliceLayerParams {
  datasetId: string;
  dataW: number;
  dataH: number;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  opacity: number;
  blendMode: "alpha" | "additive" | "max";
}

export interface SliceRenderMultiPassMessage {
  type: "sliceRenderMultiPass";
  layers: SliceLayerParams[];
  zoom: number;
  cx: number;
  cy: number;
  canvasW: number;
  canvasH: number;
}

export interface MinimapLayerParams {
  datasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
}

export interface MinimapInitMessage {
  type: "minimapInit";
  canvas: OffscreenCanvas;
}

export interface MinimapRenderMessage {
  type: "minimapRender";
  layers: MinimapLayerParams[];
  invViewProj: Float32Array;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
}

export interface MinimapDestroyMessage {
  type: "minimapDestroy";
}

export interface MinimapSetOverviewForLayerMessage {
  type: "minimapSetOverviewForLayer";
  datasetId: string;
  data: ArrayBuffer;
  width: number;
  height: number;
  depth: number;
  t: number;
  c: number;
}

export interface MinimapUploadOverviewChunksForLayerMessage {
  type: "minimapUploadOverviewChunksForLayer";
  datasetId: string;
  chunks: VolumeChunk[];
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  levelDepth: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
}

export interface RemoveLayerResourcesMessage {
  type: "removeLayerResources";
  datasetId: string;
}

export interface DestroyMessage {
  type: "destroy";
}

export type MainToWorkerMessage =
  | InitMessage
  | ResizeMessage
  | SliceSetFallbackForLayerMessage
  | SliceUploadTilesForLayerMessage
  | VolumeSetInitialForLayerMessage
  | VolumeUploadChunksForLayerMessage
  | VolumeRenderMultiPassMessage
  | SliceRenderMultiPassMessage
  | MinimapInitMessage
  | MinimapRenderMessage
  | MinimapDestroyMessage
  | MinimapSetOverviewForLayerMessage
  | MinimapUploadOverviewChunksForLayerMessage
  | RemoveLayerResourcesMessage
  | DestroyMessage;

// --- Worker -> Main ---

export interface ReadyMessage {
  type: "ready";
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface IntensityRangeMessage {
  type: "intensityRange";
  datasetId: string;
  min: number;
  max: number;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ErrorMessage
  | IntensityRangeMessage;
