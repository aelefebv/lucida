/** Shared types and constants for the render loop modules. */
import type { WasmScene } from "lucida-core";
import type { ContentGraph } from "./contentTypes.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { CpuCache } from "./pipeline/cpuCache.ts";
import type { AssetCatalog } from "./pipeline/assetCatalog.ts";
import type { Session } from "./session.ts";

export interface DatasetEntry {
  content: ContentGraph;
}

export interface RenderLoopOptions {
  session: Session;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
}

export interface MinimapOverlayData {
  viewProj: Float32Array;
  /** Per-member layers (for bounding boxes, slice planes). */
  layers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[];
  /** Per-dataset layers (for view rectangle, frustum). Uses dataset-level model matrix and full volume extent. */
  datasetLayers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array; width: number; height: number; depth: number }[];
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

/** Minimum interval between data-triggered renders (ms). View-triggered renders are immediate. */
export const DATA_RENDER_INTERVAL_MS = 100;

/** Separate budget for minimap overview uploads (independent from main view). */
export const MINIMAP_UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB per frame

/** Per-frame upload budget for the main view (slice + volume). */
export const MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024; // 8 MB per frame

/** Shared dependency bag passed to all tick functions. */
export interface TickContext {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
  renderScale: number;
  cpuCache: CpuCache;
  /**
   * Local mirror of per-entity proxy availability. Populated by
   * `bridge` from `RegisterDataset.catalog` and any subsequent
   * `AssetCatalogUpdate` server messages. Empty in S3 — Planning
   * doesn't consume it until S6.
   */
  assetCatalog: AssetCatalog;
}
