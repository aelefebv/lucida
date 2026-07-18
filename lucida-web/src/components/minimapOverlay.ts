import type { MinimapOverlayData } from "../renderLoop.ts";
import { transformPoint, projectToCanvas } from "./minimapMath.ts";
import { drawOrientationCube } from "./orientationCube.ts";
import { drawFrustumIntersection } from "./frustumOverlay.ts";

// Bounding box

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

// Axis arrows

function drawAxisArrows(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  canvasW: number, canvasH: number,
) {
  const origin: [number, number, number] = [-0.12, -0.12, -0.12];
  const len = 0.18;
  const axes: { dir: [number, number, number]; color: string; label: string }[] = [
    { dir: [len, 0, 0], color: "#ff4444", label: "X" },
    { dir: [0, len, 0], color: "#44cc44", label: "Y" },
    { dir: [0, 0, len], color: "#4488ff", label: "Z" },
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

// Slice plane (volume mode, shows current Z)

function drawSlicePlane(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  currentZ: number, depth: number,
  canvasW: number, canvasH: number,
  color: string,
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
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.strokeStyle = color.replace(/[\d.]+\)$/, "0.8)");
  ctx.lineWidth = 1 * devicePixelRatio;
  ctx.stroke();
}

// Slice viewport rectangle

function drawSliceViewportRect(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  sliceViewBounds: { minX: number; minY: number; maxX: number; maxY: number },
  currentZ: number,
  width: number, height: number, depth: number,
  canvasW: number, canvasH: number,
  color: string,
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
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.strokeStyle = color.replace(/[\d.]+\)$/, "0.9)");
  ctx.lineWidth = 1.5 * devicePixelRatio;
  ctx.stroke();
}

// Entry points

/**
 * Draw the Z-INVARIANT overlay layer — member bounding boxes, axis arrows, and
 * (in volume mode) the camera frustum. These depend only on the minimap camera
 * and member geometry, never on the current Z-plane, so on a Z-scrub the
 * consumer reuses a cached copy of this layer instead of re-stroking it.
 *
 * Clears the target first, so it owns the full background of whatever surface
 * it draws onto (a dedicated offscreen cache canvas).
 */
export function drawStaticMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData): void {
  const { viewProj, layers, datasetLayers, mode, canvasW, canvasH, mainInvViewProj } = data;

  ctx.clearRect(0, 0, canvasW, canvasH);

  // Bounding boxes (per-member — shows each tile's outline)
  for (const layer of layers) {
    drawBoundingBox(ctx, viewProj, layer.modelMatrix, canvasW, canvasH, "rgba(255,255,255,0.5)");
  }

  // Axis arrows (once, not per-dataset)
  drawAxisArrows(ctx, viewProj, canvasW, canvasH);

  if (mode === "volume" && mainInvViewProj) {
    // Frustum intersection (per-dataset)
    for (const dl of datasetLayers) {
      drawFrustumIntersection(
        ctx, viewProj, dl.modelMatrix, dl.invModelMatrix, mainInvViewProj,
        canvasW, canvasH, "rgba(100,200,255,0.5)",
      );
    }
  }
}

/**
 * Draw the Z-plane sub-layer — the per-member slice planes (slice mode only),
 * which depend on the current Z-plane but not on pan/zoom. Draws NOTHING in
 * volume mode. Does NOT clear: it strokes over whatever surface it targets
 * (a dedicated offscreen cache canvas), so the consumer clears first.
 * Re-stroked only on a Z-scrub or geometry change, not on a pan/zoom.
 */
export function drawZPlaneOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData): void {
  const { viewProj, layers, mode, canvasW, canvasH, currentZ, datasetDims } = data;

  if (mode === "slice") {
    // Slice plane (per-member — shows Z within each tile)
    for (const layer of layers) {
      const dims = datasetDims.get(layer.datasetId);
      if (!dims) continue;
      drawSlicePlane(ctx, viewProj, layer.modelMatrix, currentZ, dims.depth, canvasW, canvasH, "rgba(255,200,50,0.25)");
    }
  }
}

/**
 * Draw the viewport sub-layer — the per-member viewport rectangles (slice mode)
 * or the orientation cube (volume mode, drawn last). These are cheap (bounded
 * by the visible viewports, not the member count) and are re-stroked every
 * overlay callback. Does NOT clear: it strokes over the composited layers.
 */
export function drawViewportOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData): void {
  const { viewProj, sliceViewports, mode, canvasW, canvasH, currentZ, cameraViewRotation } = data;

  if (mode === "slice") {
    // View rectangle intersections (per-member, in member-local voxel coordinates)
    for (const viewport of sliceViewports) {
      drawSliceViewportRect(
        ctx, viewProj, viewport.modelMatrix, viewport.bounds,
        currentZ, viewport.width, viewport.height, viewport.depth,
        canvasW, canvasH, "rgba(100,180,255,0.3)",
      );
    }
  }

  if (mode === "volume") {
    // Orientation is a 3D affordance. The matrix comes from the same
    // authoritative camera pose as rendering, including fly-camera roll.
    drawOrientationCube(ctx, cameraViewRotation, canvasW, canvasH);
  }
}

/**
 * Whether the Z-plane sub-layer cache must be redrawn: on a geometry change
 * (`staticDirty`), the first draw (`prevZ === null`), or a Z-scrub
 * (`currentZ !== prevZ`). A pan/zoom with unchanged Z reuses the cached layer.
 */
export function zPlaneLayerDirty(data: MinimapOverlayData, prevZ: number | null): boolean {
  return data.staticDirty || prevZ === null || data.currentZ !== prevZ;
}

/**
 * Draw the Z-DEPENDENT overlay layer — the per-member slice plane and viewport
 * rectangle (slice mode) — plus the orientation cube, on top of the (already
 * composited) static layer. Does NOT clear: it strokes over the static layer.
 * Re-run every overlay callback, including a pure Z-scrub, because the slice
 * plane / viewport indicators track the current plane.
 */
export function drawDynamicMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData): void {
  drawZPlaneOverlays(ctx, data);
  drawViewportOverlays(ctx, data);
}

/**
 * Full overlay redraw (static layer + dynamic layer) onto a single context, in
 * the original draw order. Retained for callers that don't cache the static
 * layer; the minimap component splits the two so a Z-scrub reuses the cached
 * static layer.
 */
export function drawMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData): void {
  drawStaticMinimapOverlays(ctx, data);
  drawDynamicMinimapOverlays(ctx, data);
}
