/** Discriminated-union message types for main <-> render worker communication. */

/** Byte budget for the volume texture LRU cache (shared by main thread + GPU worker). */
export const VOL_CACHE_BUDGET = 8 * 1024 * 1024 * 1024; // 8 GB

// --- Main -> Worker ---

export interface InitMessage {
  type: "init";
  canvas: OffscreenCanvas;
}

export interface SetModeSliceMessage {
  type: "setModeSlice";
}

export interface SetModeVolumeMessage {
  type: "setModeVolume";
}

export interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
}

export interface SliceSetFallbackMessage {
  type: "sliceSetFallback";
  data: ArrayBuffer;
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

export interface SliceUploadTilesMessage {
  type: "sliceUploadTiles";
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

export interface SliceRenderMessage {
  type: "sliceRender";
  zoom: number;
  cx: number;
  cy: number;
  canvasW: number;
  canvasH: number;
  dataW: number;
  dataH: number;
}

export interface VolumeSetInitialMessage {
  type: "volumeSetInitial";
  data: ArrayBuffer;
  width: number;
  height: number;
  depth: number;
}

export interface VolumeChunk {
  data: ArrayBuffer;
  x: number;
  y: number;
  z: number;
  key: string;
}

export interface VolumeUploadChunksMessage {
  type: "volumeUploadChunks";
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
}

export interface VolumeRenderMessage {
  type: "volumeRender";
  invViewProj: Float32Array;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
}

export interface SetDisplayParamsMessage {
  type: "setDisplayParams";
  contrastMin: number;
  contrastMax: number;
  gamma: number;
}

export interface DestroyMessage {
  type: "destroy";
}

export type MainToWorkerMessage =
  | InitMessage
  | SetModeSliceMessage
  | SetModeVolumeMessage
  | ResizeMessage
  | SliceSetFallbackMessage
  | SliceUploadTilesMessage
  | SliceRenderMessage
  | VolumeSetInitialMessage
  | VolumeUploadChunksMessage
  | VolumeRenderMessage
  | SetDisplayParamsMessage
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
  min: number;
  max: number;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ErrorMessage
  | IntensityRangeMessage;
