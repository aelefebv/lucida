/** Shared types and constants for the render loop modules. */
import type { WasmScene } from "lucida-core";
import type { DatasetManifest } from "./manifestTypes.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { CpuCache } from "./pipeline/fetch/index.ts";
import type { AssetCatalog } from "./pipeline/assetCatalog.ts";
import type { Session } from "./session.ts";

export interface DatasetEntry {
  manifest: DatasetManifest;
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
  /** Per-dataset layers (for volume frustum overlays). Uses dataset-level model matrix and full volume extent. */
  datasetLayers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array; width: number; height: number; depth: number }[];
  /** Per-member slice viewport intersections in member-local voxel coordinates. */
  sliceViewports: {
    datasetId: string;
    memberId: string;
    modelMatrix: Float32Array;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    width: number;
    height: number;
    depth: number;
  }[];
  mode: "slice" | "volume";
  theta: number;
  phi: number;
  canvasW: number;
  canvasH: number;
  currentZ: number;
  datasetDims: Map<string, { width: number; height: number; depth: number }>;
  mainInvViewProj: Float32Array | null;
  /**
   * True when the camera- and geometry-derived (Z-invariant) overlay layer —
   * member bounding boxes, axis arrows, the volume frustum — changed since the
   * last overlay callback and must be re-stroked. False on a pure Z-scrub: the
   * consumer reuses the cached static layer and re-strokes only the cheap
   * Z-dependent indicators (slice plane + viewport rect), skipping the O(N)
   * bounding-box redraw each Z step.
   */
  staticDirty: boolean;
}

/** Minimum interval between residency-triggered renders (ms). Interactive renders are immediate. */
export const RESIDENCY_RENDER_INTERVAL_MS = 33;

/** Separate budget for minimap overview uploads (independent from main view). */
export const MINIMAP_UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB per frame

// `MAIN_VIEW_UPLOAD_BUDGET_BYTES` lives in `pipeline/upload/constants.ts`
// because it's an upload-phase constant, not a render-loop one.

/** Shared dependency bag passed to all tick functions. */
export interface TickContext {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
  renderScale: number;
  cpuCache: CpuCache;
  sendViewerInterest?: (interest: unknown) => void;
  /**
   * Local mirror of per-entity proxy availability. Populated by
   * `bridge` from `DatasetOpened.catalog` and any subsequent
   * `AssetCatalogUpdate` server messages.
   */
  assetCatalog: AssetCatalog;
}
