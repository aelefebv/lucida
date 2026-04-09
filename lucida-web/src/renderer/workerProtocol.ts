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

export interface SliceChunk {
  data: ArrayBuffer;
  x: number;
  y: number;
  z: number;
  key: string;
}

export interface SliceAtlasConfigMessage {
  type: "sliceAtlasConfig";
  datasetId: string;
  level: number;
  z: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  chunkX: number;
  chunkY: number;
}

export interface SliceChunkDataMessage {
  type: "sliceChunkData";
  datasetId: string;
  chunks: SliceChunk[];
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

export interface VolumeAtlasConfigMessage {
  type: "volumeAtlasConfig";
  datasetId: string;
  level: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  levelDepth: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
}

export interface VolumeChunkDataMessage {
  type: "volumeChunkData";
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
  hitLocal: [number, number, number];
}

// Multi-pass render messages

export interface VolumeLayerParams {
  datasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  rayHitLocal: [number, number, number];
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  opacity: number;
  blendMode: "alpha" | "additive" | "max";
  renderMode: "translucent" | "max_intensity";
  colormap?: string;
  scissorRect?: [number, number, number, number];
}

export interface VolumeRenderMultiPassMessage {
  type: "volumeRenderMultiPass";
  layers: VolumeLayerParams[];
  invViewProj: Float32Array;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
  /** Unscaled device-pixel dimensions for cursor sizing (immune to renderScale). */
  fullW: number;
  fullH: number;
  viewProj?: Float32Array;
  camForward?: Float32Array;
  clipDistance?: number;
  clipMode?: number;
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
  colormap?: string;
  /** Member position offset in voxels along X (default 0). */
  offsetX?: number;
  /** Member position offset in voxels along Y (default 0). */
  offsetY?: number;
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

export interface UpdateCursorDataMessage {
  type: "updateCursorData";
  data: ArrayBuffer;
  count: number;
}

export interface DestroyMessage {
  type: "destroy";
}

export type MainToWorkerMessage =
  | InitMessage
  | ResizeMessage
  | SliceAtlasConfigMessage
  | SliceChunkDataMessage
  | VolumeAtlasConfigMessage
  | VolumeChunkDataMessage
  | VolumeRenderMultiPassMessage
  | SliceRenderMultiPassMessage
  | MinimapInitMessage
  | MinimapRenderMessage
  | MinimapDestroyMessage
  | MinimapSetOverviewForLayerMessage
  | MinimapUploadOverviewChunksForLayerMessage
  | RemoveLayerResourcesMessage
  | UpdateCursorDataMessage
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

export interface ChunksEvictedMessage {
  type: "chunksEvicted";
  datasetId: string;
  /** Chunks removed from the atlas (were present, got evicted by closer chunks). */
  keys: string[];
  /** Chunks from the batch that were not inserted (too far, wrong Z, etc.). */
  skipped?: string[];
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ErrorMessage
  | IntensityRangeMessage
  | ChunksEvictedMessage;
