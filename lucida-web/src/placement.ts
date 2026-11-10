/**
 * Where a dataset's frame sits in the scene frame the slice camera views. A
 * dataset's frame is its level-0 samples, with a collection's members at their
 * layout positions; lucida-core places it by the dataset's declared scale,
 * origin and units. The web only applies a placement, never derives one.
 */
import type { WasmScene } from "lucida-core";

/** A frame point `p` lands at `offset + p * scale` in the scene frame. */
export interface Placement {
  offset: readonly [number, number, number];
  scale: readonly [number, number, number];
}

export const IDENTITY_PLACEMENT: Placement = { offset: [0, 0, 0], scale: [1, 1, 1] };

/** `datasetId`'s placement, or the identity for a dataset the scene doesn't hold. */
export function readPlacement(
  scene: Pick<WasmScene, "dataset_placement">,
  datasetId: string,
): Placement {
  const v = scene.dataset_placement(datasetId);
  if (v.length < 6) return IDENTITY_PLACEMENT;
  return { offset: [v[0], v[1], v[2]], scale: [v[3], v[4], v[5]] };
}

/** A frame point in the scene frame. */
export function frameToScene(p: Placement, point: readonly [number, number]): [number, number] {
  return [p.offset[0] + point[0] * p.scale[0], p.offset[1] + point[1] * p.scale[1]];
}

/** A scene-frame point in the dataset's frame. */
export function sceneToFrame(p: Placement, point: readonly [number, number]): [number, number] {
  return [(point[0] - p.offset[0]) / p.scale[0], (point[1] - p.offset[1]) / p.scale[1]];
}

/** A frame rect at `x, y` spanning `w × h`, in the scene frame. */
export function rectToScene(
  p: Placement,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const [sx, sy] = frameToScene(p, [x, y]);
  return { x: sx, y: sy, w: w * p.scale[0], h: h * p.scale[1] };
}
