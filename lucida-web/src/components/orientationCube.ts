import { mixColor, paint } from "../theme/tokenColors.ts";
import type { ResolvedColor } from "../theme/tokens.ts";

type Vec3 = [number, number, number];

/** What the cube is drawn in: canvas tokens, so it reads on any canvas background. */
export interface CubeColors {
  background: ResolvedColor;
  label: ResolvedColor;
  axisX: ResolvedColor;
  axisY: ResolvedColor;
  axisZ: ResolvedColor;
}

type Axis = "axisX" | "axisY" | "axisZ";

/** How far a receding face's color sinks toward the background. */
const RECEDING_MIX = 0.35;

const ORIENT_VERTS: Vec3[] = [
  [-1, -1, -1], [ 1, -1, -1], [ 1,  1, -1], [-1,  1, -1],
  [-1, -1,  1], [ 1, -1,  1], [ 1,  1,  1], [-1,  1,  1],
];

// Each axis colors two opposite faces, one in its own color and one in a
// receding shade of it.
const ORIENT_FACES: { indices: number[]; normal: Vec3; label: string; axis: Axis; receding: boolean }[] = [
  { indices: [1, 2, 6, 5], normal: [ 1,  0,  0], label: "R", axis: "axisX", receding: false },
  { indices: [0, 3, 7, 4], normal: [-1,  0,  0], label: "L", axis: "axisX", receding: true },
  { indices: [2, 3, 7, 6], normal: [ 0,  1,  0], label: "B", axis: "axisY", receding: true },
  { indices: [0, 1, 5, 4], normal: [ 0, -1,  0], label: "T", axis: "axisY", receding: false },
  { indices: [4, 5, 6, 7], normal: [ 0,  0,  1], label: "F", axis: "axisZ", receding: false },
  { indices: [0, 1, 2, 3], normal: [ 0,  0, -1], label: "K", axis: "axisZ", receding: true },
];

function buildViewRotation(theta: number, phi: number): number[] {
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const st = Math.sin(theta), ct = Math.cos(theta);

  // Eye direction (z axis)
  const zx = sp * st, zy = cp, zz = sp * ct;

  // Up vector
  const upx = -cp * st, upy = sp, upz = -cp * ct;

  // x = normalize(cross(up, z))
  let xx = upy * zz - upz * zy;
  let xy = upz * zx - upx * zz;
  let xz = upx * zy - upy * zx;
  const xLen = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (xLen > 1e-10) { xx /= xLen; xy /= xLen; xz /= xLen; }
  else { xx = 1; xy = 0; xz = 0; }

  // y = cross(z, x)
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return [xx, xy, xz, yx, yy, yz, zx, zy, zz];
}

export function drawOrientationCube(
  ctx: CanvasRenderingContext2D,
  theta: number, phi: number,
  canvasW: number, canvasH: number,
  colors: CubeColors,
) {
  const dpr = devicePixelRatio;
  const margin = 8 * dpr;
  const halfSize = 30 * dpr;

  if (canvasW < 80 || canvasH < 80) return;

  const cx = canvasW - margin - halfSize;
  const cy = canvasH - margin - halfSize;

  // A disc of the canvas background sets the cube off from the data behind it.
  ctx.fillStyle = paint(colors.background, 0.35);
  ctx.beginPath();
  ctx.arc(cx, cy, halfSize + 4 * dpr, 0, Math.PI * 2);
  ctx.fill();

  // Rotate vertices and normals
  const rot = buildViewRotation(theta, -phi);
  const [rxx, rxy, rxz, ryx, ryy, ryz, rzx, rzy, rzz] = rot;

  const rotatedVerts = ORIENT_VERTS.map(([vx, vy, vz]) => [
    rxx * vx + rxy * vy + rxz * vz,
    ryx * vx + ryy * vy + ryz * vz,
    rzx * vx + rzy * vy + rzz * vz,
  ] as Vec3);

  const faceData = ORIENT_FACES.map((face) => {
    const [nx, ny, nz] = face.normal;
    const rnz = rzx * nx + rzy * ny + rzz * nz;
    let avgZ = 0;
    for (const idx of face.indices) avgZ += rotatedVerts[idx][2];
    avgZ /= 4;
    return { ...face, rnz, avgZ };
  });

  // Sort back-to-front (farthest z first)
  faceData.sort((a, b) => b.avgZ - a.avgZ);

  const scale = halfSize * 0.55;
  const fontSize = Math.round(9 * dpr);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const face of faceData) {
    const pts = face.indices.map(i => [
      cx + rotatedVerts[i][0] * scale,
      cy - rotatedVerts[i][1] * scale,
    ]);

    const isFront = face.rnz < 0;
    const alpha = isFront ? 0.7 : 0.1;
    const axisColor = colors[face.axis];
    const color = face.receding ? mixColor(axisColor, colors.background, RECEDING_MIX) : axisColor;

    // Fill quad
    ctx.fillStyle = paint(color, alpha);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();

    // Stroke edges
    ctx.strokeStyle = paint(color);
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();

    // Label front-facing faces (skip nearly edge-on)
    if (isFront && face.rnz < -0.15) {
      let lcx = 0, lcy = 0;
      for (const p of pts) { lcx += p[0]; lcy += p[1]; }
      lcx /= pts.length; lcy /= pts.length;

      ctx.strokeStyle = paint(colors.background, 0.7);
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeText(face.label, lcx, lcy);
      ctx.fillStyle = paint(colors.label);
      ctx.fillText(face.label, lcx, lcy);
    }
  }
}
