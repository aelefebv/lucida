/** Shared types and constants for the render loop modules. */
import type { WasmScene } from "lucida-core";
import type { DatasetManifest } from "./manifestTypes.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { CpuCache } from "./pipeline/fetch/index.ts";
import type { Session } from "./session.ts";
import type { SliceViewportMemberInput } from "./minimapPath.ts";

export interface DatasetEntry {
  manifest: DatasetManifest;
}

export interface RenderLoopOptions {
  session: Session;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
}

export interface MinimapOverlayData {
  viewProj: Float32Array;
  invViewProj: Float32Array;
  /** Per-member layers (for bounding boxes, slice planes). */
  layers: { datasetId: string; modelMatrix: Float32Array; invModelMatrix: Float32Array }[];
  /** Every drawn member's placement in the scene and the minimap's world, which minimap input inverts. */
  members: readonly SliceViewportMemberInput[];
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
   * True when the layer drawn in the minimap camera's own view (member
   * bounding boxes, axis arrows) changed since the last overlay callback.
   * False on a Z-scrub or a main-camera move, where the consumer reuses the
   * cached layer and re-strokes only the slice plane, viewport rect and
   * frustum, skipping the O(N) bounding-box redraw.
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

/**
 * How long the main camera must be still before the minimap redraws for a
 * display edit. That redraw is one pass per member and channel, so on a
 * collection it is hundreds of passes on the queue the viewport's frames wait
 * behind, and auto-contrast, which follows the view, makes a display edit
 * several times a second while the camera moves.
 */
export const MINIMAP_DISPLAY_HOLD_MS = 250;

/** `[x, y, width, height]` in pixels from a canvas's top-left corner. */
export type PixelRect = readonly [number, number, number, number];

/** A view the loop draws: its id in the scene, the mode it draws it in, and where. */
export interface TickView {
  id: number;
  mode: "slice" | "volume";
  /** The view's rectangle of the canvas, in device pixels. */
  rect: PixelRect;
}

/** Shared dependency bag passed to all tick functions. */
export interface TickContext {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  /** Every view the loop draws this tick, the active one first. Never empty. */
  views: readonly TickView[];
  /** The volume path's interaction scale: lower while the camera moves. */
  renderScale: number;
  /**
   * The share of device pixels the render target gets in both modes: the
   * pixel-ratio cap times the adaptive resolution. Planning and the camera
   * keep the full device-pixel viewport.
   */
  resolutionScale: number;
  /** Level steps per ray-march step in the volume path's frame: 1 for full quality. */
  marchStepScale: number;
  /** Bands the volume path draws a frame in; 1 draws it whole. */
  bands: number;
  cpuCache: CpuCache;
  sendViewerInterest?: (interest: unknown) => void;
}

/**
 * The active view, which the loop draws first. Its frame quality and its
 * gestures lead the tick.
 */
export function drawnView(ctx: Pick<TickContext, "views">): TickView {
  return ctx.views[0];
}

/**
 * The canvas a view draws in, in pixels of the view's backing scale, and
 * that scale in backing pixels per device pixel.
 */
export interface FrameScale {
  canvasW: number;
  canvasH: number;
  scale: number;
}

/**
 * A view's rectangle of a canvas of `canvasW` x `canvasH` pixels, from its
 * fractions of the canvas. Edges round on their own, so views that tile the
 * canvas tile its pixels, and the whole canvas is the canvas exactly.
 */
export function viewRectInPixels(
  rect: ArrayLike<number>,
  canvasW: number,
  canvasH: number,
): PixelRect {
  const [x, y, width, height] = rect.length === 4 ? Array.from(rect) : [0, 0, 1, 1];
  const left = Math.round(x * canvasW);
  const top = Math.round(y * canvasH);
  return [left, top, Math.round((x + width) * canvasW) - left, Math.round((y + height) * canvasH) - top];
}
