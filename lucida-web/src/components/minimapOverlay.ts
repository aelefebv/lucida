import type { MinimapOverlayData } from "../renderLoop.ts";

// --- Linear algebra helpers (column-major 4x4) ---

function mulMat4Vec4(m: Float32Array, x: number, y: number, z: number, w: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8]  * z + m[12] * w,
    m[1] * x + m[5] * y + m[9]  * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row]      * b[col * 4]     +
        a[4 + row]  * b[col * 4 + 1] +
        a[8 + row]  * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function projectToCanvas(
  viewProj: Float32Array, wx: number, wy: number, wz: number,
  canvasW: number, canvasH: number,
): [number, number] | null {
  const [cx, cy, _cz, cw] = mulMat4Vec4(viewProj, wx, wy, wz, 1);
  if (cw <= 0) return null;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  const px = (ndcX * 0.5 + 0.5) * canvasW;
  const py = (1 - (ndcY * 0.5 + 0.5)) * canvasH;
  return [px, py];
}

function transformPoint(m: Float32Array, ux: number, uy: number, uz: number): [number, number, number] {
  const [x, y, z, w] = mulMat4Vec4(m, ux, uy, uz, 1);
  return [x / w, y / w, z / w];
}

// --- Bounding box ---

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

// --- Axis arrows ---

