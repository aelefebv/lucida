import type { Vec3 } from "./minimapMath.ts";
import { mulMat4, mulMat4Vec4, transformPoint, projectToCanvas } from "./minimapMath.ts";

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

export function drawFrustumIntersection(
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
