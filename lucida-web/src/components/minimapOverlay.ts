import type { MinimapOverlayData } from "../renderLoop.ts";
import { paint, tokenColors } from "../theme/tokenColors.ts";
import type { ResolvedColor, TokenName } from "../theme/tokens.ts";
import { transformPoint, projectToCanvas } from "./minimapMath.ts";
import { drawOrientationCube, type CubeColors } from "./orientationCube.ts";
import { drawFrustumIntersection } from "./frustumOverlay.ts";

const MINIMAP_COLOR_TOKENS = {
  background: "--lc-canvas-bg",
  stroke: "--lc-canvas-stroke",
  label: "--lc-canvas-label",
  axisX: "--lc-canvas-axis-x",
  axisY: "--lc-canvas-axis-y",
  axisZ: "--lc-canvas-axis-z",
  viewport: "--lc-canvas-viewport",
  plane: "--lc-canvas-plane",
} as const satisfies Record<string, TokenName>;

/** What the overlay is drawn in: canvas tokens, which follow the canvas background. */
export interface MinimapColors extends CubeColors {
  stroke: ResolvedColor;
  /** The main view's footprint: the slice view's rectangle, the volume camera's frustum. */
  viewport: ResolvedColor;
  /** The current Z plane. */
  plane: ResolvedColor;
}

export function readMinimapColors(): MinimapColors {
  return tokenColors(MINIMAP_COLOR_TOKENS);
}

/** How much of the canvas stroke a member's outline takes, so many outlines don't hide the data. */
const MEMBER_OUTLINE_ALPHA = 0.6;

const CUBE_EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // X edges
  [0, 2], [1, 3], [4, 6], [5, 7], // Y edges
  [0, 4], [1, 5], [2, 6], [3, 7], // Z edges
];

const CUBE_CORNERS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

function drawBoundingBox(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  canvasW: number, canvasH: number,
  color: string,
) {
  const projected = CUBE_CORNERS.map(([cx, cy, cz]) => {
    const [wx, wy, wz] = transformPoint(modelMatrix, cx, cy, cz);
    return projectToCanvas(viewProj, wx, wy, wz, canvasW, canvasH);
  });

  ctx.strokeStyle = color;
  ctx.lineWidth = 1 * devicePixelRatio;
  ctx.beginPath();
  for (const [i, j] of CUBE_EDGES) {
    const a = projected[i];
    const b = projected[j];
    if (!a || !b) continue;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
}

function drawAxisArrows(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  canvasW: number, canvasH: number,
  colors: MinimapColors,
) {
  const origin: [number, number, number] = [-0.12, -0.12, -0.12];
  const len = 0.18;
  const axes: { dir: [number, number, number]; color: string; label: string }[] = [
    { dir: [len, 0, 0], color: paint(colors.axisX), label: "X" },
    { dir: [0, len, 0], color: paint(colors.axisY), label: "Y" },
    { dir: [0, 0, len], color: paint(colors.axisZ), label: "Z" },
  ];

  const o = projectToCanvas(viewProj, ...origin, canvasW, canvasH);
  if (!o) return;

  const fontSize = Math.round(10 * devicePixelRatio);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const { dir, color, label } of axes) {
    const tip: [number, number, number] = [
      origin[0] + dir[0],
      origin[1] + dir[1],
      origin[2] + dir[2],
    ];
    const t = projectToCanvas(viewProj, ...tip, canvasW, canvasH);
    if (!t) continue;

    // Shaft
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(o[0], o[1]);
    ctx.lineTo(t[0], t[1]);
    ctx.stroke();

    // Arrowhead
    const dx = t[0] - o[0];
    const dy = t[1] - o[1];
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > 0) {
      const nx = dx / mag;
      const ny = dy / mag;
      const headLen = 6 * devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(t[0], t[1]);
      ctx.lineTo(t[0] - headLen * nx + headLen * 0.4 * ny, t[1] - headLen * ny - headLen * 0.4 * nx);
      ctx.lineTo(t[0] - headLen * nx - headLen * 0.4 * ny, t[1] - headLen * ny + headLen * 0.4 * nx);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Label
    const labelOffset = 10 * devicePixelRatio;
    const ldx = mag > 0 ? (dx / mag) * labelOffset : 0;
    const ldy = mag > 0 ? (dy / mag) * labelOffset : 0;
    ctx.fillStyle = color;
    ctx.fillText(label, t[0] + ldx, t[1] + ldy);
  }
}

function drawSlicePlane(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  currentZ: number, depth: number,
  canvasW: number, canvasH: number,
  color: ResolvedColor,
) {
  const nz = currentZ / Math.max(depth - 1, 1);
  const overhang = 0.1;
  const corners: [number, number, number][] = [
    [-overhang, -overhang, nz], [1 + overhang, -overhang, nz],
    [1 + overhang, 1 + overhang, nz], [-overhang, 1 + overhang, nz],
  ];

  const projected = corners.map(([ux, uy, uz]) => {
    const [wx, wy, wz] = transformPoint(modelMatrix, ux, uy, uz);
    return projectToCanvas(viewProj, wx, wy, wz, canvasW, canvasH);
  });

  if (projected.some(p => p === null)) return;
  const pts = projected as [number, number][];

  // Filled quad
  ctx.fillStyle = paint(color, 0.25);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.strokeStyle = paint(color, 0.8);
  ctx.lineWidth = 1 * devicePixelRatio;
  ctx.stroke();
}

