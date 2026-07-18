type Vec3 = [number, number, number];

const ORIENT_VERTS: Vec3[] = [
  [-1, -1, -1], [ 1, -1, -1], [ 1,  1, -1], [-1,  1, -1],
  [-1, -1,  1], [ 1, -1,  1], [ 1,  1,  1], [-1,  1,  1],
];

const ORIENT_FACES: { indices: number[]; normal: Vec3; label: string; color: string }[] = [
  { indices: [1, 2, 6, 5], normal: [ 1,  0,  0], label: "R", color: "rgba(255,68,68,"  },  // +X red
  { indices: [0, 3, 7, 4], normal: [-1,  0,  0], label: "L", color: "rgba(170,40,40,"  },  // -X dim red
  { indices: [2, 3, 7, 6], normal: [ 0,  1,  0], label: "B", color: "rgba(40,140,40,"  },  // +Y dim green
  { indices: [0, 1, 5, 4], normal: [ 0, -1,  0], label: "T", color: "rgba(68,204,68,"  },  // -Y green
  { indices: [4, 5, 6, 7], normal: [ 0,  0,  1], label: "F", color: "rgba(68,136,255," },  // +Z blue
  { indices: [0, 1, 2, 3], normal: [ 0,  0, -1], label: "K", color: "rgba(40,80,170,"  },  // -Z dim blue
];

export function drawOrientationCube(
  ctx: CanvasRenderingContext2D,
  viewRotation: Float32Array,
  canvasW: number, canvasH: number,
) {
  const dpr = devicePixelRatio;
  const margin = 8 * dpr;
  const halfSize = 30 * dpr;

  if (canvasW < 80 || canvasH < 80) return;

  const cx = canvasW - margin - halfSize;
  const cy = canvasH - margin - halfSize;

  // Background circle
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.arc(cx, cy, halfSize + 4 * dpr, 0, Math.PI * 2);
  ctx.fill();

  // Rotate vertices and normals
  const [rxx, rxy, rxz, ryx, ryy, ryz, rzx, rzy, rzz] = viewRotation;

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

    // Fill quad
    ctx.fillStyle = face.color + alpha + ")";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();

    // Stroke edges
    ctx.strokeStyle = face.color + "1)";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();

    // Label front-facing faces (skip nearly edge-on)
    if (isFront && face.rnz < -0.15) {
      let lcx = 0, lcy = 0;
      for (const p of pts) { lcx += p[0]; lcy += p[1]; }
      lcx /= pts.length; lcy /= pts.length;

      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeText(face.label, lcx, lcy);
      ctx.fillStyle = "white";
      ctx.fillText(face.label, lcx, lcy);
    }
  }
}