function drawAxisArrows(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  canvasW: number, canvasH: number,
) {
  const origin: [number, number, number] = [0.12, 0.12, 0.12];
  const len = 0.16;
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

// --- Slice plane (volume mode, shows current Z) ---

function drawSlicePlane(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  currentZ: number, depth: number,
  canvasW: number, canvasH: number,
  color: string,
) {
  const nz = currentZ / Math.max(depth - 1, 1);
  const corners: [number, number, number][] = [
    [0, 0, nz], [1, 0, nz], [1, 1, nz], [0, 1, nz],
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

// --- Slice viewport rectangle ---

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
  // Normalize voxel bounds to [0,1] unit space, clamped.
  // Y is flipped: voxel Y=0 is image-top, but unit Y=0 is 3D-bottom (Y-up convention).
  const uMinX = Math.max(0, Math.min(1, sliceViewBounds.minX / width));
  const uMaxX = Math.max(0, Math.min(1, sliceViewBounds.maxX / width));
  const uMinY = Math.max(0, Math.min(1, 1 - sliceViewBounds.maxY / height));
  const uMaxY = Math.max(0, Math.min(1, 1 - sliceViewBounds.minY / height));

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

// --- Frustum intersection (3D mode) ---

type Vec3 = [number, number, number];

function clipPolygonByPlane(
  polygon: Vec3[], a: number, b: number, c: number, d: number,
): { clipped: Vec3[]; enterPoints: Vec3[] } {
  const clipped: Vec3[] = [];
  const enterPoints: Vec3[] = [];
  const n = polygon.length;
  if (n === 0) return { clipped, enterPoints };

  for (let i = 0; i < n; i++) {
    const cur = polygon[i];
    const next = polygon[(i + 1) % n];
    const dCur = a * cur[0] + b * cur[1] + c * cur[2] + d;
    const dNext = a * next[0] + b * next[1] + c * next[2] + d;

    if (dCur >= 0) {
      clipped.push(cur);
      if (dNext < 0) {
        // Exiting
        const t = dCur / (dCur - dNext);
        const inter: Vec3 = [
          cur[0] + t * (next[0] - cur[0]),
          cur[1] + t * (next[1] - cur[1]),
          cur[2] + t * (next[2] - cur[2]),
        ];
        clipped.push(inter);
      }
    } else {
      if (dNext >= 0) {
        // Entering
        const t = dCur / (dCur - dNext);
        const inter: Vec3 = [
          cur[0] + t * (next[0] - cur[0]),
          cur[1] + t * (next[1] - cur[1]),
          cur[2] + t * (next[2] - cur[2]),
        ];
        clipped.push(inter);
        enterPoints.push(inter);
      }
    }
  }
  return { clipped, enterPoints };
}

function orderCoplanarPoints(points: Vec3[], nx: number, ny: number, nz: number): Vec3[] {
  if (points.length <= 2) return points;

  // Centroid
  let cx = 0, cy = 0, cz = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= points.length; cy /= points.length; cz /= points.length;

  // Build orthonormal basis on the plane
  const abs_nx = Math.abs(nx), abs_ny = Math.abs(ny), abs_nz = Math.abs(nz);
  let refUp: Vec3;
  if (abs_nx <= abs_ny && abs_nx <= abs_nz) refUp = [1, 0, 0];
  else if (abs_ny <= abs_nz) refUp = [0, 1, 0];
  else refUp = [0, 0, 1];

  // u = normalize(refUp - dot(refUp,n)*n)
  const dot = refUp[0] * nx + refUp[1] * ny + refUp[2] * nz;
  let ux = refUp[0] - dot * nx, uy = refUp[1] - dot * ny, uz = refUp[2] - dot * nz;
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (uLen < 1e-10) return points;
  ux /= uLen; uy /= uLen; uz /= uLen;

  // v = cross(n, u)
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  return [...points].sort((a, b) => {
    const aU = (a[0] - cx) * ux + (a[1] - cy) * uy + (a[2] - cz) * uz;
    const aV = (a[0] - cx) * vx + (a[1] - cy) * vy + (a[2] - cz) * vz;
    const bU = (b[0] - cx) * ux + (b[1] - cy) * uy + (b[2] - cz) * uz;
    const bV = (b[0] - cx) * vx + (b[1] - cy) * vy + (b[2] - cz) * vz;
    return Math.atan2(aV, aU) - Math.atan2(bV, bU);
  });
}

function deduplicateVec3(points: Vec3[], eps: number): Vec3[] {
  const result: Vec3[] = [];
  for (const p of points) {
    if (!result.some(q =>
      Math.abs(p[0] - q[0]) < eps &&
      Math.abs(p[1] - q[1]) < eps &&
      Math.abs(p[2] - q[2]) < eps
    )) {
      result.push(p);
    }
  }
  return result;
}

function clipPolyhedronByPlane(
  faces: Vec3[][], a: number, b: number, c: number, d: number,
): Vec3[][] {
  const newFaces: Vec3[][] = [];
  let allCapPoints: Vec3[] = [];

  for (const face of faces) {
    const { clipped, enterPoints } = clipPolygonByPlane(face, a, b, c, d);
    if (clipped.length >= 3) newFaces.push(clipped);
    allCapPoints.push(...enterPoints);
  }

  // Build cap face from intersection points on the clip plane
  if (allCapPoints.length >= 3) {
    allCapPoints = deduplicateVec3(allCapPoints, 1e-6);
    if (allCapPoints.length >= 3) {
      const capFace = orderCoplanarPoints(allCapPoints, a, b, c);
      newFaces.push(capFace);
    }
  }

  return newFaces;
}

// Frustum face indices: given 8 corners indexed as in NDC order
// near (z=-1): 0,1,3,2  far (z=+1): 4,5,7,6
// left (x=-1): 0,2,6,4  right (x=+1): 1,3,7,5
// bottom (y=-1): 0,1,5,4 top (y=+1): 2,3,7,6
const FRUSTUM_FACES: number[][] = [
  [0, 1, 3, 2], // near
  [5, 4, 6, 7], // far
  [0, 4, 6, 2], // left
  [1, 5, 7, 3], // right
  [0, 1, 5, 4], // bottom
  [2, 3, 7, 6], // top
];

function drawFrustumIntersection(
  ctx: CanvasRenderingContext2D,
  viewProj: Float32Array,
  modelMatrix: Float32Array,
  invModelMatrix: Float32Array,
  mainInvViewProj: Float32Array,
  canvasW: number, canvasH: number,
  color: string,
) {
  // 1. Unproject 8 NDC corners through mainInvViewProj to world, then invModelMatrix to unit space
  const ndcCorners: Vec3[] = [
    [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
    [-1, -1,  1], [1, -1,  1], [-1, 1,  1], [1, 1,  1],
  ];

  // Combined: invModelMatrix * mainInvViewProj
  const combined = mulMat4(invModelMatrix, mainInvViewProj);

  const unitCorners: Vec3[] = ndcCorners.map(([nx, ny, nz]) => {
    const [x, y, z, w] = mulMat4Vec4(combined, nx, ny, nz, 1);
    return [x / w, y / w, z / w] as Vec3;
  });

  // 2. Build frustum face polygons in unit space
  let faces: Vec3[][] = FRUSTUM_FACES.map(indices => indices.map(i => unitCorners[i]));

  // 3. Clip against 6 unit-cube half-spaces
  const clipPlanes: [number, number, number, number][] = [
    [ 1,  0,  0,  0], // x >= 0
    [-1,  0,  0,  1], // x <= 1
    [ 0,  1,  0,  0], // y >= 0
    [ 0, -1,  0,  1], // y <= 1
    [ 0,  0,  1,  0], // z >= 0
    [ 0,  0, -1,  1], // z <= 1
  ];

  for (const [pa, pb, pc, pd] of clipPlanes) {
    faces = clipPolyhedronByPlane(faces, pa, pb, pc, pd);
    if (faces.length === 0) return;
  }

  // 4. Extract edges from surviving faces, transform back to world, project
  const edges: [Vec3, Vec3][] = [];
  for (const face of faces) {
    for (let i = 0; i < face.length; i++) {
      edges.push([face[i], face[(i + 1) % face.length]]);
    }
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * devicePixelRatio;
  ctx.beginPath();

  for (const [a, b] of edges) {
    const wa = transformPoint(modelMatrix, ...a);
    const wb = transformPoint(modelMatrix, ...b);
    const pa = projectToCanvas(viewProj, ...wa, canvasW, canvasH);
    const pb = projectToCanvas(viewProj, ...wb, canvasW, canvasH);
    if (!pa || !pb) continue;
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
  }
  ctx.stroke();

  // Draw filled faces with semi-transparent fill
  const fillColor = color.replace(/[\d.]+\)$/, "0.08)");
  ctx.fillStyle = fillColor;
  for (const face of faces) {
    const projFace = face.map(v => {
      const w = transformPoint(modelMatrix, ...v);
      return projectToCanvas(viewProj, ...w, canvasW, canvasH);
    });
    if (projFace.some(p => p === null)) continue;
    const pts = projFace as [number, number][];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  }
}

// --- Entry point ---

export function drawMinimapOverlays(ctx: CanvasRenderingContext2D, data: MinimapOverlayData): void {
  const { viewProj, layers, mode, canvasW, canvasH, currentZ, datasetDims, sliceViewBounds, mainInvViewProj } = data;

  ctx.clearRect(0, 0, canvasW, canvasH);

  // Bounding boxes
  for (const layer of layers) {
    drawBoundingBox(ctx, viewProj, layer.modelMatrix, canvasW, canvasH, "rgba(255,255,255,0.5)");
  }

  // Axis arrows (once, not per-dataset)
  drawAxisArrows(ctx, viewProj, canvasW, canvasH);

  if (mode === "slice" && sliceViewBounds) {
    for (const layer of layers) {
      const dims = datasetDims.get(layer.datasetId);
      if (!dims) continue;

      drawSlicePlane(ctx, viewProj, layer.modelMatrix, currentZ, dims.depth, canvasW, canvasH, "rgba(255,200,50,0.25)");
      drawSliceViewportRect(
        ctx, viewProj, layer.modelMatrix, sliceViewBounds,
        currentZ, dims.width, dims.height, dims.depth,
        canvasW, canvasH, "rgba(100,180,255,0.3)",
      );
    }
  }

  if (mode === "volume" && mainInvViewProj) {
    for (const layer of layers) {
      drawFrustumIntersection(
        ctx, viewProj, layer.modelMatrix, layer.invModelMatrix, mainInvViewProj,
        canvasW, canvasH, "rgba(100,200,255,0.5)",
      );
    }
  }
}
