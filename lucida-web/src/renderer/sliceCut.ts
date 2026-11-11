/**
 * A slice view's cut of a dataset its placement tilts off the cut, which the
 * view samples from the dataset's bricks (`SliceLayerParams.bricks`).
 */
import type { SliceRenderMultiPassMessage } from "./workerProtocol.ts";

type CutCamera = Pick<SliceRenderMultiPassMessage, "zoom" | "cx" | "cy" | "canvasW" | "canvasH">;

/**
 * The column-major map from the target's NDC to the world point of the
 * view's cut there: NDC to the view's plane under the camera, then
 * `planeToWorld`.
 */
export function cutNdcToWorld(camera: CutCamera, planeToWorld: readonly number[]): Float32Array {
  // NDC y points up the target, and the plane's down axis down it.
  const halfW = camera.canvasW / (2 * camera.zoom);
  const halfH = camera.canvasH / (2 * camera.zoom);
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    out[r] = planeToWorld[r] * halfW;
    out[4 + r] = -planeToWorld[4 + r] * halfH;
    out[12 + r] = planeToWorld[r] * camera.cx + planeToWorld[4 + r] * camera.cy + planeToWorld[12 + r];
  }
  return out;
}

/**
 * `planeToWorld` with the plane's two axes swapped, for a view that draws its
 * plane transposed: the plane's down axis across the target.
 */
export function transposePlaneToWorld(planeToWorld: readonly number[]): number[] {
  return [...planeToWorld.slice(4, 8), ...planeToWorld.slice(0, 4), ...planeToWorld.slice(8)];
}

/**
 * The member-local point, in its `[0, 1]` cube, of the cut at target point
 * `(px, py)`, through the member's world-to-local `invModel`; null where the
 * cut misses the member.
 */
export function cutLocalAt(
  camera: CutCamera,
  planeToWorld: readonly number[],
  invModel: ArrayLike<number>,
  px: number,
  py: number,
): [number, number, number] | null {
  const m = cutNdcToWorld(camera, planeToWorld);
  const [x, y] = [(px / camera.canvasW) * 2 - 1, 1 - (py / camera.canvasH) * 2];
  const world = [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[12 + r]);
  const local = [0, 1, 2].map((r) =>
    (invModel[r] * world[0] + invModel[4 + r] * world[1] + invModel[8 + r] * world[2] + invModel[12 + r] * world[3]) /
      world[3]) as [number, number, number];
  return local.every((v) => v >= 0 && v <= 1) ? local : null;
}
