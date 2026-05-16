/**
 * Compute a screen-space scissor rect for a well's `[0,1]^3` unit cube.
 *
 * Project all 8 corners through `model` then `viewProj`, take the
 * 2D AABB, clamp to the canvas, and return integer `[x, y, w, h]`.
 *
 * Returns `[0, 0, canvasW, canvasH]` (conservative full-canvas) when any
 * corner has `clipW <= 0` (behind camera); returns `null` when the
 * clamped rect is degenerate (fully off-screen).
 *
 * Pure function. WebGPU convention: top-left origin, y-down.
 *
 * Lives next to the other cold-state / upload builders so the
 * render-path file stays focused on render orchestration.
 */
export function computeScissorRect(
  modelMatrix: Float32Array,
  viewProj: Float32Array,
  canvasW: number,
  canvasH: number,
): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < 8; i++) {
    const cx = i & 1;
    const cy = (i >> 1) & 1;
    const cz = (i >> 2) & 1;

    // Model transform (column-major): local [0,1]³ → world
    const wx = modelMatrix[0] * cx + modelMatrix[4] * cy + modelMatrix[8] * cz + modelMatrix[12];
    const wy = modelMatrix[1] * cx + modelMatrix[5] * cy + modelMatrix[9] * cz + modelMatrix[13];
    const wz = modelMatrix[2] * cx + modelMatrix[6] * cy + modelMatrix[10] * cz + modelMatrix[14];
    const ww = modelMatrix[3] * cx + modelMatrix[7] * cy + modelMatrix[11] * cz + modelMatrix[15];

    // ViewProj transform: world → clip
    const clipX = viewProj[0] * wx + viewProj[4] * wy + viewProj[8] * wz + viewProj[12] * ww;
    const clipY = viewProj[1] * wx + viewProj[5] * wy + viewProj[9] * wz + viewProj[13] * ww;
    const clipW = viewProj[3] * wx + viewProj[7] * wy + viewProj[11] * wz + viewProj[15] * ww;

    if (clipW <= 0) {
      // Vertex behind camera — conservative fallback to full screen
      return [0, 0, canvasW, canvasH];
    }

    // NDC [-1,1] → screen (WebGPU: top-left origin, y-down)
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const sx = (ndcX + 1) * 0.5 * canvasW;
    const sy = (1 - ndcY) * 0.5 * canvasH;

    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }

  // Clamp to canvas bounds and compute integer rect
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const w = Math.min(canvasW, Math.ceil(maxX)) - x;
  const h = Math.min(canvasH, Math.ceil(maxY)) - y;

  if (w <= 0 || h <= 0) return null; // fully off-screen
  return [x, y, w, h];
}
