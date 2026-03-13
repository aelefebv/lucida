export type Vec3 = [number, number, number];

export function mulMat4Vec4(m: Float32Array, x: number, y: number, z: number, w: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8]  * z + m[12] * w,
    m[1] * x + m[5] * y + m[9]  * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

export function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
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

export function projectToCanvas(
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

export function transformPoint(m: Float32Array, ux: number, uy: number, uz: number): [number, number, number] {
  const [x, y, z, w] = mulMat4Vec4(m, ux, uy, uz, 1);
  return [x / w, y / w, z / w];
}