function drawSliceViewportRect(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  sliceViewBounds: { minX: number; minY: number; maxX: number; maxY: number },
  currentZ: number,
  width: number, height: number, depth: number,
  canvasW: number, canvasH: number,
  color: ResolvedColor,
) {
  const nz = currentZ / Math.max(depth - 1, 1);
  // Normalize voxel bounds to unit space (unbounded).
  // Y is flipped: voxel Y=0 is image-top, but unit Y=0 is 3D-bottom (Y-up convention).
  const uMinX = sliceViewBounds.minX / width;
  const uMaxX = sliceViewBounds.maxX / width;
  const uMinY = 1 - sliceViewBounds.maxY / height;
  const uMaxY = 1 - sliceViewBounds.minY / height;

  const corners: [number, number, number][] = [
    [uMinX, uMinY, nz], [uMaxX, uMinY, nz], [uMaxX, uMaxY, nz], [uMinX, uMaxY, nz],
  ];

  const projected = corners.map(([ux, uy, uz]) => {
    const [wx, wy, wz] = transformPoint(modelMatrix, ux, uy, uz);
    return projectToCanvas(viewProj, wx, wy, wz, canvasW, canvasH);
  });

  if (projected.some(p => p === null)) return;
  const pts = projected as [number, number][];

  // Filled rect
  ctx.fillStyle = paint(color, 0.3);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.strokeStyle = paint(color, 0.9);
  ctx.lineWidth = 1.5 * devicePixelRatio;
  ctx.stroke();
}

/**
 * Draw the Z-invariant layer: member bounding boxes, axis arrows (orbit only),
 * and in volume mode the camera frustum. None of it depends on the current
 * Z-plane, so a Z-scrub reuses a cached copy. Clears the target first.
 */
export function drawStaticMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData, colors: MinimapColors): void {
  const { viewProj, layers, datasetLayers, mode, topDown, canvasW, canvasH, mainInvViewProj } = data;

  ctx.clearRect(0, 0, canvasW, canvasH);

  // One bounding box per member, outlining each tile.
  const outline = paint(colors.stroke, MEMBER_OUTLINE_ALPHA);
  for (const layer of layers) {
    drawBoundingBox(ctx, viewProj, layer.modelMatrix, canvasW, canvasH, outline);
  }

  // Axis arrows (once, not per-dataset). Looking straight down Z, the Z arrow
  // collapses to a point and X and Y only repeat the slice view's orientation.
  if (!topDown) drawAxisArrows(ctx, viewProj, canvasW, canvasH, colors);

  if (mode === "volume" && mainInvViewProj) {
    // Frustum intersection (per-dataset)
    for (const dl of datasetLayers) {
      drawFrustumIntersection(
        ctx, viewProj, dl.modelMatrix, dl.invModelMatrix, mainInvViewProj,
        canvasW, canvasH, colors.viewport,
      );
    }
  }
}

/**
 * Draw the per-member slice planes (slice mode only), which depend on Z but not
 * on pan/zoom. Does not clear, so the consumer clears its cache canvas first.
 */
export function drawZPlaneOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData, colors: MinimapColors): void {
  const { viewProj, layers, mode, topDown, canvasW, canvasH, currentZ, datasetDims } = data;

  // Top-down means one plane per member, so a plane marker would only tint
  // every member.
  if (mode === "slice" && !topDown) {
    // One slice plane per member, showing Z within each tile.
    for (const layer of layers) {
      const dims = datasetDims.get(layer.datasetId);
      if (!dims) continue;
      drawSlicePlane(ctx, viewProj, layer.modelMatrix, currentZ, dims.depth, canvasW, canvasH, colors.plane);
    }
  }
}

/**
 * Draw the viewport rectangles (slice mode) and, for the orbit, the orientation
 * cube. Cheap, since it scales with visible viewports rather than member count,
 * so it is re-stroked every callback. Does not clear.
 */
export function drawViewportOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData, colors: MinimapColors): void {
  const { viewProj, sliceViewports, mode, topDown, canvasW, canvasH, currentZ, theta, phi } = data;

  if (mode === "slice") {
    // View rectangle intersections (per-member, in member-local voxel coordinates)
    for (const viewport of sliceViewports) {
      drawSliceViewportRect(
        ctx, viewProj, viewport.modelMatrix, viewport.bounds,
        currentZ, viewport.width, viewport.height, viewport.depth,
        canvasW, canvasH, colors.viewport,
      );
    }
  }

  // Orientation cube (drawn last, on top of everything). A top-down camera
  // doesn't follow the main camera's angles, so the cube would orient nothing.
  if (!topDown) drawOrientationCube(ctx, theta, phi, canvasW, canvasH, colors);
}

/**
 * Whether the Z-plane layer cache must be redrawn. A pan/zoom with unchanged Z
 * reuses it.
 */
export function zPlaneLayerDirty(data: MinimapOverlayData, prevZ: number | null): boolean {
  return data.staticDirty || prevZ === null || data.currentZ !== prevZ;
}

/**
 * Draw the Z-dependent layer over the composited static layer. Does not clear.
 */
export function drawDynamicMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData, colors: MinimapColors): void {
  drawZPlaneOverlays(ctx, data, colors);
  drawViewportOverlays(ctx, data, colors);
}

/** Full redraw onto one context, for callers that don't cache the static layer. */
export function drawMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData, colors: MinimapColors): void {
  drawStaticMinimapOverlays(ctx, data, colors);
  drawDynamicMinimapOverlays(ctx, data, colors);
}
