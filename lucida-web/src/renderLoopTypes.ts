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
  /**
   * The minimap camera looks straight down Z because every framed member has
   * one Z plane. The orientation cube, axis arrows, and slice planes then have
   * nothing to show, so they are not drawn.
   */
  topDown: boolean;
  theta: number;
  phi: number;
  canvasW: number;
  canvasH: number;
  currentZ: number;
  datasetDims: Map<string, { width: number; height: number; depth: number }>;
  mainInvViewProj: Float32Array | null;
  /**
   * True when the Z-invariant overlay layer (member bounding boxes, axis
   * arrows, the volume frustum) changed since the last overlay callback.
   * False on a pure Z-scrub, where the consumer reuses the cached layer and
   * re-strokes only the slice plane and viewport rect, skipping the O(N)
   * bounding-box redraw each Z step.
   */
  staticDirty: boolean;
}

/** Minimum interval between residency-triggered renders (ms). Interactive renders are immediate. */
export const RESIDENCY_RENDER_INTERVAL_MS = 33;

/** Separate budget for minimap overview uploads (independent from main view). */
export const MINIMAP_UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024; // 2 MB per frame

/**
 * Minimum gap between minimap overview seed-scans. The scan polls the CPU cache
 * for every unseeded member's coarse-chunk grid, O(members × chunks) per frame.
 * That dominates per-move CPU on large collections, since members stay
 * unseeded while visible tiles take fetch priority. Seeding is cosmetic
 * latency, so it runs at this cadence rather than every rAF.
 */
export const MINIMAP_OVERVIEW_SCAN_INTERVAL_MS = 100;

/** Shared dependency bag passed to all tick functions. */
export interface TickContext {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  mode: "slice" | "volume";
  /** The volume path's interaction scale: lower while the camera moves. */
  renderScale: number;
  /**
   * The share of device pixels the render target gets in both modes: the
   * pixel-ratio cap times the adaptive resolution. Planning and the camera
   * keep the full device-pixel viewport.
   */
  resolutionScale: number;
  cpuCache: CpuCache;
  sendViewerInterest?: (interest: unknown) => void;
  /**
   * Local mirror of per-entity proxy availability. Populated by
   * `bridge` from `DatasetOpened.catalog` and any subsequent
   * `AssetCatalogUpdate` server messages.
   */
  assetCatalog: AssetCatalog;
}
