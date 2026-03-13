/** Shared types and constants for the render loop modules. */
import type { WasmScene } from "lucida-core";
import type { DatasetInfo } from "./zarr/metadata.ts";
import type { ChunkStore } from "./zarr/chunkStore.ts";
import type { RenderClient } from "./renderer/renderClient.ts";

export interface DatasetEntry {
  store: ChunkStore;
  info: DatasetInfo;
}

export interface RenderLoopOptions {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
}

export interface MinimapOverlayData {
  viewProj: Float32Array;
  layers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[];
  mode: "slice" | "volume";
  theta: number;
  phi: number;
  canvasW: number;
  canvasH: number;
  currentZ: number;
  datasetDims: Map<string, { width: number; height: number; depth: number }>;
  sliceViewBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  mainInvViewProj: Float32Array | null;
}

/** Max bytes of chunk data to upload to the GPU per RAF tick. */
export const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024; // 4 MB per frame

/** Separate budget for minimap overview uploads (independent from main view). */
export const MINIMAP_UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB per frame

/** Shared dependency bag passed to all tick functions. */
export interface TickContext {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
}
